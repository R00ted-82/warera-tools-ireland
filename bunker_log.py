#!/usr/bin/env python3
"""
bunker_log.py

Region event logger for the bunker monitor tool (lives under the BEER tab on
tools.we-ie.com, alongside other alliance-block tools added over time).

Polls every 2h via GitHub Actions cron, takes one bulk snapshot of every region
in the game, diffs it against the previous snapshot, and appends whatever
changed to a rolling 30-day event log. For bunkers that are pending or disabled
it also fetches the per-region upgrade endpoint to capture the scheduled
activation time (willBeActiveAt), which the search page renders in each
viewer's own timezone. No Discord, no country filter: every region is logged so
any of them, and any country, is searchable later.

This is independent of warera-bunker-notifications-discord. That bot alerts;
this one remembers.

Run:
  python bunker_log.py

Output files (committed back by the workflow):
  data/state.json   current per-region snapshot, diffed against on next run
  data/events.json  rolling list of events, anything older than 30 days dropped

Event types logged:
  came_online        bunker started running            (extra: to)
  went_offline       bunker stopped running            (extra: from)
  level_changed      running level changed             (extra: from, to)
  built              bunker entry appeared             (extra: level)
  destroyed          bunker entry disappeared          (extra: level)
  status_changed     built_status flipped              (extra: from, to)
                       active / disabled / pending
  bunker_activating  a future activation time appeared (extra: active_at, level)
                       active_at is a UTC ISO string; the page localizes it
  ownership_changed  controlling country changed       (extra: from, to)
  battle_started     a battle began on this region
  battle_ended       the active battle finished
  resistance_full    occupied region's bar hit max     (extra: val, max)

NOTE ON OWNERSHIP FIELDS (same as the notification bot):
  region.countryCode    = CORE / original owner's code (never changes)
  region.initialCountry = CORE owner's id (matches countryCode)
  region.country        = CURRENT controller's id (changes on conquest)
  The current controller's CODE is resolved by looking up `country` in a map
  built from initialCountry -> countryCode (build_country_id_to_code).

NOTE ON ACTIVATION TIME:
  The bulk region object does NOT carry willBeActiveAt. Only the dedicated
  upgrade.getUpgradeByTypeAndEntity endpoint does. Active bunkers already came
  online, so their timestamp is in the past and worthless here; we only query
  the endpoint for bunkers whose bulk status is pending or disabled, and only
  store or log the timestamp when it is in the FUTURE.

NOTE ON RESISTANCE:
  resistance only climbs while a region is OCCUPIED; owner-held regions decay.
  A full bar means a liberation battle can start, so resistance_full only fires
  for occupied regions. resistanceMax creeps up with development, so a region
  pinned at the cap can briefly read just under it; a hysteresis flag
  (`alerted`, persisted in state.json) suppresses re-fires until resistance
  drops back below 90% of max.
"""

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Config
PROXY_BASE     = "https://warera-proxy.toie.workers.dev/trpc"
DATA_DIR       = Path(__file__).parent / "data"
STATE_FILE     = DATA_DIR / "state.json"
EVENTS_FILE    = DATA_DIR / "events.json"
HTTP_TIMEOUT   = 30
MAX_RETRIES    = 3
RETRY_BACKOFF  = 5     # seconds, multiplied by attempt number
USER_AGENT     = "warera-bunker-log/1.0"
RETENTION_DAYS = 30

# Per-region upgrade fetch. Only bunkers in these bulk statuses are queried for
# willBeActiveAt; active ones already came online (timestamp is in the past).
UPGRADE_FETCH_STATUSES = {"pending", "disabled"}
UPGRADE_PAUSE          = 0.25   # seconds between per-region upgrade calls
MAX_UPGRADE_CALLS      = 600    # hard cap so a bad run can never fan out forever

# Fraction of resistanceMax that resistance must fall back below before a
# region that already logged resistance_full can log it again.
RESISTANCE_REARM_RATIO = 0.9


def log(msg):
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


