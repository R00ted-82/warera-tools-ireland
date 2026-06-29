/* ═══════════════════════════════════════════════════════════════════
 *  IRISH FACTORY TAX  (standalone #tax view)
 *
 *  Irish-OWNED factories that employ workers, grouped by the country the
 *  factory sits in, showing the income-tax rate that country takes off
 *  those workers' wages — and how much tax that amounts to per day.
 *
 *  Each country row expands (click) to a drill-down of the factories
 *  there: factory → owner → workers, every name linked to its in-game
 *  profile.
 *
 *  Pipeline:
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
  const $table   = document.getElementById('tax-table');
  const steps    = makeSteps(document.getElementById('tax-steps'));
  const setStatus = makeStatus(document.getElementById('tax-status'));

  let loaded = false;
  let nameById = {};   // userId -> username (citizens free; workers resolved)

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

  async function load() {
    $refresh.disabled = true;
    $summary.innerHTML = '';
    $table.innerHTML = '';
    setStatus('');
    steps.reset();
    setTrpcCache(true);
    nameById = {};

    try {
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

      if (!companyIds.length) { steps.fadeOut(300); setStatus('No Irish-owned factories with workers found.'); return; }

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
  function detailHtml(country) {
    const facs = country.facList.slice().sort((a, b) => b.workers.length - a.workers.length);
    return `<div class="tax-detail-wrap">${facs.map(f => `
      <div class="tax-fac">
        <div class="tax-fac-h">
          <a class="tax-fac-name" href="${GAME_BASE}/company/${escapeHtml(f.id)}" target="_blank" rel="noopener">🏭 ${escapeHtml(f.name || f.itemCode || 'factory')}</a>
          <span class="tax-fac-meta">owner: ${userLink(f.ownerId)} · ${f.workers.length} worker${f.workers.length === 1 ? '' : 's'} · ₿${money(f.wages)}/day</span>
        </div>
        <div class="tax-fac-workers">${f.workers.length ? f.workers.map(userLink).join('<span class="tax-sep">·</span>') : '<span class="tax-dim">no current workers</span>'}</div>
      </div>`).join('')}</div>`;
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

    $table.innerHTML = `
      <table class="tax-tbl">
        <thead><tr>
          <th class="l">Factory country</th>
          <th>Factories</th>
          <th>Workers</th>
          <th title="Income-tax rate this country takes off wages">Tax rate</th>
          <th title="Wages these factories actually paid in the last 24h">Daily wages</th>
          <th title="Daily wages × tax rate">Tax / day</th>
        </tr></thead>
        <tbody>${rows.map(r => `
          <tr class="tax-row" data-c="${r.id}" title="Click for the factories & workers">
            <td class="l"><span class="tax-caret">▸</span> ${flagOf(r.code)} ${escapeHtml(r.name)}${r.id === IRELAND_COUNTRY_ID ? ' <span class="tax-home-tag">home</span>' : ''}</td>
            <td>${r.factories}</td>
            <td>${r.workers}</td>
            <td>${r.rate}%</td>
            <td>₿${money(r.wages)}</td>
            <td><strong>₿${money(r.tax)}</strong></td>
          </tr>
          <tr class="tax-detail" data-detail="${r.id}"><td colspan="6">${detailHtml(r)}</td></tr>`).join('')}</tbody>
      </table>
      <p class="tax-note">Tax is estimated: wage transactions carry no tax line, so each country's income-tax rate is applied to the wages its Irish-owned factories actually paid in the last 24h. Click any country to see its factories, owners and workers. Factories are matched to a country via their region.</p>`;

    // Expand/collapse a country's drill-down.
    $table.querySelectorAll('.tax-row').forEach(row => {
      row.addEventListener('click', () => {
        const det = $table.querySelector(`.tax-detail[data-detail="${row.dataset.c}"]`);
        if (!det) return;
        const open = det.classList.toggle('open');
        row.classList.toggle('open', open);
      });
    });
  }

  $refresh.addEventListener('click', load);

  return {
    activate() { if (!loaded) { loaded = true; load(); } },
  };
})();
