#!/usr/bin/env python3
"""
tax_engine.py

Reusable, generic tax-settlement calculation framework — the shared engine
behind deal_log.py (data/tax/deal_config.json → data/tax/deal_logs/<id>.json).

This module has NO country-specific constants. Every function takes the
relevant country as a parameter. It deliberately mirrors the fetch pipeline
already proven by tax_log.py (the Ireland-only tool), but generalized:

  1. fetch_home_citizens(home_country_id)   — paginate citizens of ANY country
  2. fetch_factories_and_workers(citizen_ids) — factories those citizens own
  3. resolve_factory_locations(comp_ids)     — company -> {countryId, regionId}
  4. fetch_wages_per_worker(owners, owner_wmap) — wages paid, last 24h, per worker
  5. resolve_worker_citizenship(worker_ids)  — worker -> citizenship countryId
  6. filter_factories(factories, coverage)   — apply one deal's coverage rule
  7. aggregate(...)                          — one day-row for one deal

tax_log.py keeps its own inline copy of equivalent logic rather than
importing this module — that's deliberate. The production Ireland cron
should never break because this new, actively-evolving generic tool changed.

Field names here are generic (home_workers/partner_workers, not
irish_workers/foreign_workers) since "home" is now a config value, not
always Ireland.
"""

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

PROXY_BASE     = "https://warera-proxy.r00ted82.workers.dev/trpc"
ORIGIN         = "https://tools.we-ie.com"
HTTP_TIMEOUT   = 30
MAX_RETRIES    = 3
RETRY_BACKOFF  = 4
USER_AGENT     = "warera-tax-deal-engine/1.0"
PAGE_LIMIT     = 100
WORKERS        = 8
COUNTRY_WORKERS = 20
WAGE_WINDOW_H  = 24
WAGE_MAX_PAGES = 5
AUTO_REMIT     = 0.30  # game mechanic: 30% of every worker's income tax is
                       # auto-remitted to their citizenship country. Never
                       # part of a manual settlement — only used to derive
                       # host_retained (gross - auto-remit - manual rebate).


def log(msg):
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


# ── HTTP / tRPC helpers ───────────────────────────────────────────────────────

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
    inp = urllib.parse.quote(json.dumps(payload, separators=(",", ":")))
    return http_get_json(f"{PROXY_BASE}/{method}?input={inp}")


def trpc(method, payload):
    return (trpc_raw(method, payload) or {}).get("result", {}).get("data")


# ── Step 1: home-country citizens ────────────────────────────────────────────

def fetch_home_citizens(home_country_id):
    """Paginate user.getUsersByCountry for ANY country id -> [{_id, username}, ...]."""
    items, cursor, safety = [], None, 0
    while safety < 300:
        inp = {"countryId": home_country_id, "limit": PAGE_LIMIT}
        if cursor:
            inp["cursor"] = cursor
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


# ── Step 2: factories/workers owned by those citizens ────────────────────────

def fetch_worker_entries(cid):
    """worker.getWorkers for one citizen -> [{compId, compName, itemCode, ownerId, workers}]."""
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


def fetch_factories_and_workers(citizen_ids):
    """
    Returns (factories, owner_wmap):
      factories:  { compId: {compId, compName, itemCode, ownerId, workers, countryId, regionId} }
      owner_wmap: { ownerId: {workerId: compId} }
    """
    factories, owner_wmap = {}, {}
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        for cid, entries in zip(citizen_ids, ex.map(fetch_worker_entries, citizen_ids)):
            for e in entries:
                comp_id = e["compId"]
                if comp_id not in factories:
                    factories[comp_id] = {**e, "countryId": None, "regionId": None}
                wmap = owner_wmap.setdefault(cid, {})
                for wid in e["workers"]:
                    wmap[wid] = comp_id
    return factories, owner_wmap


# ── Step 3: factory location -> region/country ───────────────────────────────

