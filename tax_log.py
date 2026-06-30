#!/usr/bin/env python3
"""
tax_log.py

Daily income-tax snapshot for Irish-owned factories.

Run once per day (GitHub Actions). Mirrors the logic in js/irish-tax.js
but writes to disk so we can track trends across the week.

Pipeline (same as the browser tool):
  1. Paginate all Irish citizens.
  2. worker.getWorkers per citizen → factories they OWN that have workers.
  3. company.getById → region → country (regionsObject) → income-tax rate.
  4. transaction.getPaginatedTransactions (wage, last 24h) → wages the owner
     actually paid, bucketed per factory.
  5. Estimate tax = wages × rate / 100, aggregated per country.

STORAGE:
  data/tax/current_week.json   — rolling Mon–Sun log; resets each Monday
  data/tax/weeks/YYYY-MM-DD.json — archived completed weeks (named by Monday)

current_week.json shape:
  {
    "week_start": "2026-06-29",          ← ISO date of the Monday
    "days": [
      {
        "date": "2026-06-30",
        "countries": [
          { "id": "...", "name": "...", "code": "IE", "rate": 10.0,
            "factories": 3, "workers": 12, "wages": 5000.0, "tax": 500.0 }
        ]
      }
    ],
    "totals": {                           ← summed across all days logged so far
      "<countryId>": { "name": "...", "code": "IE", "rate": 10.0,
                       "factories": 3, "workers": 12,
                       "wages": 5000.0, "tax": 500.0 }
    }
  }

Tax figures are ESTIMATES: wage transactions carry no tax line, so we apply
the factory-country's current income-tax rate to the wages actually paid.
"""

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

# ── Config ────────────────────────────────────────────────────────────────────
PROXY_BASE         = "https://warera-proxy.r00ted82.workers.dev/trpc"
ORIGIN             = "https://tools.we-ie.com"
IRELAND_COUNTRY_ID = "6813b6d446e731854c7ac7fe"
ROOT               = Path(__file__).parent
TAX_DIR            = ROOT / "data" / "tax"
WEEKS_DIR          = TAX_DIR / "weeks"
CURRENT_WEEK_FILE  = TAX_DIR / "current_week.json"
HTTP_TIMEOUT       = 30
MAX_RETRIES        = 3
RETRY_BACKOFF      = 4      # seconds × attempt number
USER_AGENT         = "warera-tax-log/1.0"
PAGE_LIMIT         = 100
WORKERS            = 8      # concurrent factory/wage fetches
COUNTRY_WORKERS    = 20     # more parallelism for country lookups (cheap calls)
WAGE_WINDOW_H      = 24
WAGE_MAX_PAGES     = 5


# ── HTTP / tRPC helpers ───────────────────────────────────────────────────────

def log(msg):
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


def http_get_json(url):
    last_err = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": USER_AGENT,
                "Origin":     ORIGIN,
                "Accept":     "application/json",
            })
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
                return json.loads(r.read().decode("utf-8"))
        except (urllib.error.URLError, urllib.error.HTTPError,
                json.JSONDecodeError, TimeoutError) as e:
            last_err = e
            if attempt < MAX_RETRIES:
                time.sleep(RETRY_BACKOFF * attempt)
    raise RuntimeError(f"GET failed after {MAX_RETRIES} attempts: {last_err}")


def trpc_raw(method, payload):
    """Return the full decoded JSON envelope (not just result.data)."""
    inp = urllib.parse.quote(json.dumps(payload, separators=(",", ":")))
    return http_get_json(f"{PROXY_BASE}/{method}?input={inp}")


def trpc(method, payload):
    return (trpc_raw(method, payload) or {}).get("result", {}).get("data")


# ── API calls ─────────────────────────────────────────────────────────────────

