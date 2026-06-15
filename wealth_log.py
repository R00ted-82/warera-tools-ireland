#!/usr/bin/env python3
"""
wealth_log.py

Wealth tracker for the Wealth Monitor tool (the #wealth tab on
tools.we-ie.com). Snapshots the wealth of EVERY Irish citizen each run.

STORAGE — per-user files, daily resolution:
  Each citizen gets data/wealth/<userId>.json:
    { "userId", "username", "snapshots": [ {t, total, companies, items,
      money, equipments, weapons}, ... ] }
  The page fetches only the one file for the player being viewed, so this
  scales to hundreds of citizens without a giant download.

  We keep ONE snapshot per UTC day per user (the latest reading wins). The
  chart only ever buckets by day/week/month and the page reads the live
  "now" value client-side, so finer-than-daily history would never be shown.
  Running more often than daily just refreshes the current day's point.

The wealth breakdown is PUBLIC: user.getUserById returns
  stats.wealth = { companies, items, money, equipments, weapons, total }
the exact figures the in-game profile shows under WEALTH.

ORIGIN header: the warera-proxy Worker rejects GitHub Action runners (HTTP
403) unless the request carries a recognised Origin. We send
tools.we-ie.com on every call, same as the other workflows.

Run:
  python wealth_log.py
"""

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Config
PROXY_BASE         = "https://warera-proxy.toie.workers.dev/trpc"
ORIGIN             = "https://tools.we-ie.com"
IRELAND_COUNTRY_ID = "6813b6d446e731854c7ac7fe"
ROOT               = Path(__file__).parent
WEALTH_DIR         = ROOT / "data" / "wealth"
HTTP_TIMEOUT       = 30
MAX_RETRIES        = 3
RETRY_BACKOFF      = 4      # seconds * attempt
USER_AGENT         = "warera-wealth-log/2.0"
RETENTION_DAYS     = 365
WORKERS            = 8      # concurrent getUserById fetches
PAGE_LIMIT         = 100

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
            if attempt < MAX_RETRIES:
                time.sleep(RETRY_BACKOFF * attempt)
    raise RuntimeError(f"GET failed after {MAX_RETRIES} attempts: {last_err}")


def trpc(method, payload):
    inp = urllib.parse.quote(json.dumps(payload, separators=(",", ":")))
    return (http_get_json(f"{PROXY_BASE}/{method}?input={inp}") or {}).get("result", {}).get("data")


def fetch_all_irish():
    """Paginate user.getUsersByCountry → list of citizen dicts ({_id, username})."""
    items, cursor, safety = [], None, 0
    while safety < 300:
        inp = {"countryId": IRELAND_COUNTRY_ID, "limit": PAGE_LIMIT}
        if cursor:
            inp["cursor"] = cursor
        page = trpc("user.getUsersByCountry", inp)
        arr = page.get("items") if isinstance(page, dict) else (page if isinstance(page, list) else [])
        items.extend(arr or [])
        nxt = (page.get("nextCursor") or page.get("cursor")) if isinstance(page, dict) else None
        if not nxt or not arr:
            break
        cursor = nxt
        safety += 1
    return items


def fetch_wealth(uid):
    """Return (username, {component: value}) or (username, None) on no data."""
    data = trpc("user.getUserById", {"userId": uid})
    if not isinstance(data, dict):
        return None, None
    wealth = (data.get("stats") or {}).get("wealth")
    if not isinstance(wealth, dict):
        return data.get("username"), None
    snap = {}
    for k in WEALTH_KEYS:
        v = wealth.get(k)
        if isinstance(v, (int, float)):
            snap[k] = round(float(v), 2)
    return data.get("username"), (snap if snap.get("total") is not None else None)


def upsert(uid, username, snap, now_iso, today, cutoff_iso):
    """Append today's point (or replace today's existing one), prune old."""
    path = WEALTH_DIR / f"{uid}.json"
    rec = None
    if path.exists():
        try:
            with path.open("r", encoding="utf-8") as f:
                rec = json.load(f)
        except (json.JSONDecodeError, OSError):
            rec = None
    if not isinstance(rec, dict) or not isinstance(rec.get("snapshots"), list):
        rec = {"userId": uid, "username": username, "snapshots": []}
    if username:
        rec["username"] = username

    point = {"t": now_iso}
    point.update(snap)
    snaps = rec["snapshots"]
    # One point per UTC day — replace today's if it already exists.
    if snaps and isinstance(snaps[-1].get("t"), str) and snaps[-1]["t"][:10] == today:
        snaps[-1] = point
    else:
        snaps.append(point)
    # Retention prune (keep undated rows rather than silently dropping them).
    rec["snapshots"] = [s for s in snaps if not s.get("t") or s["t"] >= cutoff_iso]

    with path.open("w", encoding="utf-8") as f:
        json.dump(rec, f, separators=(",", ":"))


def main():
    now = datetime.now(timezone.utc)
    now_iso = now.isoformat()
    today = now_iso[:10]
    cutoff_iso = (now - timedelta(days=RETENTION_DAYS)).isoformat()

    WEALTH_DIR.mkdir(parents=True, exist_ok=True)

    citizens = fetch_all_irish()
    ids = [c["_id"] for c in citizens if isinstance(c, dict) and c.get("_id")]
    log(f"fetched {len(ids)} Irish citizens")
    if not ids:
        log("no citizens returned; aborting without changes")
        return 0

    # Concurrent wealth fetches.
    def worker(uid):
        try:
            return uid, fetch_wealth(uid)
        except Exception as e:
            return uid, ("__error__", str(e))

    results = {}
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        for uid, res in ex.map(worker, ids):
            results[uid] = res

    written = skipped = 0
    for uid, (username, snap) in results.items():
        if username == "__error__" or not snap or snap.get("total") is None:
            skipped += 1
            continue
        upsert(uid, username, snap, now_iso, today, cutoff_iso)
        written += 1

    log(f"done: wrote {written} user files, skipped {skipped}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