def fetch_company_region(comp_id):
    """company.getById -> region id. Returns (comp_id, regionId|None)."""
    try:
        co = trpc("company.getById", {"companyId": comp_id})
    except Exception:
        return comp_id, None
    if not isinstance(co, dict):
        return comp_id, None
    return comp_id, co.get("region")


def resolve_factory_locations(factories):
    """
    Mutates `factories` in place, filling in countryId + regionId for every
    factory, via company.getById -> region -> region.getRegionsObject.
    """
    comp_ids = list(factories.keys())
    regions_obj = trpc("region.getRegionsObject", {}) or {}

    with ThreadPoolExecutor(max_workers=COUNTRY_WORKERS) as ex:
        for comp_id, region_id in ex.map(fetch_company_region, comp_ids):
            factories[comp_id]["regionId"] = region_id
            region = regions_obj.get(region_id)
            factories[comp_id]["countryId"] = (
                region.get("country") if isinstance(region, dict) else None
            )
    return factories


def fetch_all_countries():
    """{id: country_dict} from the single country.getAllCountries call.

    country.getAllCountries already returns FULL country objects (taxes, code,
    allies, name, ...) for all ~180 countries in ~1s. We deliberately do NOT
    re-fetch each country via country.getCountryById. That was ~180 extra calls
    at high parallelism that, under proxy load, would fail/retry/time out and
    then get SILENTLY dropped from the map — and a dropped country is a real
    correctness bug, not just slowness:
      * drop the host country (e.g. Yemen) -> resolve_host_country_id() returns
        None -> the deal is skipped entirely ("could not resolve hostCountry").
      * drop a factory country -> aggregate() finds no tax rate -> those
        factories silently contribute zero, corrupting the settlement figure.
    The only fields consumed off these objects are taxes.income and code, both
    present on the getAllCountries payload. One call, no drops.
    """
    all_countries_raw = trpc("country.getAllCountries", {})
    all_countries = (all_countries_raw if isinstance(all_countries_raw, list)
                     else (all_countries_raw or {}).get("items", []))
    return {c["_id"]: c for c in all_countries
            if isinstance(c, dict) and c.get("_id")}


# ── Step 4: wages paid, bucketed per worker ──────────────────────────────────

def fetch_wages_paid(owner_id, worker_to_comp):
    """Owner's wage transactions in the last WAGE_WINDOW_H hours -> {workerId: wages}."""
    cutoff_ts = datetime.now(timezone.utc).timestamp() - WAGE_WINDOW_H * 3600
    by_worker = {}
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
                tx_ts = datetime.fromisoformat(created.replace("Z", "+00:00")).timestamp()
            except Exception:
                continue
            if tx_ts < cutoff_ts:
                stop = True
                continue
            if tx.get("buyerId") != owner_id:
                continue
            worker_id = tx.get("sellerId")
            if worker_id in worker_to_comp:
                by_worker[worker_id] = by_worker.get(worker_id, 0) + (tx.get("money") or 0)

        cursor = page.get("nextCursor")
        pages += 1
        if not cursor or not items:
            break

    return by_worker


def fetch_wages_per_worker(owners, owner_wmap):
    """owners: list of ownerId. owner_wmap: {ownerId: {workerId: compId}} -> {workerId: wages}."""
    worker_wages = {}

    def fetch_safe(owner_id):
        try:
            return owner_id, fetch_wages_paid(owner_id, owner_wmap[owner_id])
        except Exception as e:
            log(f"  wage fetch error for {owner_id}: {e}")
            return owner_id, {}

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        for _, by_worker in ex.map(fetch_safe, owners):
            for worker_id, amt in by_worker.items():
                worker_wages[worker_id] = worker_wages.get(worker_id, 0) + amt
    return worker_wages


# ── Step 5: worker citizenship ────────────────────────────────────────────────