def fetch_all_irish():
    """Paginate user.getUsersByCountry → list of {_id, username} dicts."""
    items, cursor, safety = [], None, 0
    while safety < 300:
        inp = {"countryId": IRELAND_COUNTRY_ID, "limit": PAGE_LIMIT}
        if cursor:
            inp["cursor"] = cursor
        if safety == 0:
            # First page: fetch raw so we can dump the envelope if it's empty.
            raw = trpc_raw("user.getUsersByCountry", inp)
            page = (raw or {}).get("result", {}).get("data")
            first_arr = (page.get("items") if isinstance(page, dict)
                         else (page if isinstance(page, list) else []))
            if not first_arr:
                log("DIAG: first getUsersByCountry page returned no items.")
                log(f"DIAG: raw envelope (first 800 chars): "
                    f"{json.dumps(raw)[:800] if raw is not None else 'None'}")
        else:
            page = trpc("user.getUsersByCountry", inp)
        arr = (page.get("items") if isinstance(page, dict)
               else (page if isinstance(page, list) else []))
        items.extend(arr or [])
        nxt = (page.get("nextCursor") or page.get("cursor")) if isinstance(page, dict) else None
        if not nxt or not arr:
            break
        cursor = nxt
        safety += 1
    return items


def fetch_worker_entries(cid):
    """
    Call worker.getWorkers for one citizen and return a list of factory entries:
      [{ compId, compName, itemCode, ownerId, workers: [userId, ...] }, ...]
    Returns [] on error or if they own no factories with workers.
    """
    try:
        res = trpc("worker.getWorkers", {"userId": cid})
    except Exception as e:
        log(f"  getWorkers error for {cid}: {e}")
        return []

    wpc = (res or {}).get("workersPerCompany") or []
    entries = []
    for entry in wpc:
        co      = entry.get("company")
        comp_id = (co.get("_id") if isinstance(co, dict)
                   else (co if isinstance(co, str) else None))
        workers_raw = entry.get("workers") or []
        if not comp_id or not workers_raw:
            continue
        wids = []
        for w in workers_raw:
            uid = (w.get("user") or w.get("_id") if isinstance(w, dict)
                   else (w if isinstance(w, str) else None))
            if uid:
                wids.append(uid)
        if wids:
            entries.append({
                "compId":   comp_id,
                "compName": co.get("name") if isinstance(co, dict) else None,
                "itemCode": co.get("itemCode") if isinstance(co, dict) else None,
                "ownerId":  cid,
                "workers":  wids,
            })
    return entries


def fetch_company_country(comp_id, regions_obj):
    """company.getById → region → countryId.  Returns (comp_id, countryId|None)."""
    try:
        co = trpc("company.getById", {"companyId": comp_id})
    except Exception:
        return comp_id, None
    if not isinstance(co, dict):
        return comp_id, None
    region = regions_obj.get(co.get("region"))
    return comp_id, (region.get("country") if isinstance(region, dict) else None)


def fetch_country_full(country_stub):
    """country.getCountryById for a stub {_id}.  Returns (_id, full_dict|None)."""
    cid = country_stub.get("_id") if isinstance(country_stub, dict) else None
    if not cid:
        return None, None
    try:
        full = trpc("country.getCountryById", {"countryId": cid})
        return cid, (full if isinstance(full, dict) else None)
    except Exception:
        return cid, None


def fetch_wages_paid(owner_id, worker_to_comp):
    """
    Scan owner's wage transactions for the last 24h.
    Returns { companyId: total_wages_paid } — mirrors paidWagesByCompany() in JS.
    worker_to_comp is a dict { workerId: companyId }.
    """
    cutoff_ts = datetime.now(timezone.utc).timestamp() - WAGE_WINDOW_H * 3600
    by_comp   = {}
    cursor, pages, stop = None, 0, False

    while pages < WAGE_MAX_PAGES and not stop:
        inp = {"userId": owner_id, "transactionType": "wage", "limit": 100}
        if cursor:
            inp["cursor"] = cursor
        try:
            page = trpc("transaction.getPaginatedTransactions", inp)
        except Exception:
            break
        if not isinstance(page, dict):
            break

        items = page.get("items") or page.get("data") or []
        for tx in items:
            created = tx.get("createdAt")
            if not created:
                continue
            try:
                tx_ts = datetime.fromisoformat(
                    created.replace("Z", "+00:00")
                ).timestamp()
            except Exception:
                continue
            if tx_ts < cutoff_ts:
                stop = True
                continue
            if tx.get("buyerId") != owner_id:
                continue
            comp_id = worker_to_comp.get(tx.get("sellerId"))
            if comp_id:
                by_comp[comp_id] = by_comp.get(comp_id, 0) + (tx.get("money") or 0)

        cursor = page.get("nextCursor")
        pages += 1
        if not cursor or not items:
            break

    return by_comp


