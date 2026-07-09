#!/usr/bin/env python3
"""
deal_log.py

Daily driver for the generic tax-rebate "deal logger" (see tax_engine.py for
the shared calculation framework). Config-driven — data/tax/deal_config.json
lists every deal; adding a deal never requires a code change here.

Run once per day (GitHub Actions, .github/workflows/deal-log.yml).

Pipeline:
  1. Load data/tax/deal_config.json. Keep deals where enabled and
     today >= startDate.
  2. Group deals by homeCountry.id. Multiple deals can share a home country
     (e.g. Ireland<->Yemen and Ireland<->Egypt) — the citizen/factory/wage
     scan for a home country is fetched ONCE and shared across every deal in
     that group, so N deals for the same home country cost the same one API
     pass as a single deal would. This is the whole point: don't hammer the
     shared proxy/API key.
  3. For each deal: filter that home country's factories down to the deal's
     `coverage` rule, aggregate today's tax/rebate figures, upsert into
     data/tax/deal_logs/<id>.json (per-deal file, own current_week +
     previous_week + weekly archive — see roll_week()).

Same no-data guards as tax_log.py: an outage run (no citizens, no factories,
zero wages) writes nothing and exits so a later same-day cron retries,
rather than recording a misleading zero day.
"""

import json
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import tax_engine as eng

ROOT            = Path(__file__).parent
TAX_DIR         = ROOT / "data" / "tax"
DEAL_CONFIG_FILE = TAX_DIR / "deal_config.json"
DEAL_LOGS_DIR   = TAX_DIR / "deal_logs"
DEAL_ARCHIVE_DIR = DEAL_LOGS_DIR / "archive"

log = eng.log


# ── Config ────────────────────────────────────────────────────────────────────

def load_deal_config():
    try:
        with DEAL_CONFIG_FILE.open("r", encoding="utf-8") as f:
            data = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError) as e:
        log(f"WARN: could not load {DEAL_CONFIG_FILE.name} ({e}) — no deals to log")
        return []
    return data.get("deals") or []


def active_deals(deals, today):
    out = []
    for d in deals:
        if not d.get("enabled"):
            continue
        start = d.get("startDate")
        try:
            if start and date.fromisoformat(start) > today:
                continue
        except ValueError:
            log(f"WARN: deal {d.get('id')} has an unparsable startDate {start!r} — skipping")
            continue
        if not d.get("id") or not (d.get("homeCountry") or {}).get("id"):
            log(f"WARN: deal missing id/homeCountry.id — skipping: {d!r}")
            continue
        out.append(d)
    return out


def group_by_home_country(deals):
    groups = {}
    for d in deals:
        hc_id = d["homeCountry"]["id"]
        groups.setdefault(hc_id, []).append(d)
    return groups


# ── Per-deal log file helpers ─────────────────────────────────────────────────

def this_weeks_monday(today: date) -> date:
    return today - timedelta(days=today.weekday())


def deal_log_path(deal_id):
    return DEAL_LOGS_DIR / f"{deal_id}.json"


def load_deal_log(deal_id):
    path = deal_log_path(deal_id)
    if not path.exists():
        return None
    with path.open("r", encoding="utf-8") as f:
        text = f.read()
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        raise RuntimeError(
            f"{path} exists but is not valid JSON ({e}). Refusing to overwrite "
            "it with a fresh log — fix or restore the file before rerunning."
        ) from e


def save_deal_log(deal_id, data):
    DEAL_LOGS_DIR.mkdir(parents=True, exist_ok=True)
    path = deal_log_path(deal_id)
    with path.open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, separators=(",", ": "))


def archive_week(deal_id, week_data):
    week_start = week_data.get("week_start", "unknown")
    out_dir = DEAL_ARCHIVE_DIR / deal_id
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{week_start}.json"
    with path.open("w", encoding="utf-8") as f:
        json.dump(week_data, f, indent=2, separators=(",", ": "))
    log(f"  archived {deal_id} week {week_start} -> {path.relative_to(ROOT)}")