def fetch_user_country(uid):
    try:
        u = trpc("user.getUserLite", {"userId": uid})
    except Exception:
        return uid, None
    if not isinstance(u, dict):
        return uid, None
    return uid, (u.get("country") or u.get("countryId"))


def resolve_worker_citizenship(worker_ids):
    """[workerId, ...] -> {workerId: citizenshipCountryId|None}."""
    home_country = {}
    with ThreadPoolExecutor(max_workers=COUNTRY_WORKERS) as ex:
        for uid, country_id in ex.map(fetch_user_country, worker_ids):
            home_country[uid] = country_id
    return home_country


# ── Coverage filtering (per-deal) ─────────────────────────────────────────────

def resolve_host_country_id(host_country_code, country_by_id):
    """ISO code -> countryId, by scanning the already-fetched country_by_id map."""
    code = (host_country_code or "").upper()
    for cid, c in country_by_id.items():
        c_code = (c.get("code") or c.get("iso") or "").upper()
        if c_code == code:
            return cid
    return None


def filter_factories(factories, coverage, host_country_id=None):
    """
    Apply one deal's `coverage` rule to the full factory set for a home
    country. Returns the subset of factories (by compId) this deal covers.
      coverage = {"type": "country"}                       -> factory.countryId == host_country_id
      coverage = {"type": "regions", "regionIds": [...]}    -> factory.regionId in regionIds
      coverage = {"type": "companies", "companyIds": [...]} -> compId in companyIds
    """
    ctype = (coverage or {}).get("type", "country")
    if ctype == "regions":
        region_ids = set(coverage.get("regionIds") or [])
        return {cid: f for cid, f in factories.items() if f.get("regionId") in region_ids}
    if ctype == "companies":
        company_ids = set(coverage.get("companyIds") or [])
        return {cid: f for cid, f in factories.items() if cid in company_ids}
    # default: "country"
    return {cid: f for cid, f in factories.items() if f.get("countryId") == host_country_id}


# ── Aggregation (per deal, per day) ───────────────────────────────────────────

def aggregate(factories, worker_wages, worker_citizenship, country_by_id,
              home_country_id, home_rebate, foreign_rebate):
    """
    Sums the deal's covered factories into one day-row. Tax is estimated the
    same way tax_log.py does: wages actually paid x the FACTORY country's
    current income-tax rate (wage transactions carry no tax line).
    """
    row = {
        "factories":           0,
        "workers":             0,
        "home_workers":        0,
        "partner_workers":     0,
        "wages":               0.0,
        "gross_tax":           0.0,
        "home_worker_tax":     0.0,
        "partner_worker_tax":  0.0,
        "manual_rebate_due":   0.0,
        "auto_remit_tax":      0.0,
        "host_retained":       0.0,
    }
    for comp_id, f in factories.items():
        c_id = f.get("countryId")
        c = country_by_id.get(c_id) if c_id else None
        if not c:
            continue
        rate = float((c.get("taxes") or {}).get("income") or 0)
        row["factories"] += 1
        row["workers"]   += len(f["workers"])
        for wid in f["workers"]:
            wages = float(worker_wages.get(wid, 0))
            row["wages"] += wages
            tax = wages * (rate / 100)
            row["gross_tax"] += tax
            if worker_citizenship.get(wid) == home_country_id:
                row["home_workers"]    += 1
                row["home_worker_tax"] += tax
                row["manual_rebate_due"] += tax * home_rebate
            else:
                row["partner_workers"]    += 1
                row["partner_worker_tax"] += tax
                row["manual_rebate_due"]  += tax * foreign_rebate

    row["auto_remit_tax"] = row["gross_tax"] * AUTO_REMIT
    row["host_retained"]  = row["gross_tax"] - row["auto_remit_tax"] - row["manual_rebate_due"]

    for k in ("wages", "gross_tax", "home_worker_tax", "partner_worker_tax",
              "manual_rebate_due", "auto_remit_tax", "host_retained"):
        row[k] = round(row[k], 2)
    return row