# ── Weekly log helpers ────────────────────────────────────────────────────────

def this_weeks_monday(today: date) -> date:
    """Monday of the Mon–Sun game week that contains today."""
    return today - timedelta(days=today.weekday())


def recalc_totals(days):
    """
    Sum per-country figures across all day entries in the week.
    Returns a dict { countryId: {...} }.
    Re-computed from scratch each save so it stays consistent even if a
    day entry was replaced by a later re-run.
    """
    totals = {}
    for day in days:
        for c in day.get("countries", []):
            cid = c["id"]
            if cid not in totals:
                totals[cid] = {
                    "name":      c["name"],
                    "code":      c.get("code"),
                    "rate":      c["rate"],
                    "factories": 0,
                    "workers":   0,
                    "wages":     0.0,
                    "tax":       0.0,
                }
            t = totals[cid]
            t["factories"] += c.get("factories", 0)
            t["workers"]   += c.get("workers", 0)
            t["wages"]      = round(t["wages"] + c.get("wages", 0.0), 2)
            t["tax"]        = round(t["tax"]   + c.get("tax",   0.0), 2)
    return totals


def load_current_week():
    if not CURRENT_WEEK_FILE.exists():
        return None
    try:
        with CURRENT_WEEK_FILE.open("r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return None


def save_current_week(data):
    TAX_DIR.mkdir(parents=True, exist_ok=True)
    with CURRENT_WEEK_FILE.open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, separators=(",", ": "))


def archive_week(week_data):
    """Write a completed week to data/tax/weeks/YYYY-MM-DD.json."""
    WEEKS_DIR.mkdir(parents=True, exist_ok=True)
    week_start = week_data.get("week_start", "unknown")
    path = WEEKS_DIR / f"{week_start}.json"
    with path.open("w", encoding="utf-8") as f:
        json.dump(week_data, f, indent=2, separators=(",", ": "))
    log(f"archived week starting {week_start} → {path.name}")


