#!/usr/bin/env python3
"""
wealth_log.py

Wealth tracker for the Wealth Monitor tool (wealth-monitor.html on
tools.we-ie.com). Companion to bunker_log.py: that one remembers regions,
this one remembers player wealth.

Polls every 2h via GitHub Actions cron. For every user on the monitored
list it fetches the public wealth breakdown and appends a timestamped
snapshot to a rolling per-user history. The page reads that history and
draws the wealth-over-time graph (total + the five-way breakdown), bucketed
by day / week / month in the browser.

The wealth breakdown is PUBLIC. user.getUserById returns:
  stats.wealth = { companies, items, money, equipments, weapons, total }
These are the exact figures the in-game profile shows under WEALTH. We store
all five components plus the total so the page can graph any of them without
re-fetching history.

NOTE ON THE ORIGIN HEADER:
  The warera-proxy Worker's CORS gate rejects GitHub Action runners (HTTP 403)
  unless the request carries an Origin the proxy recognises. The waitlist
  workflow hit the same wall. We send Origin: https://tools.we-ie.com on every
  call for the same reason. (bunker_log.py's region endpoint happens not to
  need it, but the user.* endpoints do.)

NOTE ON rankings.userWealth vs stats.wealth.total:
  rankings.userWealth.value is a separately-computed, slightly-lagged ranking
  figure. stats.wealth.total is the exact sum of the five components shown on
  the profile, so that is what we store as "total".

Run:
  python wealth_log.py

Input:
  monitored-users.json   { "entries": [ { "userId", "username" }, ... ] }

Output (committed back by the workflow):
  data/wealth-history.json
    {
      "users": {
        "<userId>": {
          "username": "toie",
          "snapshots": [
            { "t": "<iso>", "total", "companies", "items",
              "money", "equipments", "weapons" }, ...
          ]
        }
      },
      "updatedAt": "<iso>"
    }
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
ORIGIN         = "https://tools.we-ie.com"
ROOT           = Path(__file__).parent
MONITORED_FILE = ROOT / "monitored-users.json"
DATA_DIR       = ROOT / "data"
HISTORY_FILE   = DATA_DIR / "wealth-history.json"
HTTP_TIMEOUT   = 30
MAX_RETRIES    = 3
RETRY_BACKOFF  = 5      # seconds, multiplied by attempt number
USER_AGENT     = "warera-wealth-log/1.0"
RETENTION_DAYS = 730    # keep two years of snapshots per user
FETCH_PAUSE    = 0.2    # seconds between per-user fetches, be polite

# The five components the profile breaks wealth into, plus the total. Keys are
# exactly what stats.wealth uses. The page expects these same keys.
WEALTH_KEYS = ("total", "companies", "items", "money", "equipments", "weapons")


def log(msg):
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


def http_get_json(url):
    last_err = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": USER_AGENT,
                "Origin": ORIGIN,
                "Accept": "application/json",
            })
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
                return json.loads(r.read().decode("utf-8"))
        except (urllib.error.URLError, urllib.error.HTTPError,
                json.JSONDecodeError, TimeoutError) as e:
            last_err = e
            log(f"GET failed (attempt {attempt}/{MAX_RETRIES}): {e}")
            if attempt < MAX_RETRIES:
                time.sleep(RETRY_BACKOFF * attempt)
    raise RuntimeError(f"GET {url} failed after {MAX_RETRIES} attempts: {last_err}")


def trpc(method, payload):
    inp = urllib.parse.quote(json.dumps(payload, separators=(",", ":")))
    url = f"{PROXY_BASE}/{method}?input={inp}"
    body = http_get_json(url)
    return (body or {}).get("result", {}).get("data")


def parse_iso(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return None


# Monitored list + history I/O

def load_monitored():
    try:
        with MONITORED_FILE.open("r", encoding="utf-8") as f:
            data = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError) as e:
        log(f"could not read monitored-users.json ({e}); nothing to track")
        return []
    entries = data.get("entries") if isinstance(data, dict) else None
    return entries if isinstance(entries, list) else []


def load_history():
    if not HISTORY_FILE.exists():
        return {"users": {}, "updatedAt": None}
    try:
        with HISTORY_FILE.open("r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict) and isinstance(data.get("users"), dict):
            return data
    except (json.JSONDecodeError, OSError) as e:
        log(f"failed to load wealth-history.json ({e}); starting fresh")
    return {"users": {}, "updatedAt": None}


def save_history(history):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = HISTORY_FILE.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(history, f, indent=2)
    tmp.replace(HISTORY_FILE)
    n_users = len(history.get("users", {}))
    n_snaps = sum(len(u.get("snapshots", [])) for u in history.get("users", {}).values())
    log(f"wrote wealth-history.json ({n_users} users, {n_snaps} snapshots total)")


# Snapshot

def fetch_wealth(user_id):
    """Return (username, {component: value}) or (None, None) on failure."""
    data = trpc("user.getUserById", {"userId": user_id})
    if not isinstance(data, dict):
        return None, None
    wealth = (data.get("stats") or {}).get("wealth")
    if not isinstance(wealth, dict):
        return data.get("username"), None
    snap = {}
    for k in WEALTH_KEYS:
        v = wealth.get(k)
        snap[k] = round(float(v), 2) if isinstance(v, (int, float)) else None
    return data.get("username"), snap


def prune_old(snapshots, now):
    cutoff = now - timedelta(days=RETENTION_DAYS)
    kept = []
    for s in snapshots:
        dt = parse_iso(s.get("t"))
        # Keep undated rows rather than silently dropping them.
        if dt is None or dt >= cutoff:
            kept.append(s)
    return kept


def main():
    now = datetime.now(timezone.utc)
    now_iso = now.isoformat()

    entries = load_monitored()
    if not entries:
        log("monitored list is empty; nothing to do")
        # Still ensure the history file exists so the page can fetch it.
        if not HISTORY_FILE.exists():
            save_history({"users": {}, "updatedAt": now_iso})
        return 0

    history = load_history()
    users = history.setdefault("users", {})

    taken = 0
    for entry in entries:
        uid = (entry or {}).get("userId")
        if not uid:
            continue
        try:
            username, snap = fetch_wealth(uid)
        except Exception as e:
            log(f"fetch failed for {uid} (non-fatal): {e}; keeping prior history")
            continue
        if not snap or snap.get("total") is None:
            log(f"no wealth data for {uid} ({username}); skipping this run")
            continue

        rec = users.setdefault(uid, {"username": username or entry.get("username"),
                                     "snapshots": []})
        # Canonical username from the API wins, keeps the file tidy over time.
        if username:
            rec["username"] = username

        point = {"t": now_iso}
        point.update(snap)
        rec.setdefault("snapshots", []).append(point)
        rec["snapshots"] = prune_old(rec["snapshots"], now)
        taken += 1
        log(f"snapshotted {rec['username']}: total={snap['total']}")
        time.sleep(FETCH_PAUSE)

    history["updatedAt"] = now_iso
    save_history(history)
    log(f"done: {taken} snapshot(s) taken this run")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
