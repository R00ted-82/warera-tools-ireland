/* ═══════════════════════════════════════════════════════════════════
 *  IRISH FACTORY TAX — DEV/TEST COPY (standalone #tax-dev view)
 *
 *  ⚠️ UNENCRYPTED, link-only. Not linked from any nav, tab, or tool-card —
 *  reachable only by typing/bookmarking #tax-dev. Unlike the real tool
 *  (js/irish-tax.js + gitignored tax-payload.js, password-gated), this
 *  copy ships its logic in the clear so it can be pushed to GitHub and
 *  iterated on without re-encrypting on every change. Anyone who guesses
 *  or is given the #tax-dev URL can read the full source — don't put
 *  anything here that isn't already visible in the real (encrypted) tool.
 *
 *  When a change here is ready to ship for real: copy this file's guts
 *  into tax-payload.js (the gitignored plaintext source), re-encrypt via
 *  encrypt.html, and paste the new blob into TAX_ENCRYPTED_PAYLOAD in
 *  js/irish-tax.js. See README/ONBOARDING for the full steps.
 *
 *  Otherwise identical to the real tool — see js/irish-tax.js's header
 *  comment (pre-encryption) / tax-payload.js for the full feature list.
 * ═══════════════════════════════════════════════════════════════════ */
const IrishTaxDevTool = (() => {
  const PAGE_LIMIT     = 100;
  const WAGE_WINDOW_MS = 24 * 3600 * 1000;
  const WAGE_MAX_PAGES = 5;
  // Game mechanic: 30% of every worker's income tax is auto-remitted to their
  // citizenship country. This is NOT part of the settlement — it's only used to
  // derive what the host country keeps (host_retained). Every rebate the tool
  // reports is the *additional* manually negotiated amount from data/tax/deals.json.
  const AUTO_REMIT     = 0.30;
  // "Send money to country" law: a transfer tax paid in the *paper* resource on
  // top of the amount sent — 50% of the amount (in paper units) to allies, 100%
  // to everyone else. The recipient still gets the full amount; the paper is a
  // pure cost to the sender. We price that paper at the current market rate to
  // show what settling actually costs / nets.
  const PAPER_RATE     = { ally: 0.5, other: 1.0 };
  const PAPER_ITEM     = 'paper';

  /* ── Inject tax-specific CSS (same rules as tax-payload.js) ──────── */
  const styleEl = document.createElement('style');
  styleEl.id = 'taxdev-injected-styles';
  styleEl.textContent = `
.tax-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin: 4px 0 20px; }
.tax-card { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; }
.tax-card.warn { border-color: rgba(251,191,36,.35); }
.tax-card.ok { border-color: rgba(74,222,128,.35); }
.tax-card-v { font-size: 24px; font-weight: 700; letter-spacing: -.5px; font-variant-numeric: tabular-nums; }
.tax-card.warn .tax-card-v { color: var(--warn); }
.tax-card.ok .tax-card-v { color: var(--accent); }
.tax-card-l { font-size: 12px; color: var(--muted); margin-top: 4px; line-height: 1.4; }
.tax-card-l span { display: block; opacity: .8; }

.tax-tbl { width: 100%; border-collapse: collapse; font-size: 13.5px; }
.tax-tbl th, .tax-tbl td { padding: 9px 12px; text-align: right; border-bottom: 1px solid var(--border); white-space: nowrap; }
.tax-tbl th { color: var(--muted); font-weight: 600; font-size: 12px; }
.tax-tbl th.l, .tax-tbl td.l { text-align: left; }
.tax-tbl td.l { font-weight: 500; }
.tax-tbl tbody tr:hover { background: var(--panel-2); }
.tax-tbl tr.home { background: rgba(74,222,128,.07); }
.tax-tbl tr.home td { border-color: rgba(74,222,128,.2); }
.tax-home-tag { font-size: 10px; font-weight: 600; color: var(--accent); border: 1px solid rgba(74,222,128,.4); border-radius: 999px; padding: 1px 6px; margin-left: 4px; }
.tax-note { font-size: 11.5px; color: var(--muted); margin-top: 12px; line-height: 1.5; }

.tax-row { cursor: pointer; }
.tax-caret { display: inline-block; width: 12px; color: var(--muted); font-size: 10px; transition: transform .12s; }
.tax-row.open .tax-caret { transform: rotate(90deg); }
.tax-detail { display: none; }
.tax-detail.open { display: table-row; }
.tax-detail > td { background: var(--panel-2); padding: 0; border-bottom: 1px solid var(--border); }
.tax-detail-wrap { padding: 10px 14px; display: flex; flex-direction: column; gap: 10px; }
.tax-fac { border-left: 2px solid var(--border); padding-left: 10px; }
.tax-fac-h { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; }
.tax-fac-name { font-weight: 600; font-size: 13px; text-decoration: none; color: var(--link); }
.tax-fac-meta { font-size: 11.5px; color: var(--muted); }
.tax-fac-meta a { color: var(--link); text-decoration: none; }
.tax-fac-workers { font-size: 12px; margin-top: 3px; line-height: 1.7; }
.tax-fac-workers a { color: var(--text); text-decoration: none; border-bottom: 1px dotted var(--border); }
.tax-fac-workers a:hover { color: var(--link); border-color: var(--link); }
.tax-sep { color: var(--border); margin: 0 6px; }
.tax-dim { color: var(--muted); }
.tax-worker-flag { font-size: 11px; margin-left: 1px; cursor: help; }

.tax-table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; margin: 0 -2px; }

.tax-log-report {
  display: flex; align-items: center; gap: 8px;
  background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
  padding: 10px 14px; margin: 0 0 16px; font-size: 12.5px; color: var(--muted);
}
.tax-log-report.dim { color: var(--muted); font-style: italic; }
.tax-log-report strong { color: var(--text); }
.tax-log-icon { font-size: 15px; flex: none; }

.tax-menu-wrap { display: flex; flex-direction: column; gap: 6px; padding: 12px 14px; }
.tax-menu-opt {
  display: flex; align-items: center; gap: 8px; text-align: left;
  background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px;
  padding: 9px 12px; font-size: 13px; color: var(--text); cursor: pointer;
  font-family: inherit; transition: border-color .12s, background .12s;
}
.tax-menu-opt:hover { border-color: var(--link); background: var(--panel); }

.tax-audit { padding: 12px 14px 4px; display: flex; flex-direction: column; gap: 10px; }
.tax-audit-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; }
.tax-audit-cat { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; }
.tax-audit-h { font-size: 12.5px; font-weight: 600; margin-bottom: 6px; display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.tax-audit-rate { font-size: 10.5px; font-weight: 600; color: var(--accent); border: 1px solid rgba(74,222,128,.35); border-radius: 999px; padding: 1px 7px; white-space: nowrap; }
.tax-audit-row { display: flex; justify-content: space-between; gap: 12px; font-size: 12.5px; padding: 2px 0; color: var(--muted); }
.tax-audit-row b { color: var(--text); font-variant-numeric: tabular-nums; font-weight: 600; }
.tax-audit-tot { border-top: 1px solid var(--border); padding-top: 8px; display: flex; flex-direction: column; gap: 2px; }
.tax-audit-row.big { font-size: 13.5px; }
.tax-audit-row.big b { color: var(--accent); }
.tax-audit-note { font-size: 11px; color: var(--muted); line-height: 1.5; white-space: normal; }

.tax-src { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--muted); margin: 2px 0 10px; line-height: 1.5; }
.tax-src strong { color: var(--text); }
.tax-src.live strong { color: var(--accent); }

.tax-paperbar { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--muted); line-height: 1.5;
  background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 8px 12px; margin: 0 0 12px; }
.tax-paperbar strong { color: var(--text); }
.tax-paperbar em { color: var(--warn); font-style: normal; }
.tax-ally { font-size: 10px; font-weight: 600; color: var(--muted); border: 1px solid var(--border); border-radius: 999px; padding: 1px 6px; white-space: nowrap; }
.tax-ally.yes { color: var(--accent); border-color: rgba(74,222,128,.4); }
.taxdev-paper-lbl { display: inline-flex; align-items: center; gap: 3px; font-size: 12px; color: var(--muted); margin-right: 8px; }
.taxdev-paper-lbl input { width: 74px; padding: 5px 7px; font-size: 12.5px; font-family: inherit;
  background: var(--panel-2); border: 1px solid var(--border); border-radius: 7px; color: var(--text); }
.taxdev-paper-lbl input:focus { outline: none; border-color: var(--link); }

.tax-back {
  background: none; border: none; color: var(--link); font-size: 12px;
  cursor: pointer; font-family: inherit; padding: 10px 14px 0; margin: 0;
}
.tax-back:hover { text-decoration: underline; }

.tax-chart-title { font-size: 12.5px; color: var(--muted); padding: 6px 14px 0; }
.tax-detail .wm-chart-box { padding: 4px 14px 12px; }

@media (max-width: 560px) {
  .tax-cards { gap: 8px; margin-bottom: 16px; }
  .tax-card { padding: 11px 13px; border-radius: 10px; }
  .tax-card-v { font-size: 19px; }
  .tax-card-l { font-size: 11px; }
  .tax-tbl { font-size: 12.5px; }
  .tax-tbl th, .tax-tbl td { padding: 8px 9px; }
  .tax-tbl th { font-size: 11px; }
  .tax-fac-workers { font-size: 12px; line-height: 1.9; }
  .tax-note { font-size: 11px; }
  /* The per-row audit panel sits in a <td colspan> that spans the whole
     (wide, horizontally-scrollable) table, so it inherits that width and
     its text never needs to wrap. Cap it to the viewport instead so the
     "Gross tax .../day · ..." note and other audit text wrap normally. */
  .tax-audit { width: calc(100vw - 40px); box-sizing: border-box; }
}
`;
  document.head.appendChild(styleEl);

  /* ── Inject HTML into #taxdev-content ────────────────────────────
     (own container/ids so this can never collide with the real,
     password-gated tool's injected #tax-content if both are unlocked
     in the same tab). */
  document.getElementById('taxdev-content').innerHTML = `
    <div id="taxdev-log-report"></div>

    <div id="taxdev-steps" class="steps hidden">
      <div class="step" data-state="pending" data-step="1">
        <div class="step-icon"></div>
        <div class="step-body"><div class="step-title">Finding Irish citizens</div><div class="step-sub"></div></div>
        <div class="step-count"></div>
      </div>
      <div class="step" data-state="pending" data-step="2">
        <div class="step-icon"></div>
        <div class="step-body"><div class="step-title">Pulling Irish-owned factories &amp; workers</div><div class="step-sub"></div></div>
        <div class="step-count"></div>
      </div>
      <div class="step" data-state="pending" data-step="3">
        <div class="step-icon"></div>
        <div class="step-body"><div class="step-title">Loading countries &amp; tax rates</div><div class="step-sub"></div></div>
        <div class="step-count"></div>
      </div>
      <div class="step" data-state="pending" data-step="4">
        <div class="step-icon"></div>
        <div class="step-body"><div class="step-title">Summing actual wages</div><div class="step-sub"></div></div>
        <div class="step-count"></div>
      </div>
    </div>
    <div id="taxdev-status" class="status hidden"></div>
    <div id="taxdev-summary"></div>
    <div id="taxdev-table"></div>
  `;

  /* ── Inject controls (refresh button) into the header ──────────── */
  document.getElementById('taxdev-controls').innerHTML = `
    <label class="taxdev-paper-lbl" title="Paper price used to cost the transfer tax. Leave blank to use the live market price; type a value to override (useful when paper isn't trading).">📄 ₿<input id="taxdev-paper-price" type="number" min="0" step="0.001" placeholder="market"></label>
    <button id="taxdev-refresh" title="Pull current figures live from the game (slower) and enable the per-worker drill-down">Refresh (live)</button>
  `;

  /* ── IrishTaxDevTool ────────────────────────────────────────────── */
  const $refresh = document.getElementById('taxdev-refresh');
  const $summary = document.getElementById('taxdev-summary');
  const $logReport = document.getElementById('taxdev-log-report');
  const $table   = document.getElementById('taxdev-table');
  const steps    = makeSteps(document.getElementById('taxdev-steps'));
  const setStatus = makeStatus(document.getElementById('taxdev-status'));

  let loaded = false;
  let nameById = {};   // userId -> username (citizens free; workers resolved)
  let homeCountryById = {};   // userId -> countryId (citizens = Ireland free; workers resolved) — this is who the 30% remittance actually goes to
  let homeCountryInfoById = {};   // countryId -> { name, code }, for rendering the flags above
  let currentLog = null;      // parsed data/tax/current_week.json
  let weekLogs = null;        // [{ weekStart, data }], lazy-loaded
  // Bilateral settlement agreements, loaded from data/tax/deals.json. Entirely
  // data-driven: no country-specific logic lives in the calc functions — adding
  // a country is a one-line edit to that JSON. See dealFor().
  let deals = { version: 0, byCode: {}, default: { irishRebate: 0, foreignRebate: 0 } };
  // Paper transfer-tax state (see PAPER_RATE). All global, not per-factory, so
  // they're cheap enough to fetch even in the lightweight log-first render.
  let allies = new Set();     // Ireland's ally country IDs → 50% paper rate
  let paperMarket = null;     // current market paper price (lowest ask), or null if untraded
  let paperOverride = null;   // manual paper price the user typed (wins over market)
  let lastRows = null, lastMeta = null;   // remembered so a paper-price edit can re-render

  const it_trpc = (ep, inp) => trpc(ep, inp, { retry: true, timeoutMs: 20000 });
  const money  = (v) => (v == null || !isFinite(v)) ? '–' : v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  const moneyK = (v) => (v == null || !isFinite(v)) ? '–' : (Math.abs(v) >= 1000 ? (v / 1000).toFixed(2) + 'K' : v.toFixed(2));

  async function mapConcurrent(items, worker, concurrency = 20) {
    const out = new Array(items.length); let i = 0;
    async function pump() {
      while (i < items.length) { const idx = i++; try { out[idx] = await worker(items[idx], idx); } catch { out[idx] = null; } }
    }
    await Promise.all(Array(Math.min(concurrency, items.length || 1)).fill(0).map(pump));
    return out;
  }

  // Look up a host country's agreement by ISO code (case-insensitive).
  // No agreement → the default (0 / 0), so un-negotiated countries owe nothing.
  function dealFor(code) {
    const d = code ? deals.byCode[String(code).toUpperCase()] : null;
    return d || deals.default;
  }

  // Parse data/tax/deals.json into { version, byCode, default }. A missing or
  // malformed file leaves the safe default (no agreements) in place.
  async function loadDeals() {
    const raw = await fetchJson('data/tax/deals.json');
    if (!raw) return;
    const def = { irishRebate: 0, foreignRebate: 0, ...(raw.default || {}) };
    const byCode = {};
    for (const [code, deal] of Object.entries(raw.countries || {})) {
      byCode[String(code).toUpperCase()] = {
        irishRebate:   Number(deal.irishRebate   ?? def.irishRebate),
        foreignRebate: Number(deal.foreignRebate ?? def.foreignRebate),
      };
    }
    deals = { version: Number(raw.version || 0), byCode, default: def };
  }

  // The paper price actually used: a manual override if set, else the market.
  function paperPrice() { return paperOverride != null ? paperOverride : paperMarket; }
  function isAlly(countryId) { return allies.has(countryId); }

  // Paper transfer tax for moving `amount` money from Ireland's settlement out
  // to / in from `countryId`. Returns the paper units required, the money cost
  // to acquire them, and the amount net of that cost. cost/net are null when the
  // paper price is unknown (untraded and no manual override).
  function paperFor(countryId, amount) {
    const ally = isAlly(countryId);
    const rate = ally ? PAPER_RATE.ally : PAPER_RATE.other;
    const units = (amount || 0) * rate;
    const price = paperPrice();
    const cost = price != null ? units * price : null;
    const net  = cost != null ? (amount || 0) - cost : null;
    return { ally, rate, units, price, cost, net };
  }

  // Ireland's current ally list (country IDs), for the 50% vs 100% paper rate.
  async function loadAllies() {
    const ie = await it_trpc('country.getCountryById', { countryId: IRELAND_COUNTRY_ID }).catch(() => null);
    allies = new Set(Array.isArray(ie?.allies) ? ie.allies : []);
  }

  // Current market price of paper = the lowest sell order (what it costs to buy
  // paper now). Null if paper isn't trading, in which case the user can type a
  // manual price. Mirrors orderLowestOffer() in js/daily-profit.js.
  async function loadPaperPrice() {
    const ob = await it_trpc('tradingOrder.getTopOrders', { itemCode: PAPER_ITEM }).catch(() => null);
    let ask = Infinity;
    for (const o of (ob?.sellOrders || [])) if (typeof o.price === 'number' && o.price < ask) ask = o.price;
    paperMarket = isFinite(ask) ? ask : null;
  }

  async function fetchJson(url) {
    try {
      const res = await fetch(`${url}?t=${Math.floor(Date.now() / 30000)}`, { cache: 'no-cache' });
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  }

  async function fetchIrishCitizens(onProgress) {
    const out = []; let cursor, safety = 0;
    while (safety++ < 200) {
      const input = { countryId: IRELAND_COUNTRY_ID, limit: PAGE_LIMIT };
      if (cursor) input.cursor = cursor;
      const page = await it_trpc('user.getUsersByCountry', input);
      const arr = page?.items ?? page?.data ?? (Array.isArray(page) ? page : []);
      for (const u of arr) if (u?._id) { out.push(u._id); if (u.username) nameById[u._id] = u.username; homeCountryById[u._id] = IRELAND_COUNTRY_ID; }
      onProgress?.(out.length);
      const next = page?.nextCursor ?? page?.cursor ?? null;
      if (!next || arr.length === 0) break;
      cursor = next;
    }
    return out;
  }

  // Wages this owner actually paid in the last 24h, bucketed PER WORKER (by
  // sellerId) so each worker's tax can later be split by their citizenship for
  // the settlement calc. Only workers that map to one of this owner's factories
  // (present in workerToCompany) are counted.
  async function paidWagesByWorker(ownerId, workerToCompany) {
    const cutoff = Date.now() - WAGE_WINDOW_MS;
    const byWorker = {};
    let cursor = null, pages = 0, older = false;
    while (pages < WAGE_MAX_PAGES && !older) {
      const input = { userId: ownerId, transactionType: 'wage', limit: 100 };
      if (cursor) input.cursor = cursor;
      const page = await it_trpc('transaction.getPaginatedTransactions', input).catch(() => null);
      if (!page) break;
      const items = page.items || page.data || [];
      for (const tx of items) {
        if (new Date(tx.createdAt).getTime() < cutoff) { older = true; continue; }
        if (tx.buyerId !== ownerId) continue;
        if (!workerToCompany.has(tx.sellerId)) continue;
        byWorker[tx.sellerId] = (byWorker[tx.sellerId] || 0) + (tx.money || 0);
      }
      cursor = page.nextCursor ?? null;
      pages++;
      if (!cursor || !items.length) break;
    }
    return byWorker;
  }

  /* ── Tax logger report ─────────────────────────────────────────── */
  function thisMonday(d) {
    const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const dow = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() - (dow - 1));
    return t;
  }
  function isoDate(d) { return d.toISOString().slice(0, 10); }

  async function loadCurrentLog() {
    currentLog = await fetchJson('data/tax/current_week.json');
    return currentLog;
  }

  // Lazily loads the current (in-progress) week + up to 4 archived weeks
  // before it. Missing archives (fewer than 5 weeks of history so far)
  // are simply skipped.
  async function loadWeekLogs() {
    if (weekLogs) return weekLogs;
    const out = [];
    if (currentLog) out.push({ weekStart: currentLog.week_start, data: currentLog });
    const monday = currentLog ? new Date(currentLog.week_start) : thisMonday(new Date());
    const candidates = [];
    for (let i = 1; i <= 4; i++) {
      const m = new Date(monday); m.setUTCDate(m.getUTCDate() - 7 * i);
      candidates.push(isoDate(m));
    }
    const fetched = await mapConcurrent(candidates, async (ws) => fetchJson(`data/tax/weeks/${ws}.json`), 5);
    candidates.forEach((ws, i) => { if (fetched[i]) out.push({ weekStart: ws, data: fetched[i] }); });
    weekLogs = out;
    return weekLogs;
  }

  function renderLogReport() {
    if (!currentLog || !currentLog.days || !currentLog.days.length) {
      $logReport.innerHTML = `<div class="tax-log-report dim">Tax logger: no daily snapshots recorded yet.</div>`;
      return;
    }
    const days = currentLog.days;
    const lastDay = days[days.length - 1]?.date;
    const totals = Object.values(currentLog.totals || {});
    const totalTax = totals.reduce((s, c) => s + (c.tax || 0), 0);
    const totalRebate = totals.reduce((s, c) => s + (c.manual_rebate_due || 0), 0);
    $logReport.innerHTML = `
      <div class="tax-log-report">
        <span class="tax-log-icon">📋</span>
        <span><strong>Settlement log:</strong> week of ${escapeHtml(currentLog.week_start)}
        · ${days.length} day${days.length === 1 ? '' : 's'} logged
        · ₿${moneyK(totalRebate)} owed to Ireland so far
        · ₿${moneyK(totalTax)} gross tax
        · last snapshot ${escapeHtml(lastDay || '–')}</span>
      </div>`;
  }

  async function load() {
    $refresh.disabled = true;
    $summary.innerHTML = '';
    $table.innerHTML = '';
    $logReport.innerHTML = '';
    setStatus('');
    steps.reset();
    setTrpcCache(true);
    nameById = {};
    homeCountryById = {};
    homeCountryInfoById = {};
    weekLogs = null;

    try {
      // Kick off the log + agreement fetches in parallel with the live pipeline.
      const logPromise = loadCurrentLog().then(renderLogReport);
      const dealsPromise = loadDeals();
      const paperPromise = Promise.all([loadAllies(), loadPaperPrice()]);

      // 1) Irish citizens
      steps.setStep(1, 'active', { sub: 'Paginating the citizen list' });
      const citizens = await fetchIrishCitizens(n => steps.setStep(1, 'active', { count: `${n} loaded` }));
      steps.setStep(1, 'done', { count: `${citizens.length} citizens` });

      // 2) Their owned factories that employ workers
      steps.setStep(2, 'active', { sub: 'Pulling owned factories & workers', count: `0/${citizens.length}` });
      const factories = {};          // companyId -> { id, name, itemCode, ownerId, workers: [ids] }
      const ownerWorkerCompany = {}; // ownerId  -> Map(workerId -> companyId)
      const owners = [];
      let d2 = 0;
      await mapConcurrent(citizens, async (cid) => {
        const res = await it_trpc('worker.getWorkers', { userId: cid }).catch(() => null);
        d2++; steps.setStep(2, 'active', { count: `${d2}/${citizens.length}` });
        const wpc = res?.workersPerCompany || [];
        const wmap = new Map();
        let has = false;
        for (const entry of wpc) {
          const co = entry?.company;
          const compId = co?._id || (typeof co === 'string' ? co : null);
          const workers = entry?.workers || [];
          if (!compId || !workers.length) continue;
          has = true;
          const f = factories[compId] || (factories[compId] = { id: compId, name: co?.name || null, itemCode: co?.itemCode || null, ownerId: cid, workers: [] });
          for (const w of workers) {
            const uid = w?.user || w?._id || (typeof w === 'string' ? w : null);
            if (uid) { f.workers.push(uid); wmap.set(uid, compId); }
          }
        }
        if (has) { owners.push(cid); ownerWorkerCompany[cid] = wmap; }
      }, 20);
      const companyIds = Object.keys(factories);
      steps.setStep(2, 'done', { count: `${companyIds.length} factories · ${owners.length} Irish owners` });

      if (!companyIds.length) { steps.fadeOut(300); setStatus('No Irish-owned factories with workers found.'); await logPromise; return; }

      // 3) Factory location → country → income-tax rate
      steps.setStep(3, 'active', { sub: 'Loading factory locations & tax rates' });
      const compById = {};
      await mapConcurrent(companyIds, async (id) => {
        const co = await it_trpc('company.getById', { companyId: id }).catch(() => null);
        if (co) compById[id] = co;
      }, 20);
      const [regionsObj, allCountriesRaw] = await Promise.all([
        it_trpc('region.getRegionsObject', {}),
        it_trpc('country.getAllCountries', {}),
      ]);
      const allCountries = Array.isArray(allCountriesRaw) ? allCountriesRaw : (allCountriesRaw?.items || []);
      const countryById = {};
      await mapConcurrent(allCountries, async (c) => {
        const f = await it_trpc('country.getCountryById', { countryId: c._id }).catch(() => null);
        if (f) countryById[c._id] = f;
      }, 25);
      for (const id of companyIds) {
        const co = compById[id];
        const region = co ? regionsObj[co.region] : null;
        factories[id].countryId = region ? region.country : null;
      }
      steps.setStep(3, 'done', { count: `${Object.keys(countryById).length} countries` });

      // 4) Actual wages paid (last 24h), per owner, bucketed by worker
      steps.setStep(4, 'active', { sub: 'Summing wages actually paid (24h)', count: `0/${owners.length}` });
      const workerWages = {};   // workerId -> wages paid in the window
      let d4 = 0;
      await mapConcurrent(owners, async (ownerId) => {
        const byWorker = await paidWagesByWorker(ownerId, ownerWorkerCompany[ownerId]);
        for (const wid in byWorker) workerWages[wid] = (workerWages[wid] || 0) + byWorker[wid];
        d4++; steps.setStep(4, 'active', { count: `${d4}/${owners.length}` });
      }, 8);

      // 5) Resolve worker usernames for the drill-down (citizens already known)
      const workerIds = new Set();
      for (const id of companyIds) for (const w of factories[id].workers) workerIds.add(w);
      const unknown = [...workerIds].filter(id => !nameById[id]);
      steps.setStep(4, 'active', { sub: 'Resolving worker usernames', count: `0/${unknown.length}` });
      let dn = 0;
      await mapConcurrent(unknown, async (id) => {
        const u = await it_trpc('user.getUserLite', { userId: id }).catch(() => null);
        if (u?.username) nameById[id] = u.username;
        const hc = u?.country ?? u?.countryId ?? null;
        if (hc) homeCountryById[id] = hc;
        if (++dn % 20 === 0) steps.setStep(4, 'active', { count: `${dn}/${unknown.length}` });
      }, 20);
      steps.setStep(4, 'done', { count: `${owners.length} owners · ${workerIds.size} workers` });
      steps.fadeOut(400);

      // Flag/name lookup for each distinct worker home country, used by the
      // "View workers" drill-down to show where each worker's 30% goes.
      for (const hcId of new Set(Object.values(homeCountryById))) {
        const c = countryById[hcId];
        if (c) homeCountryInfoById[hcId] = { name: c.name || '—', code: c.code || c.iso || null };
      }

      await dealsPromise;

      // Aggregate per country (settlement) + keep the factory list for the
      // drill-down. Iterate factory → worker so each worker's tax is attributed
      // to their citizenship and the host country's agreement. No country-specific
      // logic here — rebate rates come entirely from deals.json (dealFor()).
      const agg = {};
      for (const id of companyIds) {
        const f = factories[id];
        const c = f.countryId ? countryById[f.countryId] : null;
        if (!c) continue;
        const rate = (c.taxes?.income ?? 0);
        const code = c.code || c.iso || null;
        const deal = dealFor(code);
        const a = agg[f.countryId] || (agg[f.countryId] = {
          id: f.countryId, name: c.name || '—', code, rate,
          factories: 0, workers: 0, irishWorkers: 0, foreignWorkers: 0,
          wages: 0, tax: 0, irishWorkerTax: 0, foreignWorkerTax: 0, rebate: 0,
          dealVersion: deals.version, facList: [],
        });
        a.factories++;
        a.workers += f.workers.length;
        let facWages = 0;
        for (const wid of f.workers) {
          const w = workerWages[wid] || 0;
          facWages += w;
          const tax = w * (rate / 100);
          a.wages += w;
          a.tax   += tax;
          if (homeCountryById[wid] === IRELAND_COUNTRY_ID) {
            a.irishWorkers++;
            a.irishWorkerTax += tax;
            a.rebate += tax * deal.irishRebate;
          } else {
            a.foreignWorkers++;
            a.foreignWorkerTax += tax;
            a.rebate += tax * deal.foreignRebate;
          }
        }
        a.facList.push({ id, name: f.name, itemCode: f.itemCode, ownerId: f.ownerId, workers: f.workers, wages: facWages });
      }
      // Host country keeps gross − automatic 30% remittance − manual rebate.
      // Rank by settlement owed to Ireland, then gross tax as a tiebreaker.
      const rows = Object.values(agg)
        .map(a => ({ ...a, hostRetained: a.tax * (1 - AUTO_REMIT) - a.rebate }))
        .sort((x, y) => y.rebate - x.rebate || y.tax - x.tax);
      await Promise.all([logPromise, paperPromise]);
      render(rows, { factories: companyIds.length, source: 'live' });
    } catch (e) {
      steps.markActiveAsError(e.message);
      setStatus(`Error: ${e.message}`, true);
    } finally {
      $refresh.disabled = false;
      setTrpcCache(false);
    }
  }

  /* ── Render ─────────────────────────────────────────────── */
  function flagOf(code) { return (code && code.length === 2) ? flag(code) : '🏳️'; }
  function userLink(id) {
    const n = nameById[id] || ('user ' + String(id).slice(-4));
    return `<a href="${GAME_BASE}/user/${escapeHtml(id)}" target="_blank" rel="noopener">${escapeHtml(n)}</a>`;
  }
  // Each worker's HOME country — where their 30% tax remittance actually
  // goes, as opposed to the factory's (host) country this whole table is
  // grouped by. Shown as a small flag badge next to their name.
  function workerLink(id) {
    const hcId = homeCountryById[id];
    const info = hcId ? homeCountryInfoById[hcId] : null;
    if (!info) return userLink(id);
    return `${userLink(id)} <span class="tax-worker-flag" title="Home: ${escapeHtml(info.name)}">${flagOf(info.code)}</span>`;
  }
  function workersHtml(country) {
    const facs = (country.facList || []).slice().sort((a, b) => b.workers.length - a.workers.length);
    // Log-sourced rows carry no per-worker data (the logger stores only
    // aggregates). Prompt for a live pull instead of showing an empty list.
    if (!facs.length) {
      return `<div class="tax-detail-wrap"><button class="tax-back" data-back="${country.id}">← back to options</button>
        <div class="tax-dim" style="font-size:12.5px;padding:4px 0;line-height:1.6;">Worker-level detail isn't stored in the daily settlement log. Click <strong>Refresh (live)</strong> at the top to pull the current per-worker breakdown from the game.</div></div>`;
    }
    return `<div class="tax-detail-wrap"><button class="tax-back" data-back="${country.id}">← back to options</button>${facs.map(f => `
      <div class="tax-fac">
        <div class="tax-fac-h">
          <a class="tax-fac-name" href="${GAME_BASE}/company/${escapeHtml(f.id)}" target="_blank" rel="noopener">🏭 ${escapeHtml(f.name || f.itemCode || 'factory')}</a>
          <span class="tax-fac-meta">owner: ${userLink(f.ownerId)} · ${f.workers.length} worker${f.workers.length === 1 ? '' : 's'} · ₿${money(f.wages)}/day</span>
        </div>
        <div class="tax-fac-workers">${f.workers.length ? f.workers.map(workerLink).join('<span class="tax-sep">·</span>') : '<span class="tax-dim">no current workers</span>'}</div>
      </div>`).join('')}</div>`;
  }

  function menuHtml(countryId) {
    return `<div class="tax-menu-wrap">
      <button class="tax-menu-opt" data-action="workers" data-c="${countryId}">👷 View workers</button>
      <button class="tax-menu-opt" data-action="week-gross" data-c="${countryId}">📅 This week's Gross tax</button>
      <button class="tax-menu-opt" data-action="week-rebate" data-c="${countryId}">💰 This week's Settlement</button>
      <button class="tax-menu-opt" data-action="weeks-gross" data-c="${countryId}">📈 Last 5 weeks Gross</button>
      <button class="tax-menu-opt" data-action="weeks-rebate" data-c="${countryId}">💵 Last 5 weeks Settlement</button>
    </div>`;
  }

  function backHtml(countryId) {
    return `<button class="tax-back" data-back="${countryId}">← back to options</button>`;
  }

  /* ── Mini trend chart (styled like the Wealth Monitor's chart) ──── */
  function niceNum(range, round) {
    if (range <= 0 || !isFinite(range)) return 1;
    const exp = Math.floor(Math.log10(range));
    const f = range / Math.pow(10, exp);
    const nf = round ? (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) : (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10);
    return nf * Math.pow(10, exp);
  }
  function yDomain(values) {
    let min = Infinity, max = -Infinity;
    for (const v of values) { if (v < min) min = v; if (v > max) max = v; }
    if (!isFinite(min)) return { min: 0, max: 1, step: 1 };
    if (max === min) { const p = Math.abs(max) * 0.1 || 1; min -= p; max += p; }
    else { const p = (max - min) * 0.08; min -= p; max += p; }
    min = Math.max(0, min);
    const step = niceNum((max - min) / 4, true);
    const niceMin = Math.floor(min / step) * step;
    let niceMax = Math.ceil(max / step) * step;
    if (niceMax <= niceMin) niceMax = niceMin + step;
    return { min: niceMin, max: niceMax, step };
  }
  function fmtTick(v, step) {
    const a = Math.abs(v);
    if (a >= 1000 || (a === 0 && step >= 1000)) {
      const dp = Math.min(3, Math.max(0, Math.ceil(-Math.log10(step / 1000))));
      return (v / 1000).toFixed(dp) + 'K';
    }
    const dp = Math.min(2, Math.max(0, Math.ceil(-Math.log10(step || 1))));
    return v.toFixed(dp);
  }

  // Shared plot geometry between trendChartHtml (build) and wireTaxTrendHover
  // (hover/touch), so the x(i) mapping used to locate the nearest point
  // matches what was actually drawn.
  const TREND_W = 860, TREND_H = 260, TREND_M = { top: 14, right: 14, bottom: 26, left: 52 };

  // Renders one gradient line chart (₿ tax on y, labels on x) — same visual
  // language as .wm-chart in js/wealth.js, sized to sit inside the drill-down.
  // Returns { html, labels, values } so the caller can wire up a hover/touch
  // tooltip (see wireTaxTrendHover) once the html is in the DOM.
  function trendChartHtml(labels, values, emptyMsg) {
    const n = labels.length;
    const have = values.filter(v => v != null).length;
    if (!n || have === 0) return { html: `<div class="wm-chart-empty">${escapeHtml(emptyMsg)}</div>`, labels: [], values: [] };
    if (have === 1) return { html: `<div class="wm-chart-empty">Only one data point logged so far — check back after another snapshot.</div>`, labels: [], values: [] };

    const W = TREND_W, H = TREND_H, M = TREND_M;
    const PW = W - M.left - M.right, PH = H - M.top - M.bottom;
    const x = i => M.left + (n === 1 ? PW / 2 : (i / (n - 1)) * PW);
    const { min: yMin, max: yMax, step } = yDomain(values.filter(v => v != null));
    const y = v => M.top + PH - ((v - yMin) / (yMax - yMin || 1)) * PH;

    let svg = '';
    const ticks = Math.max(1, Math.round((yMax - yMin) / step));
    for (let i = 0; i <= ticks; i++) {
      const val = yMin + step * i, yy = y(val);
      svg += `<line class="wm-grid-line" x1="${M.left}" y1="${yy.toFixed(1)}" x2="${M.left + PW}" y2="${yy.toFixed(1)}"/>`;
      svg += `<text class="wm-axis-text" x="${M.left - 8}" y="${(yy + 3).toFixed(1)}" text-anchor="end">₿${fmtTick(val, step)}</text>`;
    }
    const xstep = Math.max(1, Math.ceil(n / 8));
    for (let i = 0; i < n; i += xstep) {
      svg += `<text class="wm-axis-text" x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${escapeHtml(labels[i])}</text>`;
    }

    let line = '', firstX = null, lastX = null;
    for (let i = 0; i < n; i++) {
      if (values[i] == null) continue;
      const px = x(i), py = y(values[i]);
      line += `${firstX === null ? 'M' : 'L'}${px.toFixed(1)} ${py.toFixed(1)}`;
      if (firstX === null) firstX = px;
      lastX = px;
    }
    if (firstX !== null) {
      const area = `${line} L${lastX.toFixed(1)} ${(M.top + PH).toFixed(1)} L${firstX.toFixed(1)} ${(M.top + PH).toFixed(1)} Z`;
      svg += `<defs><linearGradient id="taxg" x1="0" y1="0" x2="0" y2="1">`
        + `<stop offset="0" stop-color="#4ade80" stop-opacity="0.28"/>`
        + `<stop offset="1" stop-color="#4ade80" stop-opacity="0"/></linearGradient></defs>`
        + `<path d="${area}" fill="url(#taxg)" stroke="none"/>`
        + `<path class="wm-series-line" d="${line}" stroke="#4ade80"/>`;
    }
    svg += `<line class="wm-hover-line" x1="0" y1="${M.top}" x2="0" y2="${M.top + PH}" style="display:none"/>`;
    const html = `<svg class="wm-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">${svg}</svg><div class="wm-tooltip"></div>`;
    return { html, labels, values };
  }

  // Wires a hover (mouse) / touch tooltip onto a rendered trend chart,
  // mirroring wireHover() in js/wealth.js for a single-series line chart.
  function wireTaxTrendHover(container, labels, values, seriesLabel) {
    const svg = container?.querySelector('svg.wm-chart');
    const hl = container?.querySelector('.wm-hover-line');
    const tt = container?.querySelector('.wm-tooltip');
    if (!svg || !hl || !tt || !labels.length) return;

    const n = labels.length;
    const PW = TREND_W - TREND_M.left - TREND_M.right;
    const x = i => TREND_M.left + (n === 1 ? PW / 2 : (i / (n - 1)) * PW);

    function locate(clientX) {
      const r = svg.getBoundingClientRect();
      const sx = (clientX - r.left) / r.width * TREND_W;
      let best = 0, bestD = Infinity;
      for (let i = 0; i < n; i++) { const d = Math.abs(x(i) - sx); if (d < bestD) { bestD = d; best = i; } }
      return best;
    }
    function show(clientX) {
      const i = locate(clientX);
      hl.setAttribute('x1', x(i)); hl.setAttribute('x2', x(i)); hl.style.display = '';
      const v = values[i];
      tt.innerHTML = v == null
        ? `<div class="wm-tt-date">${escapeHtml(labels[i])} · no data</div>`
        : `<div class="wm-tt-date">${escapeHtml(labels[i])}</div><div class="wm-tt-row"><span class="wm-dot" style="background:#4ade80"></span>${escapeHtml(seriesLabel)}<span class="wm-tt-val">₿${money(v)}</span></div>`;
      positionTip(i);
    }
    function positionTip(i) {
      const r = svg.getBoundingClientRect();
      const px = x(i) / TREND_W * r.width;
      const left = Math.min(Math.max(px + 12, 4), r.width - tt.offsetWidth - 4);
      tt.style.left = `${left}px`; tt.style.top = `8px`; tt.style.opacity = 1;
    }
    svg.addEventListener('mousemove', e => show(e.clientX));
    svg.addEventListener('touchstart', e => { if (e.touches[0]) show(e.touches[0].clientX); }, { passive: true });
    svg.addEventListener('touchmove', e => { if (e.touches[0]) show(e.touches[0].clientX); }, { passive: true });
    svg.addEventListener('mouseleave', () => { tt.style.opacity = 0; hl.style.display = 'none'; });
  }

  // This week's daily snapshots, either gross tax or the settlement (manual
  // rebate) owed to Ireland. Day entries logged before the settlement schema
  // simply have no rebate field → 0.
  async function weekTrendHtml(countryId, metric) {
    if (!currentLog || !currentLog.days) return { html: `<div class="wm-chart-empty">No tax log data yet.</div>`, labels: [], values: [] };
    const labels = currentLog.days.map(d => d.date.slice(5)); // MM-DD
    const values = currentLog.days.map(d => {
      const c = (d.countries || []).find(c => c.id === countryId);
      if (!c) return null;
      return metric === 'rebate' ? (c.manual_rebate_due ?? 0) : c.tax;
    });
    return trendChartHtml(labels, values, 'No daily tax snapshots logged yet for this country this week.');
  }

  // Last 5 weeks' totals, either gross tax or the settlement owed to Ireland.
  async function fiveWeekTrendHtml(countryId, metric) {
    const logs = await loadWeekLogs();
    if (!logs.length) return { html: `<div class="wm-chart-empty">No weekly tax log data yet.</div>`, labels: [], values: [] };
    const ordered = logs.slice().sort((a, b) => a.weekStart.localeCompare(b.weekStart));
    const labels = ordered.map(w => w.weekStart.slice(5));
    const values = ordered.map(w => {
      const totals = w.data.totals || {};
      const c = totals[countryId];
      if (!c) return null;
      return metric === 'rebate' ? (c.manual_rebate_due ?? 0) : c.tax;
    });
    return trendChartHtml(labels, values, 'No weekly tax log data yet for this country.');
  }

  /* ── Detail panel (shared by the log render and the live render) ──────
     These are module-scoped, and the single delegated table click handler
     (onTableClick, wired exactly once at the bottom of the IIFE) reads the
     current rows from `taxById`. render() can therefore run any number of
     times — initial log render, then a live "Refresh" — without stacking
     duplicate listeners. */
  let taxById = {};   // countryId -> current row object (log- or live-sourced)

  // This week's accrued settlement per country, from the daily logger totals.
  function loggedRebate(countryId) { return currentLog?.totals?.[countryId]?.manual_rebate_due; }

  function openDetail(countryId, html) {
    const row = $table.querySelector(`.tax-row[data-c="${countryId}"]`);
    const det = $table.querySelector(`.tax-detail[data-detail="${countryId}"] > td`);
    if (!det) return null;
    det.innerHTML = html;
    det.closest('.tax-detail').classList.add('open');
    row?.classList.add('open');
    return det;
  }
  function closeDetail(countryId) {
    const row = $table.querySelector(`.tax-row[data-c="${countryId}"]`);
    const det = $table.querySelector(`.tax-detail[data-detail="${countryId}"]`);
    det?.classList.remove('open');
    row?.classList.remove('open');
  }
  // The country panel: the settlement audit (Irish vs non-Irish breakdown +
  // today's/weekly settlement) followed by the options menu. This is the
  // audit trail for how every value in the row was calculated.
  function showCountry(countryId) {
    const country = taxById[countryId];
    if (!country) return;
    openDetail(countryId, auditHtml(country) + menuHtml(countryId));
  }

  // Renders the per-country settlement audit. Splits the row's rebate back
  // into the Irish-worker and non-Irish-worker components so every figure is
  // traceable to the agreement's two rates.
  function auditHtml(c) {
    const deal = dealFor(c.code);
    const irishRebate   = c.irishWorkerTax   * deal.irishRebate;
    const foreignRebate = c.foreignWorkerTax * deal.foreignRebate;
    const weekRebate = loggedRebate(c.id);
    const pct = (x) => `${(x * 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;

    // Paper transfer tax on paying the settlement (see PAPER_RATE). Ireland is
    // the collector, so its own row never sends money out → no paper block.
    const isHome = c.id === IRELAND_COUNTRY_ID;
    const pToday = isHome ? null : paperFor(c.id, c.rebate);
    const pWeek  = (isHome || weekRebate == null) ? null : paperFor(c.id, weekRebate);
    const paperBlock = pToday ? `
      <div class="tax-audit-tot">
        <div class="tax-audit-h">📄 Paper transfer tax <span class="tax-ally ${pToday.ally ? 'yes' : ''}">${pToday.ally ? 'ally · 50%' : 'non-ally · 100%'}</span></div>
        <div class="tax-audit-row"><span>Paper price</span><b>${pToday.price != null ? '₿' + money(pToday.price) + '/unit' : '—'}</b></div>
        <div class="tax-audit-row big"><span>Net owed today (after paper)</span><b>${pToday.net != null ? '₿' + money(pToday.net) : '—'}</b></div>
        <div class="tax-audit-row"><span>Paper cost (this week)</span><b>${pWeek && pWeek.cost != null ? '−₿' + money(pWeek.cost) : '—'}</b></div>
        <div class="tax-audit-row"><span>Net this week (after paper)</span><b>${pWeek && pWeek.net != null ? '₿' + money(pWeek.net) : '—'}</b></div>
      </div>` : '';

    return `<div class="tax-audit">
      <div class="tax-audit-grid">
        <div class="tax-audit-cat">
          <div class="tax-audit-h">🇮🇪 Irish workers <span class="tax-audit-rate">rebate ${pct(deal.irishRebate)}</span></div>
          <div class="tax-audit-row"><span>Workers</span><b>${c.irishWorkers}</b></div>
          <div class="tax-audit-row"><span>Gross tax</span><b>₿${money(c.irishWorkerTax)}</b></div>
          <div class="tax-audit-row"><span>Manual rebate</span><b>₿${money(irishRebate)}</b></div>
        </div>
        <div class="tax-audit-cat">
          <div class="tax-audit-h">🌍 Non-Irish workers <span class="tax-audit-rate">rebate ${pct(deal.foreignRebate)}</span></div>
          <div class="tax-audit-row"><span>Workers</span><b>${c.foreignWorkers}</b></div>
          <div class="tax-audit-row"><span>Gross tax</span><b>₿${money(c.foreignWorkerTax)}</b></div>
          <div class="tax-audit-row"><span>Manual rebate</span><b>₿${money(foreignRebate)}</b></div>
        </div>
      </div>
      <div class="tax-audit-tot">
        <div class="tax-audit-row big"><span>Today's settlement owed to Ireland</span><b>₿${money(c.rebate)}</b></div>
        <div class="tax-audit-row big"><span>This week's settlement (logged)</span><b>₿${money(weekRebate)}</b></div>
      </div>
      ${paperBlock}
      <div class="tax-audit-note">Gross tax ₿${money(c.tax)}/day · income-tax rate ${c.rate}% · deals.json v${c.dealVersion}. Excludes the game's automatic 30% remittance (that returns to each worker's own country and is not part of the settlement). Host keeps ≈ ₿${money(c.hostRetained)}/day.</div>
    </div>`;
  }

  // Loads a trend chart, renders it, then wires up its hover/touch tooltip
  // — each data point's value is shown on click/tap (mobile) as well as
  // hover, mirroring the wealth-monitor chart in js/wealth.js.
  async function showTrend(cid, title, loader, seriesLabel) {
    openDetail(cid, backHtml(cid) + `<div class="tax-chart-title">${escapeHtml(title)}</div>` + '<div class="wm-chart-box">Loading…</div>');
    const { html, labels, values } = await loader(cid);
    const det = openDetail(cid, backHtml(cid) + `<div class="tax-chart-title">${escapeHtml(title)}</div>` + `<div class="wm-chart-box">${html}</div>`);
    const box = det?.querySelector('.wm-chart-box');
    if (box) wireTaxTrendHover(box, labels, values, seriesLabel);
  }

  // The one and only table click handler (row toggle + menu options + back).
  // Wired once — never inside render() — so repeated renders can't duplicate it.
  async function onTableClick(e) {
    const back = e.target.closest('[data-back]');
    if (back) { e.stopPropagation(); showCountry(back.dataset.back); return; }

    const opt = e.target.closest('.tax-menu-opt');
    if (opt) {
      e.stopPropagation();
      const cid = opt.dataset.c;
      const country = taxById[cid];
      if (!country) return;
      const action = opt.dataset.action;
      if (action === 'workers') {
        openDetail(cid, backHtml(cid) + workersHtml(country));
      } else if (action === 'week-gross') {
        await showTrend(cid, "This week's Gross tax, logged daily", id => weekTrendHtml(id, 'gross'), 'Gross tax');
      } else if (action === 'week-rebate') {
        await showTrend(cid, "This week's Settlement owed to Ireland, logged daily", id => weekTrendHtml(id, 'rebate'), 'Settlement');
      } else if (action === 'weeks-gross') {
        await showTrend(cid, 'Last 5 weeks, Gross tax total', id => fiveWeekTrendHtml(id, 'gross'), 'Gross tax');
      } else if (action === 'weeks-rebate') {
        await showTrend(cid, 'Last 5 weeks, Settlement total', id => fiveWeekTrendHtml(id, 'rebate'), 'Settlement');
      }
      return;
    }

    // Country row: open (and reset to) the audit + options panel, or close.
    const row = e.target.closest('.tax-row');
    if (row) {
      const cid = row.dataset.c;
      if (row.classList.contains('open')) closeDetail(cid);
      else showCountry(cid);
    }
  }

  // Renders the cards + main table from a set of country rows. `meta.source`
  // is 'log' (daily snapshot) or 'live' (just-pulled), used only for the banner.
  function render(rows, meta) {
    if (!rows.length) { setStatus('No settlement data to show.'); return; }
    setStatus('');
    lastRows = rows; lastMeta = meta;   // so editing the paper price can re-render

    const ie = rows.find(r => r.id === IRELAND_COUNTRY_ID);
    const ieFactories = ie ? ie.factories : 0;
    const foreignFactories = meta.factories - ieFactories;
    const rebateToday = rows.reduce((s, r) => s + (r.rebate || 0), 0);
    const settlementWeek = Object.values(currentLog?.totals || {})
      .reduce((s, c) => s + (c.manual_rebate_due || 0), 0);
    const agreements = Object.keys(deals.byCode).length;

    $summary.innerHTML = `
      <div class="tax-cards">
        <div class="tax-card"><div class="tax-card-v">${meta.factories}</div><div class="tax-card-l">Irish-owned factories<span>${foreignFactories} abroad · ${ieFactories} in Ireland</span></div></div>
        <div class="tax-card"><div class="tax-card-v">${agreements}</div><div class="tax-card-l">active tax agreements<span>deals.json v${deals.version}</span></div></div>
        <div class="tax-card ok"><div class="tax-card-v">₿${moneyK(rebateToday)}</div><div class="tax-card-l">settlement owed to Ireland today<span>manual rebate under agreements</span></div></div>
        <div class="tax-card ok"><div class="tax-card-v">₿${moneyK(settlementWeek)}</div><div class="tax-card-l">settlement accrued this week<span>ready to transfer · from the logger</span></div></div>
      </div>`;

    taxById = {};
    rows.forEach(r => { taxById[r.id] = r; });

    const srcBanner = meta.source === 'live'
      ? `<div class="tax-src live">🔴 <span><strong>Live</strong> — pulled just now (rolling last 24h). Worker drill-down available.</span></div>`
      : `<div class="tax-src">📅 <span>Showing the latest daily snapshot (<strong>${escapeHtml(meta.date || '—')}</strong>) from the settlement log — no live API calls. Click <strong>Refresh (live)</strong> for current figures and the per-worker drill-down.</span></div>`;

    const pp = paperPrice();
    const paperBar = `<div class="tax-paperbar">📄 <span><strong>Paper transfer tax</strong> on settlement payments — <strong>50%</strong> to allies · <strong>100%</strong> to others (paid in paper, on top of the amount). Paper price ${pp != null ? '₿' + money(pp) + '/unit' : '<em>untraded — set a price above</em>'} ${paperOverride != null ? '(manual)' : '(market)'} · ${allies.size} ${allies.size === 1 ? 'ally' : 'allies'} on file.</span></div>`;

    // Per-row paper transfer tax on "Rebate Today". Ireland (home) collects the
    // settlement, so it never sends money to itself — no paper tax there.
    const paperCell = (r) => {
      if (r.id === IRELAND_COUNTRY_ID) return { paper: '<span class="tax-dim">—</span>', net: '<span class="tax-dim">—</span>' };
      const p = paperFor(r.id, r.rebate);
      const badge = `<span class="tax-ally ${p.ally ? 'yes' : ''}">${p.ally ? 'ally 50%' : '100%'}</span>`;
      const paper = p.cost != null
        ? `₿${money(p.cost)} ${badge}`
        : `${money(p.units)}📄 ${badge}`;
      const net = p.net != null ? `₿${money(p.net)}` : '<span class="tax-dim">—</span>';
      return { paper, net };
    };

    $table.innerHTML = srcBanner + paperBar + `
      <div class="tax-table-wrap"><table class="tax-tbl">
        <thead><tr>
          <th class="l">Country</th>
          <th>Factories</th>
          <th>Workers</th>
          <th title="Total wage tax generated today by this country's Irish-owned factories (Irish + non-Irish workers)">Gross Tax / Day</th>
          <th title="Manual rebate owed to Ireland today under the agreement — excludes the game's automatic 30% remittance">Rebate Today</th>
          <th title="Paper transfer tax on paying today's rebate: 50% (ally) or 100% of the amount, in paper units, priced at the current market rate">Paper Tax</th>
          <th title="Rebate Today minus the paper transfer cost — what settling today's amount nets after the paper tax">Net Owed</th>
          <th title="Settlement accrued so far this week (sum of daily rebate snapshots from the logger). Resets each Monday.">Settlement This Week</th>
        </tr></thead>
        <tbody>${rows.map(r => { const pc = paperCell(r); return `
          <tr class="tax-row" data-c="${r.id}" title="Click for the settlement audit">
            <td class="l"><span class="tax-caret">▸</span> ${flagOf(r.code)} ${escapeHtml(r.name)}${r.id === IRELAND_COUNTRY_ID ? ' <span class="tax-home-tag">home</span>' : ''}</td>
            <td>${r.factories}</td>
            <td>${r.workers}</td>
            <td>₿${money(r.tax)}</td>
            <td><strong>₿${money(r.rebate)}</strong></td>
            <td>${pc.paper}</td>
            <td>${pc.net}</td>
            <td>₿${money(loggedRebate(r.id))}</td>
          </tr>
          <tr class="tax-detail" data-detail="${r.id}"><td colspan="8"></td></tr>`; }).join('')}</tbody>
      </table></div>
      <p class="tax-note">This is a settlement calculator: it shows how much each country owes Ireland under the negotiated rebate agreements in <code>data/tax/deals.json</code> (v${deals.version}). "Gross Tax / Day" is the wage tax those factories generated in a day (estimated — wage transactions carry no tax line, so each country's income-tax rate is applied to wages actually paid). "Rebate Today" is the additional manual rebate owed to Ireland — the game already auto-remits 30% of every worker's tax to their citizenship country, and that automatic transfer is excluded here. "Paper Tax" is the separate <em>Send money to country</em> transfer tax, paid in paper on top of the amount sent — 50% of the amount (in paper units) for allies, 100% for everyone else — priced here at the current paper market rate; "Net Owed" deducts that cost from the rebate. "Settlement This Week" accrues the daily rebate snapshots the logger records (resets each Monday). Click any country for the full audit.</p>`;
  }

  // Build rows straight from the latest daily snapshot in the settlement log —
  // no live API calls. Every displayed value (gross, rebate, worker split, host
  // retained) is stored per-day by tax_log.py; only the per-worker drill-down is
  // absent (aggregates only), which the live Refresh fills in.
  function renderFromLog() {
    const day = currentLog?.days?.[currentLog.days.length - 1];
    if (!currentLog || !day || !(day.countries || []).length) {
      $table.innerHTML = '';
      $summary.innerHTML = '';
      setStatus('No settlement snapshots logged yet. Click “Refresh (live)” to pull current data from the game.');
      return;
    }
    const rows = day.countries.map(c => ({
      id: c.id, name: c.name, code: c.code, rate: c.rate,
      factories: c.factories || 0, workers: c.workers || 0,
      irishWorkers: c.irish_workers || 0, foreignWorkers: c.foreign_workers || 0,
      wages: c.wages || 0, tax: c.tax || 0,
      irishWorkerTax: c.irish_worker_tax || 0, foreignWorkerTax: c.foreign_worker_tax || 0,
      rebate: c.manual_rebate_due || 0,
      hostRetained: c.host_retained ?? (c.tax * (1 - AUTO_REMIT) - (c.manual_rebate_due || 0)),
      dealVersion: c.deal_version ?? deals.version,
      facList: [],   // aggregates only — the log doesn't store individual workers
    })).sort((x, y) => y.rebate - x.rebate || y.tax - x.tax);
    render(rows, {
      factories: rows.reduce((s, r) => s + r.factories, 0),
      source: 'log',
      date: day.date,
    });
  }

  // First open: render instantly from the settlement log (deals + current_week),
  // no live API. The four-step live pipeline runs only when the user clicks
  // "Refresh (live)" — for current-minute figures and the worker drill-down.
  async function init() {
    $summary.innerHTML = '';
    $table.innerHTML = '';
    $logReport.innerHTML = '';
    setStatus('Loading settlement log…');
    // Static, same-origin JSON — fast and available even if the game API is down.
    await Promise.all([loadDeals(), loadCurrentLog()]);
    renderLogReport();
    renderFromLog();
    // Paper price + allies are live market data. Fetch them in the background so
    // the log view stays instant (and works during an API outage); re-render the
    // paper columns once they arrive.
    Promise.all([loadAllies(), loadPaperPrice()]).then(() => { if (lastRows) render(lastRows, lastMeta); });
  }

  // Manual paper-price override: re-cost the transfer tax and re-render in place
  // (the input lives in the header, so re-rendering the table won't drop focus).
  const $paperPrice = document.getElementById('taxdev-paper-price');
  $paperPrice.addEventListener('input', () => {
    const v = $paperPrice.value.trim();
    paperOverride = (v === '' || !isFinite(+v) || +v < 0) ? null : +v;
    if (lastRows) render(lastRows, lastMeta);
  });

  // Wire the single delegated table handler exactly once (not per render).
  $table.addEventListener('click', onTableClick);
  $refresh.addEventListener('click', load);

  return {
    activate() { if (!loaded) { loaded = true; init(); } },
  };
})();