def upsert_day(current, today_iso, country_rows):
    """Replace today's day entry if present, else append it. Then recalc totals."""
    today_entry = {"date": today_iso, "countries": country_rows}
    days = current["days"]
    for i, d in enumerate(days):
        if d.get("date") == today_iso:
            days[i] = today_entry
            log(f"replaced existing entry for {today_iso}")
            break
    else:
        days.append(today_entry)
        log(f"appended new entry for {today_iso}")
    current["totals"] = recalc_totals(days)


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    today     = datetime.now(timezone.utc).date()
    today_iso = today.isoformat()
    monday    = this_weeks_monday(today)
    monday_iso = monday.isoformat()

    TAX_DIR.mkdir(parents=True, exist_ok=True)

    # Roll over to a new week if needed
    current = load_current_week()
    if current and current.get("week_start") != monday_iso:
        log(f"new game week — archiving {current['week_start']}")
        archive_week(current)
        current = None
    if current is None:
        current = {"week_start": monday_iso, "days": [], "totals": {}}
        log(f"started week log for {monday_iso}")

    # ── Step 1: Irish citizens ────────────────────────────────────────────────
    log("step 1: fetching Irish citizens…")
    citizens = fetch_all_irish()
    citizen_ids = [c["_id"] for c in citizens if isinstance(c, dict) and c.get("_id")]
    log(f"  {len(citizen_ids)} citizens")
    if not citizen_ids:
        log("no citizens returned — aborting without changes")
        return 1

    # ── Step 2: Owned factories & workers ────────────────────────────────────
    log(f"step 2: fetching factories & workers for {len(citizen_ids)} citizens…")
    factories   = {}   # compId → {compId, compName, itemCode, ownerId, workers, countryId}
    owner_wmap  = {}   # ownerId → {workerId: compId}

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        for cid, entries in zip(citizen_ids, ex.map(fetch_worker_entries, citizen_ids)):
            for e in entries:
                comp_id = e["compId"]
                if comp_id not in factories:
                    factories[comp_id] = {**e, "countryId": None}
                wmap = owner_wmap.setdefault(cid, {})
                for wid in e["workers"]:
                    wmap[wid] = comp_id

    comp_ids = list(factories.keys())
    owners   = list(owner_wmap.keys())
    log(f"  {len(comp_ids)} factories across {len(owners)} Irish owners")

    if not comp_ids:
        log("no Irish-owned factories found — saving empty day entry")
        upsert_day(current, today_iso, [])
        save_current_week(current)
        return 0

    # ── Step 3: Factory location → country → income-tax rate ─────────────────
    log("step 3: resolving factory countries & tax rates…")

    regions_obj = trpc("region.getRegionsObject", {}) or {}

    all_countries_raw = trpc("country.getAllCountries", {})
    all_countries = (all_countries_raw if isinstance(all_countries_raw, list)
                     else (all_countries_raw or {}).get("items", []))
    country_stubs = [c for c in all_countries if isinstance(c, dict) and c.get("_id")]

    country_by_id = {}
    with ThreadPoolExecutor(max_workers=COUNTRY_WORKERS) as ex:
        for cid_k, full in ex.map(fetch_country_full, country_stubs):
            if cid_k and full:
                country_by_id[cid_k] = full
    log(f"  loaded {len(country_by_id)} countries")

    with ThreadPoolExecutor(max_workers=COUNTRY_WORKERS) as ex:
        for comp_id, country_id in ex.map(
            lambda cid: fetch_company_country(cid, regions_obj), comp_ids
        ):
            factories[comp_id]["countryId"] = country_id

    located = sum(1 for f in factories.values() if f.get("countryId"))
    log(f"  located {located}/{len(comp_ids)} factories")

    # ── Step 4: Wages paid in the last 24h ───────────────────────────────────
    log(f"step 4: summing wages paid in last 24h for {len(owners)} owners…")
    comp_wages = {}

    def fetch_wages_safe(owner_id):
        try:
            return owner_id, fetch_wages_paid(owner_id, owner_wmap[owner_id])
        except Exception as e:
            log(f"  wage fetch error for {owner_id}: {e}")
            return owner_id, {}

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        for _, by_comp in ex.map(fetch_wages_safe, owners):
            for comp_id, amt in by_comp.items():
                comp_wages[comp_id] = comp_wages.get(comp_id, 0) + amt

    total_wages = sum(comp_wages.values())
    log(f"  total wages observed: {total_wages:.2f}")

    # ── Aggregate per country ─────────────────────────────────────────────────
    agg = {}
    for comp_id in comp_ids:
        f       = factories[comp_id]
        c_id    = f.get("countryId")
        c       = country_by_id.get(c_id) if c_id else None
        if not c:
            continue
        rate = float((c.get("taxes") or {}).get("income") or 0)
        if c_id not in agg:
            agg[c_id] = {
                "id":        c_id,
                "name":      c.get("name", "—"),
                "code":      c.get("code") or c.get("iso"),
                "rate":      rate,
                "factories": 0,
                "workers":   0,
                "wages":     0.0,
                "tax":       0.0,
            }
        wages = float(comp_wages.get(comp_id, 0))
        a = agg[c_id]
        a["factories"] += 1
        a["workers"]   += len(f["workers"])
        a["wages"]      = round(a["wages"] + wages, 2)
        a["tax"]        = round(a["tax"] + wages * (rate / 100), 2)

    country_rows = sorted(agg.values(), key=lambda x: -x["tax"])
    total_tax = sum(r["tax"] for r in country_rows)
    log(f"  estimated total daily tax: {total_tax:.2f} across {len(country_rows)} countries")
    for r in country_rows[:5]:
        log(f"    {r['name']:20s}  rate={r['rate']}%  wages={r['wages']:.2f}  tax={r['tax']:.2f}")

    # ── Save ──────────────────────────────────────────────────────────────────
    upsert_day(current, today_iso, country_rows)
    save_current_week(current)
    log("done")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