def http_get_json(url):
    last_err = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
                return json.loads(r.read().decode("utf-8"))
        except (urllib.error.URLError, urllib.error.HTTPError,
                json.JSONDecodeError, TimeoutError) as e:
            last_err = e
            log(f"GET failed (attempt {attempt}/{MAX_RETRIES}): {e}")
            if attempt < MAX_RETRIES:
                time.sleep(RETRY_BACKOFF * attempt)
    raise RuntimeError(f"GET {url} failed after {MAX_RETRIES} attempts: {last_err}")


def parse_iso(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return None


def origin_country_code(region_code):
    """e.g. 'fi-south' -> 'fi'. Empty string when no prefix."""
    if not region_code or "-" not in region_code:
        return ""
    return region_code.split("-", 1)[0].lower()


# API + snapshot

def fetch_all_regions():
    body = http_get_json(f"{PROXY_BASE}/region.getRegionsObject")
    data = body.get("result", {}).get("data", {})
    if not isinstance(data, dict):
        raise RuntimeError(f"region.getRegionsObject returned unexpected shape: {type(data)}")
    log(f"fetched {len(data)} regions")
    return data


def fetch_bunker_upgrade(region_id):
    """
    Per-region bunker upgrade detail. The only place willBeActiveAt is exposed.
    Best-effort: returns the upgrade dict or None on any failure (never raises).
    """
    payload = json.dumps(
        {"upgradeType": "bunker", "regionId": region_id},
        separators=(",", ":"),
    )
    url = f"{PROXY_BASE}/upgrade.getUpgradeByTypeAndEntity?input={urllib.parse.quote(payload)}"
    try:
        body = http_get_json(url)
    except Exception as e:
        log(f"upgrade fetch failed for {region_id} (non-fatal): {e}")
        return None
    data = (body or {}).get("result", {}).get("data")
    return data if isinstance(data, dict) else None


def extract_bunker_state(region):
    active = region.get("activeUpgradeLevels") or {}
    running_level = active.get("bunker")
    if not isinstance(running_level, int):
        running_level = None

    upgrades = ((region.get("upgradesV2") or {}).get("upgrades") or {})
    bunker = upgrades.get("bunker")
    if isinstance(bunker, dict):
        built_status = bunker.get("status")
        built_level  = bunker.get("level")
        if not isinstance(built_level, int):
            built_level = None
        is_under_construction = bool(bunker.get("isUnderConstruction"))
    else:
        built_status = None
        built_level  = None
        is_under_construction = False

    return {
        "running_level":         running_level,
        "built_status":          built_status,
        "built_level":           built_level,
        "is_under_construction": is_under_construction,
    }


def extract_resistance_state(region):
    val = region.get("resistance")
    mx  = region.get("resistanceMax")
    return {
        "value":   val if isinstance(val, (int, float)) else None,
        "max":     mx if isinstance(mx, (int, float)) else None,
        "alerted": False,
    }


def extract_active_battle_id(region):
    ab = region.get("activeBattle")
    if isinstance(ab, dict):
        return ab.get("_id")
    if isinstance(ab, str) and ab:
        return ab
    return None


def build_country_id_to_code(regions):
    """{country_id: country_code} derived from CORE ownership."""
    out = {}
    for region in regions.values():
        if not isinstance(region, dict):
            continue
        core_id   = region.get("initialCountry")
        core_code = region.get("countryCode")
        if core_id and core_code:
            out[core_id] = core_code.lower()
    return out


def build_current_state(regions, id_to_code):
    now = datetime.now(timezone.utc).isoformat()
    out = {}
    for rid, region in regions.items():
        if not isinstance(region, dict):
            continue
        country_id  = region.get("country")
        core_code   = (region.get("countryCode") or "").lower() or None
        controller  = id_to_code.get(country_id) or core_code
        out[rid] = {
            "name":                 region.get("name"),
            "code":                 region.get("code"),
            "is_capital":           bool(region.get("isCapital")),
            "main_city":            region.get("mainCity"),
            "country_code":         controller,
            "country_id":           country_id,
            "initial_country_id":   region.get("initialCountry"),
            "initial_country_code": core_code,
            "active_battle_id":     extract_active_battle_id(region),
            "bunker":               extract_bunker_state(region),
            "resistance":           extract_resistance_state(region),
            "observed_at":          now,
        }
    return out


def enrich_with_upgrades(current):
    """
    For bunkers in UPGRADE_FETCH_STATUSES, fetch the upgrade record and attach
    {status, will_be_active_at, level} as current[rid]["bunker_upgrade"].
    Active bunkers are skipped (their activation time is already in the past).
    """
    targets = [
        rid for rid, st in current.items()
        if (st.get("bunker") or {}).get("built_status") in UPGRADE_FETCH_STATUSES
    ]
    if not targets:
        return
    if len(targets) > MAX_UPGRADE_CALLS:
        log(f"capping upgrade fetch at {MAX_UPGRADE_CALLS} of {len(targets)} candidates")
        targets = targets[:MAX_UPGRADE_CALLS]

    log(f"fetching upgrade detail for {len(targets)} pending/disabled bunker(s)")
    for i, rid in enumerate(targets):
        up = fetch_bunker_upgrade(rid)
        if isinstance(up, dict):
            current[rid]["bunker_upgrade"] = {
                "status":            up.get("status"),
                "will_be_active_at": up.get("willBeActiveAt"),
                "level":             up.get("level"),
            }
        if i < len(targets) - 1:
            time.sleep(UPGRADE_PAUSE)


# Transition detection -> log records

def _rec(at, kind, rid, c, **extra):
    r = {
        "at":   at,
        "type": kind,
        "rid":  rid,
        "code": c.get("code"),
        "name": c.get("name"),
        "cc":   c.get("country_code"),               # current controller
        "occ":  origin_country_code(c.get("code")),  # core owner
    }
    r.update(extra)
    return r


def detect_events(prev, curr, now):
    """
    Emit one or more event records per changed region. Bunker presence/level
    changes are exclusive within a region; ownership, status, activation,
    battle, and resistance fire independently and can co-occur.

    Side effect: writes the resistance `alerted` hysteresis flag back onto
    curr so it persists into the next saved state. Must run before state save.
    """
    now_iso = now.isoformat()
    events = []

    for rid in set(prev.keys()) | set(curr.keys()):
        p = prev.get(rid)
        c = curr.get(rid)
        if p is None or c is None:
            continue  # first observation or vanished region

        # Ownership flip (current controllers)
        p_cc = p.get("country_code")
        c_cc = c.get("country_code")
        if p_cc and c_cc and p_cc != c_cc:
            events.append(_rec(now_iso, "ownership_changed", rid, c,
                               **{"from": p_cc, "to": c_cc}))

        p_b = p.get("bunker") or {}
        c_b = c.get("bunker") or {}
        p_has = p_b.get("built_status") is not None
        c_has = c_b.get("built_status") is not None

        # Bunker presence (exclusive arm: built XOR destroyed XOR run-level)
        if not p_has and c_has:
            events.append(_rec(now_iso, "built", rid, c, level=c_b.get("built_level")))
        elif p_has and not c_has:
            events.append(_rec(now_iso, "destroyed", rid, c, level=p_b.get("built_level")))
        else:
            p_run = p_b.get("running_level")
            c_run = c_b.get("running_level")
            if p_run is None and c_run is not None:
                events.append(_rec(now_iso, "came_online", rid, c, to=c_run))
            elif p_run is not None and c_run is None:
                events.append(_rec(now_iso, "went_offline", rid, c, **{"from": p_run}))
            elif p_run is not None and c_run is not None and p_run != c_run:
                events.append(_rec(now_iso, "level_changed", rid, c,
                                   **{"from": p_run, "to": c_run}))

        # Built status flip (active / disabled / pending), both sides present
        p_st = p_b.get("built_status")
        c_st = c_b.get("built_status")
        if p_st and c_st and p_st != c_st:
            events.append(_rec(now_iso, "status_changed", rid, c,
                               **{"from": p_st, "to": c_st}))

        # Future activation scheduled. Dedup on the timestamp: the same pending
        # cycle across multiple polls won't re-log, but a new cycle will.
        c_up = c.get("bunker_upgrade") or {}
        p_up = p.get("bunker_upgrade") or {}
        c_active_at = c_up.get("will_be_active_at")
        if c_active_at:
            dt = parse_iso(c_active_at)
            if dt and dt > now and p_up.get("will_be_active_at") != c_active_at:
                events.append(_rec(now_iso, "bunker_activating", rid, c,
                                   active_at=c_active_at, level=c_up.get("level")))

        # Battle presence
        p_bid = p.get("active_battle_id")
        c_bid = c.get("active_battle_id")
        if not p_bid and c_bid:
            events.append(_rec(now_iso, "battle_started", rid, c))
        elif p_bid and not c_bid:
            events.append(_rec(now_iso, "battle_ended", rid, c))

        # Resistance full (occupied only), with hysteresis carried on curr
        p_res = p.get("resistance") or {}
        c_res = c.get("resistance")
        if isinstance(c_res, dict):
            c_val = c_res.get("value")
            c_max = c_res.get("max")
            occupied = bool(
                c.get("country_id") and c.get("initial_country_id")
                and c.get("country_id") != c.get("initial_country_id")
            )
            prev_alerted = bool(p_res.get("alerted"))
            if (occupied and isinstance(c_val, (int, float))
                    and isinstance(c_max, (int, float)) and c_max > 0):
                if c_val >= c_max and not prev_alerted:
                    events.append(_rec(now_iso, "resistance_full", rid, c,
                                       val=int(c_val), max=int(c_max)))
                    c_res["alerted"] = True
                elif prev_alerted and c_val < c_max * RESISTANCE_REARM_RATIO:
                    c_res["alerted"] = False
                else:
                    c_res["alerted"] = prev_alerted
            else:
                c_res["alerted"] = False

    return events


# Persistence

def load_state():
    if not STATE_FILE.exists():
        return {}
    try:
        with STATE_FILE.open("r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, OSError) as e:
        log(f"failed to load state.json ({e}); starting fresh")
        return {}


def save_state(state):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = STATE_FILE.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(state, f, indent=2, sort_keys=True)
    tmp.replace(STATE_FILE)
    log(f"wrote state.json ({len(state)} regions)")


def load_events():
    if not EVENTS_FILE.exists():
        return []
    try:
        with EVENTS_FILE.open("r", encoding="utf-8") as f:
            data = json.load(f)
        # Must be a list. A dict here would silently lose every event.
        return data if isinstance(data, list) else []
    except (json.JSONDecodeError, OSError) as e:
        log(f"failed to load events.json ({e}); starting fresh log")
        return []


def save_events(events):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = EVENTS_FILE.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(events, f, indent=2)
    tmp.replace(EVENTS_FILE)
    log(f"wrote events.json ({len(events)} events)")


def prune_old(events, now):
    cutoff = now - timedelta(days=RETENTION_DAYS)
    kept = []
    for e in events:
        dt = parse_iso(e.get("at"))
        # Keep undated rows rather than silently dropping them.
        if dt is None or dt >= cutoff:
            kept.append(e)
    dropped = len(events) - len(kept)
    if dropped:
        log(f"pruned {dropped} event(s) older than {RETENTION_DAYS}d")
    return kept


def main():
    now = datetime.now(timezone.utc)

    try:
        regions = fetch_all_regions()
    except Exception as e:
        log(f"fetch failed, leaving state and log untouched: {e}")
        return 1

    id_to_code = build_country_id_to_code(regions)
    current    = build_current_state(regions, id_to_code)
    enrich_with_upgrades(current)
    previous   = load_state()

    if not previous:
        log("first run, snapshotting only, no events emitted")
        save_state(current)
        # Ensure the log file exists as an empty list for the page to fetch.
        if not EVENTS_FILE.exists():
            save_events([])
        return 0

    # detect_events writes the resistance hysteresis flag onto `current`,
    # so it must run before save_state(current).
    new_events = detect_events(previous, current, now)
    log(f"detected {len(new_events)} event(s) this run")

    events = load_events()
    events.extend(new_events)
    events = prune_old(events, now)

    save_events(events)
    save_state(current)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())