def recalc_week_totals(days):
    """Sum a deal's day-rows into one totals dict. See tax_engine.aggregate for field shapes."""
    totals = {
        "factories": 0, "workers": 0, "home_workers": 0, "partner_workers": 0,
        "wages": 0.0, "gross_tax": 0.0, "home_worker_tax": 0.0,
        "partner_worker_tax": 0.0, "manual_rebate_due": 0.0,
        "auto_remit_tax": 0.0, "host_retained": 0.0,
    }
    for day in days:
        row = day.get("row") or {}
        for k in ("factories", "workers", "home_workers", "partner_workers"):
            totals[k] += row.get(k, 0)
        for k in ("wages", "gross_tax", "home_worker_tax", "partner_worker_tax",
                   "manual_rebate_due", "auto_remit_tax", "host_retained"):
            totals[k] = round(totals[k] + row.get(k, 0.0), 2)
    return totals


def upsert_deal_day(deal, today_iso, today, row, host_country_id=None):
    """Load/create the deal's log file, upsert today's row, roll the week if needed."""
    existing = load_deal_log(deal["id"])
    monday_iso = this_weeks_monday(today).isoformat()

    if existing is None:
        existing = {
            "deal_id":               deal["id"],
            "deal_version":          deal.get("dealVersion", 1),
            "home_country":          deal["homeCountry"],
            # host_country.id is included (when resolvable) so the dashboard
            # can look up the home country's ally list client-side, for the
            # paper transfer-tax cost — see js/tax-deal-dashboard.js.
            "host_country":          {**deal["hostCountry"], "id": host_country_id},
            "home_citizen_rebate":   deal["homeCitizenRebate"],
            "non_home_citizen_rebate": deal["nonHomeCitizenRebate"],
            "current_week":          {"week_start": monday_iso, "days": [], "totals": {}},
            "previous_week":         None,
            "updated_at":            None,
        }

    # Keep the deal's own metadata fresh (rebate rates / name may have been
    # edited in deal_config.json since the last run).
    existing["deal_version"]            = deal.get("dealVersion", existing.get("deal_version", 1))
    existing["home_citizen_rebate"]      = deal["homeCitizenRebate"]
    existing["non_home_citizen_rebate"]  = deal["nonHomeCitizenRebate"]
    if host_country_id and not existing.get("host_country", {}).get("id"):
        existing["host_country"] = {**existing.get("host_country", deal["hostCountry"]), "id": host_country_id}

    cur = existing["current_week"]
    if cur.get("week_start") != monday_iso:
        log(f"  {deal['id']}: new game week — rolling to previous_week and archiving")
        cur["totals"] = recalc_week_totals(cur["days"])
        archive_week(deal["id"], cur)
        existing["previous_week"] = {"week_start": cur["week_start"], "totals": cur["totals"]}
        cur = {"week_start": monday_iso, "days": [], "totals": {}}
        existing["current_week"] = cur

    days = cur["days"]
    for i, d in enumerate(days):
        if d.get("date") == today_iso:
            days[i] = {"date": today_iso, "row": row}
            break
    else:
        days.append({"date": today_iso, "row": row})

    cur["totals"] = recalc_week_totals(days)
    existing["updated_at"] = datetime.now(timezone.utc).isoformat()
    return existing


def already_logged_today(deal_id, today_iso):
    existing = load_deal_log(deal_id)
    if not existing:
        return False
    for d in existing.get("current_week", {}).get("days", []):
        if d.get("date") == today_iso and d.get("row", {}).get("workers"):
            return True
    return False


# ── Main ──────────────────────────────────────────────────────────────────────

