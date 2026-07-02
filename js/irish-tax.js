/* ═══════════════════════════════════════════════════════════════════
 *  IRISH FACTORY TAX  (standalone #tax view)
 *
 *  Irish-OWNED factories that employ workers, grouped by the country the
 *  factory sits in, showing the income-tax rate that country takes off
 *  those workers' wages — and how much tax that amounts to per day.
 *
 *  Each country row, when clicked, opens a small options menu instead of
 *  jumping straight to a drill-down:
 *    - View workers        factory → owner → workers, every name linked
 *                           to its in-game profile.
 *    - This week's trend    daily tax for that country, from the logger.
 *    - Last 5 weeks trend   weekly tax for that country, from the logger.
 *
 *  Trend data comes from the tax_log.py daily snapshots:
 *    data/tax/current_week.json      — this week's days + running totals
 *    data/tax/weeks/YYYY-MM-DD.json  — archived completed weeks
 *
 *  A "tax log report" card up top summarises what the logger has recorded
 *  so far this week (days logged, total tax logged, last update), and the
 *  table's "Logged this week" column shows each country's running total
 *  from the same source.
 *
 *  Chart styling/logic (gradient line chart) is copied from the Wealth
 *  Monitor's wealth-over-time chart (js/wealth.js) and reuses its .wm-*
 *  CSS classes.
 *
 *  Pipeline (live data, unchanged):
 *    1. Paginate all Irish citizens (the pool of possible owners; also
 *       gives us their usernames for free).
 *    2. worker.getWorkers per citizen → the factories they OWN that have
 *       workers, plus each worker (with their wage + which company).
 *    3. Dedup factories → company.getById → region; region → country
 *       (regionsObject); country → income-tax rate (getCountryById).
 *    4. Sum wages each owner ACTUALLY paid in the last 24h (their wage
 *       transactions as buyer), attributed to each worker's factory.
 *    5. Resolve worker usernames (lite profiles) for the drill-down.
 *
 *  Tax is an ESTIMATE: wage transactions carry no tax line, so we apply
 *  the factory-country's income-tax rate to the wages actually paid.
 * ═══════════════════════════════════════════════════════════════════ */
const IrishTaxTool = (() => {
  const PAGE_LIMIT     = 100;
  const WAGE_WINDOW_MS = 24 * 3600 * 1000;
  const WAGE_MAX_PAGES = 5;

  const $refresh = document.getElementById('tax-refresh');
  const $summary = document.getElementById('tax-summary');
  const $logReport = document.getElementById('tax-log-report');
  const $table   = document.getElementById('tax-table');
  const steps    = makeSteps(document.getElementById('tax-steps'));
  const setStatus = makeStatus(document.getElementById('tax-status'));

  let loaded = false;
  let nameById = {};   // userId -> username (citizens free; workers resolved)
  let currentLog = null;      // parsed data/tax/current_week.json
  let weekLogs = null;        // [{ weekStart, data }], lazy-loaded

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
      for (const u of arr) if (u?._id) { out.push(u._id); if (u.username) nameById[u._id] = u.username; }
      onProgress?.(out.length);
      const next = page?.nextCursor ?? page?.cursor ?? null;
      if (!next || arr.length === 0) break;
      cursor = next;
    }
    return out;
  }

  async function paidWagesByCompany(ownerId, workerToCompany) {
    const cutoff = Date.now() - WAGE_WINDOW_MS;
    const byCompany = {};
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
        const cid = workerToCompany.get(tx.sellerId);
        if (!cid) continue;
        byCompany[cid] = (byCompany[cid] || 0) + (tx.money || 0);
      }
      cursor = page.nextCursor ?? null;
      pages++;
      if (!cursor || !items.length) break;
    }
    return byCompany;
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
    const totalTax = Object.values(currentLog.totals || {}).reduce((s, c) => s + (c.tax || 0), 0);
    $logReport.innerHTML = `
      <div class="tax-log-report">
        <span class="tax-log-icon">📋</span>
        <span><strong>Tax log:</strong> week of ${escapeHtml(currentLog.week_start)}
        · ${days.length} day${days.length === 1 ? '' : 's'} logged
        · ₿${moneyK(totalTax)} tax logged so far
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
    weekLogs = null;
    recentDays = null;

    try {
      // Kick off the log fetch in parallel with the live pipeline.
      const logPromise = loadCurrentLog().then(renderLogReport);

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

      // 4) Actual wages paid (last 24h), per owner, bucketed by factory
      steps.setStep(4, 'active', { sub: 'Summing wages actually paid (24h)', count: `0/${owners.length}` });
      const companyWages = {};
      let d4 = 0;
      await mapConcurrent(owners, async (ownerId) => {
        const byCo = await paidWagesByCompany(ownerId, ownerWorkerCompany[ownerId]);
        for (const cid in byCo) companyWages[cid] = (companyWages[cid] || 0) + byCo[cid];
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
        if (++dn % 20 === 0) steps.setStep(4, 'active', { count: `${dn}/${unknown.length}` });
      }, 20);
      steps.setStep(4, 'done', { count: `${owners.length} owners · ${workerIds.size} workers` });
      steps.fadeOut(400);

      // Aggregate per country (+ keep the factory list for the drill-down)
      const agg = {};
      for (const id of companyIds) {
        const f = factories[id];
        const c = f.countryId ? countryById[f.countryId] : null;
        if (!c) continue;
        const a = agg[f.countryId] || (agg[f.countryId] = {
          id: f.countryId, name: c.name || '—', code: c.code || c.iso || null,
          rate: (c.taxes?.income ?? 0), factories: 0, workers: 0, wages: 0, facList: [],
        });
        a.factories++;
        a.workers += f.workers.length;
        a.wages   += (companyWages[id] || 0);
        a.facList.push({ id, name: f.name, itemCode: f.itemCode, ownerId: f.ownerId, workers: f.workers, wages: companyWages[id] || 0 });
      }
      const rows = Object.values(agg)
        .map(a => ({ ...a, tax: a.wages * (a.rate / 100) }))
        .sort((x, y) => y.tax - x.tax || y.factories - x.factories);
      await logPromise;
      render(rows, { factories: companyIds.length });
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
  function workersHtml(country) {
    const facs = country.facList.slice().sort((a, b) => b.workers.length - a.workers.length);
    return `<div class="tax-detail-wrap"><button class="tax-back" data-back="${country.id}">← back to options</button>${facs.map(f => `
      <div class="tax-fac">
        <div class="tax-fac-h">
          <a class="tax-fac-name" href="${GAME_BASE}/company/${escapeHtml(f.id)}" target="_blank" rel="noopener">🏭 ${escapeHtml(f.name || f.itemCode || 'factory')}</a>
          <span class="tax-fac-meta">owner: ${userLink(f.ownerId)} · ${f.workers.length} worker${f.workers.length === 1 ? '' : 's'} · ₿${money(f.wages)}/day</span>
        </div>
        <div class="tax-fac-workers">${f.workers.length ? f.workers.map(userLink).join('<span class="tax-sep">·</span>') : '<span class="tax-dim">no current workers</span>'}</div>
      </div>`).join('')}</div>`;
  }

  function menuHtml(countryId) {
    return `<div class="tax-menu-wrap">
      <button class="tax-menu-opt" data-action="workers" data-c="${countryId}">👷 View workers</button>
      <button class="tax-menu-opt" data-action="days" data-c="${countryId}">📆 5 day trend</button>
      <button class="tax-menu-opt" data-action="week" data-c="${countryId}">📅 This week's trend</button>
      <button class="tax-menu-opt" data-action="weeks" data-c="${countryId}">📈 Last 5 weeks trend</button>
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

  async function weekTrendHtml(countryId) {
    if (!currentLog || !currentLog.days) return { html: `<div class="wm-chart-empty">No tax log data yet.</div>`, labels: [], values: [] };
    const labels = currentLog.days.map(d => d.date.slice(5)); // MM-DD
    const values = currentLog.days.map(d => {
      const c = (d.countries || []).find(c => c.id === countryId);
      return c ? c.tax : null;
    });
    return trendChartHtml(labels, values, 'No daily tax snapshots logged yet for this country this week.');
  }

  // Last 5 daily snapshots of net tax retained (70% of tax), pulling from
  // the previous archived week if the current week doesn't have 5 days yet.
  let recentDays = null; // lazy-loaded, up to last 5 day entries { date, countries }
  async function loadRecentDays() {
    if (recentDays) return recentDays;
    const days = currentLog?.days ? currentLog.days.slice() : [];
    if (days.length < 5) {
      const monday = currentLog ? new Date(currentLog.week_start) : thisMonday(new Date());
      const prevMonday = new Date(monday); prevMonday.setUTCDate(prevMonday.getUTCDate() - 7);
      const prevWeek = await fetchJson(`data/tax/weeks/${isoDate(prevMonday)}.json`);
      if (prevWeek?.days) days.unshift(...prevWeek.days);
    }
    days.sort((a, b) => a.date.localeCompare(b.date));
    recentDays = days.slice(-5);
    return recentDays;
  }

  async function fiveDayTrendHtml(countryId) {
    const days = await loadRecentDays();
    if (!days.length) return { html: `<div class="wm-chart-empty">No daily tax snapshots logged yet.</div>`, labels: [], values: [] };
    const labels = days.map(d => d.date.slice(5)); // MM-DD
    const values = days.map(d => {
      const c = (d.countries || []).find(c => c.id === countryId);
      return c ? (c.net_tax_retained ?? c.tax * 0.7) : null;
    });
    return trendChartHtml(labels, values, 'No daily tax snapshots logged yet for this country.');
  }

  async function fiveWeekTrendHtml(countryId) {
    const logs = await loadWeekLogs();
    if (!logs.length) return { html: `<div class="wm-chart-empty">No weekly tax log data yet.</div>`, labels: [], values: [] };
    const ordered = logs.slice().sort((a, b) => a.weekStart.localeCompare(b.weekStart));
    const labels = ordered.map(w => w.weekStart.slice(5));
    const values = ordered.map(w => {
      const totals = w.data.totals || {};
      const c = totals[countryId];
      return c ? c.tax : null;
    });
    return trendChartHtml(labels, values, 'No weekly tax log data yet for this country.');
  }

  function render(rows, meta) {
    if (!rows.length) { setStatus('No located Irish-owned factories found.'); return; }

    const ie = rows.find(r => r.id === IRELAND_COUNTRY_ID);
    const ieFactories = ie ? ie.factories : 0, ieTax = ie ? ie.tax : 0;
    const foreignFactories = meta.factories - ieFactories;
    const foreignTax = rows.reduce((s, r) => s + (r.id === IRELAND_COUNTRY_ID ? 0 : r.tax), 0);
    const totalTax = rows.reduce((s, r) => s + r.tax, 0);
    const leakPct = totalTax > 0 ? (foreignTax / totalTax) * 100 : 0;

    $summary.innerHTML = `
      <div class="tax-cards">
        <div class="tax-card"><div class="tax-card-v">${meta.factories}</div><div class="tax-card-l">Irish-owned factories<span>employing workers</span></div></div>
        <div class="tax-card"><div class="tax-card-v">${foreignFactories}</div><div class="tax-card-l">based abroad<span>${ieFactories} in Ireland</span></div></div>
        <div class="tax-card warn"><div class="tax-card-v">₿${moneyK(foreignTax)}</div><div class="tax-card-l">daily wage tax to foreign countries<span>${leakPct.toFixed(0)}% of all wage tax paid</span></div></div>
        <div class="tax-card ok"><div class="tax-card-v">₿${moneyK(ieTax)}</div><div class="tax-card-l">daily wage tax staying in Ireland</div></div>
      </div>`;

    const loggedTax = (countryId) => currentLog?.totals?.[countryId]?.tax;

    $table.innerHTML = `
      <div class="tax-table-wrap"><table class="tax-tbl">
        <thead><tr>
          <th class="l">Factory country</th>
          <th>Factories</th>
          <th>Workers</th>
          <th title="Income-tax rate this country takes off wages">Tax rate</th>
          <th title="Wages these factories actually paid in the last 24h">Daily wages</th>
          <th title="Daily wages × tax rate">Tax / day</th>
          <th title="70% of tax / day — the share the host country keeps. The other 30% returns to each worker's home country">Nett Tax Retained</th>
          <th title="Sum of this country's daily tax snapshots so far this week, from the tax logger">Logged this week</th>
        </tr></thead>
        <tbody>${rows.map(r => `
          <tr class="tax-row" data-c="${r.id}" title="Click for options">
            <td class="l"><span class="tax-caret">▸</span> ${flagOf(r.code)} ${escapeHtml(r.name)}${r.id === IRELAND_COUNTRY_ID ? ' <span class="tax-home-tag">home</span>' : ''}</td>
            <td>${r.factories}</td>
            <td>${r.workers}</td>
            <td>${r.rate}%</td>
            <td>₿${money(r.wages)}</td>
            <td><strong>₿${money(r.tax)}</strong></td>
            <td>₿${money(r.tax * 0.7)}</td>
            <td>₿${money(loggedTax(r.id))}</td>
          </tr>
          <tr class="tax-detail" data-detail="${r.id}"><td colspan="8"></td></tr>`).join('')}</tbody>
      </table></div>
      <p class="tax-note">Tax is estimated: wage transactions carry no tax line, so each country's income-tax rate is applied to the wages its Irish-owned factories actually paid in the last 24h. Of that tax, 30% returns to each worker's home country and 70% is retained by the host country — the "Nett Tax Retained" column. "Logged this week" totals the daily tax snapshots the logger has recorded so far this week (resets each Monday). Click any country for options — workers, 5-day trend, this week's trend, or the last 5 weeks — sourced from the daily tax logger. Factories are matched to a country via their region.</p>`;

    const byId = {};
    rows.forEach(r => { byId[r.id] = r; });

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
    function showMenu(countryId) { openDetail(countryId, menuHtml(countryId)); }

    // Country row: open (and reset to) the options menu, or close if already open.
    $table.querySelectorAll('.tax-row').forEach(row => {
      row.addEventListener('click', () => {
        const cid = row.dataset.c;
        if (row.classList.contains('open')) { closeDetail(cid); return; }
        showMenu(cid);
      });
    });

    // Menu options + back-to-menu, delegated on the table.
    $table.addEventListener('click', async (e) => {
      const back = e.target.closest('[data-back]');
      if (back) { e.stopPropagation(); showMenu(back.dataset.back); return; }

      const opt = e.target.closest('.tax-menu-opt');
      if (!opt) return;
      e.stopPropagation();
      const cid = opt.dataset.c;
      const country = byId[cid];
      if (!country) return;
      const action = opt.dataset.action;
      if (action === 'workers') {
        openDetail(cid, backHtml(cid) + workersHtml(country));
      } else if (action === 'days') {
        await showTrend(cid, 'Last 5 days, nett tax retained', fiveDayTrendHtml, 'Nett tax retained');
      } else if (action === 'week') {
        await showTrend(cid, 'This week’s tax, logged daily', weekTrendHtml, 'Tax');
      } else if (action === 'weeks') {
        await showTrend(cid, 'Last 5 weeks, logged tax total', fiveWeekTrendHtml, 'Tax');
      }
    });

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
  }

  $refresh.addEventListener('click', load);

  return {
    activate() { if (!loaded) { loaded = true; load(); } },
  };
})();