def process_home_country_group(home_country_id, deals, today_iso, today):
    """One API pass for `home_country_id`, fanned out across every deal in `deals`."""
    log(f"home country {home_country_id}: {len(deals)} deal(s) — {[d['id'] for d in deals]}")

    citizens = eng.fetch_home_citizens(home_country_id)
    citizen_ids = [c["_id"] for c in citizens if isinstance(c, dict) and c.get("_id")]
    if not citizen_ids:
        log("  no citizens returned — skipping this home country (likely API outage)")
        return

    factories, _owner_wmap = eng.fetch_factories_and_workers(citizen_ids)
    if not factories:
        log("  no owned factories found — skipping this home country (likely API outage)")
        return
    eng.resolve_factory_locations(factories)

    country_by_id = eng.fetch_all_countries()

    # Resolve every deal's coverage BEFORE the two per-worker call storms
    # (wages + citizenship). The home country may own factories all over the
    # world, but these deals only settle factories in their host country — so
    # we fetch wages/citizenship for just the UNION of covered factories, not
    # the whole global footprint. Aggregate() only ever reads workers that live
    # in covered factories, so the numbers written are identical; we just stop
    # paying for data no deal will use. host ids are cached here and reused in
    # the aggregation loop below (no second resolve pass).
    deal_plans = []          # [(deal, host_country_id, covered_factories)]
    covered_comp_ids = set()
    for deal in deals:
        if already_logged_today(deal["id"], today_iso):
            log(f"  {deal['id']}: {today_iso} already logged — skipping")
            continue

        coverage = deal.get("coverage") or {"type": "country"}
        host_country_id = None
        if coverage.get("type", "country") == "country":
            host_country_id = eng.resolve_host_country_id(
                deal["hostCountry"]["code"], country_by_id
            )
            if not host_country_id:
                log(f"  {deal['id']}: could not resolve hostCountry code "
                    f"{deal['hostCountry']['code']!r} — skipping")
                continue

        covered = eng.filter_factories(factories, coverage, host_country_id)
        deal_plans.append((deal, host_country_id, covered))
        covered_comp_ids.update(covered.keys())

    if not deal_plans:
        log("  nothing left to log for this home country")
        return

    # Restrict wages + citizenship to workers in the covered factories only.
    covered_worker_ids = sorted(
        {wid for cid in covered_comp_ids for wid in factories[cid]["workers"]}
    )
    covered_owner_wmap = {}
    for cid in covered_comp_ids:
        owner_id = factories[cid]["ownerId"]
        wmap = covered_owner_wmap.setdefault(owner_id, {})
        for wid in factories[cid]["workers"]:
            wmap[wid] = cid
    covered_owners = list(covered_owner_wmap.keys())

    worker_wages = eng.fetch_wages_per_worker(covered_owners, covered_owner_wmap)
    if sum(worker_wages.values()) <= 0:
        # Same guard shape as before, now scoped to the covered factories: an
        # API outage OR a genuine zero-wage day both write nothing and let a
        # later cron retry, rather than recording a (possibly misleading) zero.
        log("  no wage data observed for covered factories — skipping "
            "(outage or a genuine zero-wage day; a later cron retries)")
        return

    worker_citizenship = eng.resolve_worker_citizenship(covered_worker_ids)

    for deal, host_country_id, covered in deal_plans:
        row = eng.aggregate(
            covered, worker_wages, worker_citizenship, country_by_id,
            home_country_id, deal["homeCitizenRebate"], deal["nonHomeCitizenRebate"],
        )
        log(f"  {deal['id']}: factories={row['factories']} workers={row['workers']} "
            f"gross={row['gross_tax']:.2f} rebate_due={row['manual_rebate_due']:.2f}")

        updated = upsert_deal_day(deal, today_iso, today, row, host_country_id)
        save_deal_log(deal["id"], updated)


def main():
    today     = datetime.now(timezone.utc).date()
    today_iso = today.isoformat()

    deals = active_deals(load_deal_config(), today)
    if not deals:
        log("no active deals — nothing to do")
        return 0

    groups = group_by_home_country(deals)
    log(f"{len(deals)} active deal(s) across {len(groups)} home countr{'y' if len(groups)==1 else 'ies'}")

    for home_country_id, group_deals in groups.items():
        try:
            process_home_country_group(home_country_id, group_deals, today_iso, today)
        except Exception as e:
            log(f"ERROR processing home country {home_country_id}: {e}")

    log("done")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
