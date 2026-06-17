/* ═══════════════════════════════════════════════════════════════════
 *  DAILY PROFIT  (powers the #profit view inside the shell)
 *  Extracted from the standalone daily-profit.html on merge. Self-
 *  contained IIFE; the shell drives it via DailyProfitTool.activate({u}).
 * ═══════════════════════════════════════════════════════════════════ */
const DailyProfitTool = (() => {
  const WS_BASE = (typeof WARERASTATS_BASE !== 'undefined') ? WARERASTATS_BASE : 'https://warera-proxy.toie.workers.dev/warerastats';
  // Prices via the proxy (it adds CORS) — a direct api.warerastats.io fetch
  // is blocked cross-origin in the browser, even though /countries via the
  // proxy works.
  const ITEMS_URL = `${WS_BASE}/items`;
  // Works/day per energy point: 10%/hr recovery × 24h ÷ 10 energy-per-work = 0.24.
  // Verified against the sheet: Pintman 31×100×0.24×1.10(fid) = 818.4 PP/day.
  const WORK_FACTOR = 0.24;
  const RECENT_KEY = 'dp:recent-usernames';
  const RECENT_MAX = 8;

  // Display name + category, matching the in-game / spreadsheet labels.
  const META = {
    iron:      { name: 'Iron',        cat: 'Construction' },
    steel:     { name: 'Steel',       cat: 'Construction' },
    limestone: { name: 'Limestone',   cat: 'Construction' },
    concrete:  { name: 'Concrete',    cat: 'Construction' },
    paper:     { name: 'Paper',       cat: 'Construction' },
    wood:      { name: 'Wood',        cat: 'Construction' },
    oil:       { name: 'Oil',         cat: 'Construction' },
    petroleum: { name: 'Petroleum',   cat: 'Construction' },
    fish:      { name: 'Fish',        cat: 'Food' },
    steak:     { name: 'Steak',       cat: 'Food' },
    grain:     { name: 'Grain',       cat: 'Food' },
    cookedFish:{ name: 'Cooked Fish', cat: 'Food' },
    livestock: { name: 'Cow',         cat: 'Food' },
    bread:     { name: 'Bread',       cat: 'Food' },
    lead:      { name: 'Lead',        cat: 'War' },
    coca:      { name: 'Plant',       cat: 'War' },
    lightAmmo: { name: 'Light Ammo',  cat: 'War' },
    ammo:      { name: 'Ammo',        cat: 'War' },
    cocain:    { name: 'Pill',        cat: 'War' },
    heavyAmmo: { name: 'Heavy Ammo',  cat: 'War' },
  };
  const ICON_FILE = {
    paper:'paper.png',iron:'iron.png',steel:'steel.png',limestone:'limestone.png',concrete:'concrete.png',
    wood:'wood.png',oil:'oil.png',petroleum:'petroleum.png',fish:'fish.png',steak:'steak.png',grain:'grain.png',
    cookedFish:'cookedFish.png',livestock:'livestock.png',bread:'bread.png',lead:'lead.png',
    coca:'coca.png',lightAmmo:'lightAmmo.png',ammo:'ammo.png',cocain:'cocain.png',heavyAmmo:'heavyAmmo.png',
  };

  // ── Advisor's verified production-bonus model (see js/advisor.js) ──
  const AGRARIAN_ITEMS = new Set(['steak','bread','fish','cookedFish','livestock','grain','coca','cocain']);
  let GAME_DEPOSIT_BONUS = 30;
  const isDepositActive = (d) => {
    if (!d) return false;
    const now = Date.now();
    const s = d.startsAt ? new Date(d.startsAt).getTime() : 0;
    const e = d.endsAt ? new Date(d.endsAt).getTime() : 0;
    return now >= s && now <= e;
  };
  const ethicsLean = (c) => {
    const ind = c?.industrialism;
    if (typeof ind !== 'number' || ind === 0) return 'neutral';
    return ind > 0 ? 'industrialist' : 'agrarian';
  };
  function computeBonus(country, region, itemCode) {
    if (!country) return null;
    const isSpec = country.specializedItem === itemCode;
    const lean = ethicsLean(country);
    const strategic = isSpec ? (country.strategicResources?.bonuses?.productionPercent || 0) : 0;
    const specialisation = isSpec && lean === 'industrialist' && !AGRARIAN_ITEMS.has(itemCode) ? 30 : 0;
    const hasDep = !!region?.deposit && region.deposit.type === itemCode && isDepositActive(region.deposit)
      && !(isSpec && lean === 'industrialist');
    const deposit = hasDep ? (region.deposit.bonusPercent || 0) : 0;
    const depositCountry = hasDep && lean === 'agrarian' ? GAME_DEPOSIT_BONUS : 0;
    const total = strategic + specialisation + deposit + depositCountry;
    const tax = country.taxes?.income ?? 0;
    // Surface whether the bonus leans on a temporary regional deposit (these
    // expire — region.deposit has startsAt/endsAt), so the table can flag it.
    const dep = hasDep ? { bonus: deposit + depositCountry, endsAt: region.deposit.endsAt, type: region.deposit.type } : null;
    return { total, tax, region, country, deposit: dep };
  }

  // ── DOM ─────────────────────────────────────────────────────────
  const $username = document.getElementById('dp-username');
  const $submit   = document.getElementById('dp-submit');
  const $recent   = document.getElementById('dp-recent');
  const $status   = document.getElementById('dp-status');
  const $statsCard= document.getElementById('dp-stats-card');
  const $tableCard= document.getElementById('dp-table-card');
  const $statsHead= document.getElementById('dp-stats-head');
  const $assump   = document.getElementById('dp-assump');
  const $income   = document.getElementById('dp-income');
  const $table    = document.getElementById('dp-table');
  const $tableNote= document.getElementById('dp-table-note');
  const $compCard = document.getElementById('dp-comp-card');
  const $companies= document.getElementById('dp-companies');
  const $empCard  = document.getElementById('dp-emp-card');
  const $empSub   = document.getElementById('dp-emp-sub');
  const $employees= document.getElementById('dp-employees');
  const steps     = makeSteps(document.getElementById('dp-steps'));

  // ── State ───────────────────────────────────────────────────────
  let model = null;
  const dp_trpc = (ep, input) => trpc(ep, input, { retry: true });

  // ── Helpers ─────────────────────────────────────────────────────
  const fmt2 = (v) => (v == null || !isFinite(v)) ? '–' : v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmt3 = (v) => (v == null || !isFinite(v)) ? '–' : v.toLocaleString(undefined, { minimumFractionDigits: 3, maximumFractionDigits: 3 });
  const fmtK = (v) => (v == null || !isFinite(v)) ? '–' : (Math.abs(v) >= 1000 ? (v/1000).toFixed(2) + 'K' : v.toFixed(2));
  const fmtDate = (iso) => { try { return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }); } catch { return '?'; } };
  const fmtPP = (v) => (v == null || !isFinite(v)) ? '–' : v.toLocaleString(undefined, { maximumFractionDigits: 1 });

  function showStatus(level, html) { $status.className = `bf-inline-status ${level}`; $status.innerHTML = html; $status.classList.remove('hidden'); }
  function hideStatus() { $status.classList.add('hidden'); $status.innerHTML = ''; }

  async function fetchJsonUrl(url) {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
  async function mapConcurrent(items, worker, concurrency = 12) {
    const out = new Array(items.length); let i = 0;
    async function pump() { while (i < items.length) { const idx = i++; try { out[idx] = await worker(items[idx]); } catch { out[idx] = null; } } }
    await Promise.all(Array(Math.min(concurrency, items.length || 1)).fill(0).map(pump));
    return out;
  }

  async function resolveUsername(username) {
    const needle = username.trim().toLowerCase();
    if (!needle) return null;
    const res = await dp_trpc('search.searchAnything', { searchText: username });
    const ids = (res?.userIds || []).slice(0, 10);
    if (!ids.length) return null;
    const profiles = await mapConcurrent(ids, async (id) => { try { return await dp_trpc('user.getUserLite', { userId: id }); } catch { return null; } });
    return profiles.find(u => u && typeof u.username === 'string' && u.username.toLowerCase() === needle) || null;
  }

  function skill(u, name) {
    const sk = u?.skills?.[name];
    if (!sk || typeof sk !== 'object') return 0;
    for (const k of ['total','value','level']) { const n = sk[k]; if (typeof n === 'number' && isFinite(n)) return n; }
    return 0;
  }

  // Representative price from an order book: midpoint of best bid/ask
  // (falls back to whichever side exists). Matches the warerastats avg well.
  function orderMid(d) {
    const bo = d?.buyOrders || [], so = d?.sellOrders || [];
    let bid = -Infinity, ask = Infinity;
    for (const o of bo) if (typeof o.price === 'number' && o.price > bid) bid = o.price;
    for (const o of so) if (typeof o.price === 'number' && o.price < ask) ask = o.price;
    const hasBid = isFinite(bid), hasAsk = isFinite(ask);
    if (hasBid && hasAsk) return (bid + ask) / 2;
    if (hasAsk) return ask;
    if (hasBid) return bid;
    return null;
  }

  // Lowest live sell offer (best ask) — the "buy it now" price the game shows.
  function orderLowestOffer(d) {
    const so = d?.sellOrders || [];
    let ask = Infinity;
    for (const o of so) if (typeof o.price === 'number' && o.price < ask) ask = o.price;
    return isFinite(ask) ? ask : null;
  }

  // Salary = wages the user RECEIVED in the last 24h. Wage transactions are
  // trades: sellerId is the worker (sold labour), buyerId the employer. So we
  // sum `money` for wage txns where sellerId === the user. (Same source as
  // the Clock-In tool.) Paginates back until older than 24h.
  async function dailySalary(userId) {
    const cutoff = Date.now() - 86400000;
    let cursor = null, pages = 0, total = 0, count = 0, older = false;
    while (pages < 6 && !older) {
      const input = { userId, transactionType: 'wage', limit: 100 };
      if (cursor) input.cursor = cursor;
      const page = await dp_trpc('transaction.getPaginatedTransactions', input).catch(() => null);
      if (!page) break;
      const items = page.items || page.data || [];
      for (const tx of items) {
        if (new Date(tx.createdAt).getTime() < cutoff) { older = true; continue; }
        if (tx.sellerId === userId) { total += (tx.money || 0); count++; }
      }
      cursor = page.nextCursor ?? null;
      pages++;
      if (!cursor || !items.length) break;
    }
    return { total, count };
  }

  // ── Recent chips (mirrors the shell) ────────────────────────────
  const readRecent = () => { try { const a = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); return Array.isArray(a) ? a.filter(x => typeof x === 'string') : []; } catch { return []; } };
  const writeRecent = (l) => { try { localStorage.setItem(RECENT_KEY, JSON.stringify(l.slice(0, RECENT_MAX))); } catch {} };
  function rememberUsername(u) { const l = readRecent().filter(x => x.toLowerCase() !== u.toLowerCase()); l.unshift(u); writeRecent(l); renderRecent(); }
  function forgetUsername(n) { writeRecent(readRecent().filter(x => x.toLowerCase() !== n.toLowerCase())); renderRecent(); }
  function renderRecent() {
    const l = readRecent();
    if (!l.length) { $recent.innerHTML = ''; $recent.classList.add('hidden'); return; }
    $recent.classList.remove('hidden');
    $recent.innerHTML = `<span class="stg-recent-label">Recent:</span>` + l.map(u => {
      const s = escapeHtml(u);
      return `<span class="stg-recent-chip"><button class="stg-recent-pick" data-dp-recent="${s}">${s}</button><button class="stg-recent-del" data-dp-recent-del="${s}" title="Remove">×</button></span>`;
    }).join('');
  }

  // ── Load + compute ──────────────────────────────────────────────
  async function handleSubmit() {
    const raw = $username.value.trim();
    if (!raw) { showStatus('warn', 'Please enter an in-game username.'); $username.focus(); return; }

    $submit.disabled = true;
    $statsCard.classList.add('hidden');
    $tableCard.classList.add('hidden');
    hideStatus();
    steps.reset();

    try {
      steps.setStep(1, 'active', { sub: `Searching for "${raw}"` });
      let user;
      try { user = await resolveUsername(raw); }
      catch (e) {
        steps.markActiveAsError('Lookup failed');
        throw new Error(isTransientError(e) ? `The data server is having a moment (${e.message}). Try again shortly.` : `Username lookup failed: ${e.message}`);
      }
      if (!user) { steps.markActiveAsError('No user found'); throw new Error(`No War Era user found with username "${raw}".`); }
      enforceIrishOnly(user.country ?? user.countryId, user.username);
      steps.setStep(1, 'done', { count: `→ ${user.username}` });
      try { window.history.replaceState(null, '', `#profit?u=${encodeURIComponent(user.username)}`); } catch {}
      rememberUsername(user.username);

      // Step 2: companies + workers
      steps.setStep(2, 'active', { sub: 'Fetching companies' });
      const [companyList, workersData, salaryInfo] = await Promise.all([
        dp_trpc('company.getCompanies', { userId: user._id, perPage: 100 }),
        dp_trpc('worker.getWorkers', { userId: user._id }).catch(() => null),
        dailySalary(user._id),
      ]);
      const companyIds = companyList?.items || [];
      steps.setStep(2, 'active', { sub: 'Loading company details', count: `0/${companyIds.length}` });
      let loaded = 0;
      const allCompanies = (await mapConcurrent(companyIds, async (id) => {
        const c = await dp_trpc('company.getById', { companyId: id }).catch(() => null);
        steps.setStep(2, 'active', { count: `${++loaded}/${companyIds.length}` });
        return c;
      })).filter(Boolean);
      // Disabled companies (those with a `disabledAt` timestamp) produce nothing
      // and aren't worked — exclude them from every calculation.
      const companies   = allCompanies.filter(c => !c.disabledAt);
      const disabledCount = allCompanies.length - companies.length;

      const workerEntries = [];
      (workersData?.workersPerCompany || []).forEach(({ company, workers }) => {
        (workers || []).forEach(w => { if (w && w.user) workerEntries.push({ companyId: company?._id, userId: w.user, wage: w.wage, fidelity: w.fidelity }); });
      });
      const uniqueWorkerIds = [...new Set(workerEntries.map(w => w.userId).filter(id => id !== user._id))];
      const workerProfiles = {};
      await mapConcurrent(uniqueWorkerIds, async (id) => {
        const lite = await dp_trpc('user.getUserLite', { userId: id }).catch(() => null);
        if (lite) workerProfiles[id] = lite;
      });
      steps.setStep(2, 'done', { count: `${companies.length} active${disabledCount ? ` · ${disabledCount} disabled` : ''}` });

      // Step 3: market + bonuses
      steps.setStep(3, 'active', { sub: 'Loading market, regions & countries' });
      const [itemsArr, gameConfig, regionsObj, allCountriesRaw, wsCountries] = await Promise.all([
        fetchJsonUrl(ITEMS_URL).catch(() => []),
        dp_trpc('gameConfig.getGameConfig', {}).catch(() => null),
        dp_trpc('region.getRegionsObject', {}),
        dp_trpc('country.getAllCountries', {}),
        fetch(`${WS_BASE}/countries`).then(r => r.json()).catch(() => []),
      ]);
      const gameItems = gameConfig?.items || {};
      // Pricing. The warerastats `avg` is a trailing average that lags the
      // market when a price moves (e.g. livestock/coca read low). So price from
      // the live order book — the LOWEST OFFER (best ask), i.e. the "buy it now"
      // value the game shows — falling back to the book midpoint, then to the
      // feed average only when an item's book is empty/thin.
      const avgPrices = {};
      (Array.isArray(itemsArr) ? itemsArr : []).forEach(it => { if (it?.itemCode != null && typeof it.avg === 'number') avgPrices[it.itemCode] = it.avg; });
      const prices = {};
      const priceCodes = Object.keys(META).filter(c => gameItems[c]);
      steps.setStep(3, 'active', { sub: 'Pricing items from the live market', count: `0/${priceCodes.length}` });
      let pd = 0;
      await mapConcurrent(priceCodes, async (code) => {
        const ob = await dp_trpc('tradingOrder.getTopOrders', { itemCode: code }).catch(() => null);
        const p  = orderLowestOffer(ob) ?? orderMid(ob) ?? avgPrices[code];
        if (p != null) prices[code] = p;
        steps.setStep(3, 'active', { count: `${++pd}/${priceCodes.length}` });
      });
      const aeLevels = gameConfig?.upgradesConfig?.automatedEngine?.levels || {};
      const aeDailyProd = (lvl) => aeLevels[lvl]?.stats?.dailyProd || 0;
      // Moving a company or changing its production each costs concrete
      // (company.moveCost / changeItemCost — both 5). Used for the Deductions line.
      const moveCost = gameConfig?.company?.moveCost ?? gameConfig?.company?.changeItemCost ?? 5;
      const cfgDep = gameConfig?.company?.depositResourceBonus;
      if (typeof cfgDep === 'number') GAME_DEPOSIT_BONUS = cfgDep;
      // Recurring mission rewards. Daily is counted as-is; weekly and monthly
      // are prorated to a daily figure (÷7 and ÷30) and shown on their own
      // income lines, so the Daily line stays the true daily reward. Mission
      // cases (daily + weekly/7 + monthly/30) all flow into the Case-sales line.
      // (Starting missions are one-time, so they're excluded.)
      const mr = gameConfig?.mission?.reward || {};
      const missionMoney       = (mr.daily?.money  || 0);
      const missionMoneyWeekly = (mr.weekly?.money || 0) / 7;
      const missionCasesDaily  = (mr.daily?.cases  || 0);
      const missionCasesWeekly = (mr.weekly?.cases || 0) / 7;

      const allCountries = Array.isArray(allCountriesRaw) ? allCountriesRaw : (allCountriesRaw?.items || []);
      steps.setStep(3, 'active', { sub: 'Loading country bonuses', count: `0/${allCountries.length}` });
      let cl = 0;
      const countryById = {};
      await mapConcurrent(allCountries, async (c) => {
        const full = await dp_trpc('country.getCountryById', { countryId: c._id }).catch(() => null);
        if (full) countryById[c._id] = full;
        steps.setStep(3, 'active', { count: `${++cl}/${allCountries.length}` });
      }, 25);
      (Array.isArray(wsCountries) ? wsCountries : []).forEach(c => {
        if (c && c.countryId != null && c.industrialism != null && countryById[c.countryId]) countryById[c.countryId].industrialism = c.industrialism;
      });
      steps.setStep(3, 'done', { count: `${Object.keys(countryById).length} countries` });
      steps.fadeOut(300);

      // Best region bonus per item (across all regions) → "max" framing.
      const regionsByCountry = {};
      Object.values(regionsObj).forEach(r => { if (r?.country) (regionsByCountry[r.country] = regionsByCountry[r.country] || []).push(r); });
      const bestBonus = {};
      for (const code in META) {
        let best = { total: 0, region: null, country: null };
        for (const cid in countryById) {
          const country = countryById[cid];
          for (const region of (regionsByCountry[cid] || [])) {
            const b = computeBonus(country, region, code);
            if (b && b.total > best.total) best = b;
          }
        }
        bestBonus[code] = best;
      }

      // Per-company: region bonus, automated-engine PP/day (from upgrade
      // config — NOT the `production` field, which is the uncollected
      // buffer), plus workers' manual production and wage cost.
      workerProfiles[user._id] = user;   // self counts as a worker where they work
      // Profit per production point for a company's item (after raw materials &
      // region bonus, before wages). Used for self-work targeting and for each
      // employee's profitability. null when the item/recipe isn't priced.
      const companyNetPP = (c) => {
        const it = gameItems[c.itemCode]; const pp = it?.productionPoints || 0;
        const sale = prices[c.itemCode]; if (!pp || sale == null) return null;
        let rc = 0; const needs = it.productionNeeds || {};
        for (const k in needs) { if (prices[k] == null) return null; rc += needs[k] * prices[k]; }
        const bonus = c._bonus ? c._bonus.total : 0;
        return (sale - rc) * (1 + bonus / 100) / pp;
      };
      const companyById = {};
      companies.forEach(c => {
        companyById[c._id] = c;
        const region = regionsObj[c.region];
        const country = region ? countryById[region.country] : null;
        c._bonus = computeBonus(country, region, c.itemCode);
        c._netPP = companyNetPP(c);                 // bonus-applied (self-work target + employee panel)
        c._dailyAE = aeDailyProd(c.activeUpgradeLevels?.automatedEngine);   // raw AE (shown in Companies table)
        c._aeBonus = c._dailyAE * (1 + (c._bonus ? c._bonus.total : 0) / 100); // AE with bonus (#3) — throughput
        c._workersManual = 0;
        c._wageCost = 0;
      });
      // Hired employees only — worker.getWorkers never includes the owner.
      // Each produces production × energy × WORK_FACTOR × (1 + fidelity/100),
      // and is paid a wage on the pre-fidelity base. Collected for the
      // profitability panel: an employee makes you money when their output's
      // value (netPP × outputPP) beats their wage (wage × basePP).
      const employees = [];
      workerEntries.forEach(w => {
        const c = companyById[w.companyId]; if (!c) return;
        const prof = workerProfiles[w.userId]; if (!prof) return;
        const prod = skill(prof, 'production');
        const energy = skill(prof, 'energy');
        const fid  = typeof w.fidelity === 'number' ? w.fidelity : 0;
        const wage = typeof w.wage === 'number' ? w.wage : 0;
        const bonus = c._bonus ? c._bonus.total : 0;
        const basePP   = prod * energy * WORK_FACTOR;         // pre-fidelity/bonus; wages paid on this
        // Output PP carries fidelity + region bonus ADDITIVELY (sheet model).
        c._workersManual += basePP * (1 + (fid + bonus) / 100);
        c._wageCost += basePP * wage;
        employees.push({ name: prof.username || '—', company: c.name || META[c.itemCode]?.name || c.itemCode,
                         item: c.itemCode, prod, bonus: c._bonus ? c._bonus.total : 0,
                         basePP, netPP: c._netPP, wage, fidelity: fid });
      });

      // The owner ALSO self-works in their OWN companies via the entrepreneurship
      // pool — a separate stream from their energy "job" (which may be in someone
      // else's company). worker.getWorkers never lists the owner, so add it here:
      //   production × entrepreneurship × WORK_FACTOR   (no fidelity, no wage).
      // It's one self-work stream; attribute it to the owner's most profitable
      // company (the rational target) so the profit column reflects it.
      const selfPP = skill(user, 'production') * skill(user, 'entrepreneurship') * WORK_FACTOR;
      let selfWorkCompany = null, selfContribution = 0;
      if (selfPP > 0 && companies.length) {
        let bestv = -Infinity;
        for (const c of companies) { const v = (c._netPP == null ? -Infinity : c._netPP); if (v > bestv) { bestv = v; selfWorkCompany = c; } }
        if (selfWorkCompany) {
          const b = selfWorkCompany._bonus ? selfWorkCompany._bonus.total : 0;
          selfContribution = selfPP * (1 + b / 100);   // self: no fidelity, + region bonus
          selfWorkCompany._workersManual += selfContribution;
          selfWorkCompany._selfWork = true;
        }
      }
      // Daily throughput per company carries the bonus: AE-with-bonus + bonused staff.
      companies.forEach(c => { c._dailyPP = c._aeBonus + c._workersManual; });

      const enginesPP = Math.round(companies.reduce((s, c) => s + c._aeBonus, 0));
      const staffPP   = Math.round(companies.reduce((s, c) => s + c._workersManual, 0));

      // Salary, modeled over a full 24h rather than the lumpy actual sum:
      // daily work capacity (energy × WORK_FACTOR works/day) × the average NET
      // wage per work payment (taken straight from recent wage transactions, so
      // tax is already baked in and we needn't reconcile the wage rate).
      const salaryWorksPerDay = skill(user, 'energy') * WORK_FACTOR;
      const salaryAvgPerWork  = salaryInfo.count ? salaryInfo.total / salaryInfo.count : 0;
      const salaryModeled     = salaryWorksPerDay * salaryAvgPerWork;

      model = { user, prices, gameItems, bestBonus, companies, disabledCount, employees,
                missionMoney, missionMoneyWeekly,
                missionCasesDaily, missionCasesWeekly,
                missionsDone: { daily: true, weekly: true },
                casesManual: null,   // manual "cases sold today" override; null = use modeled
                movesManual: null,   // manual count of company moves / production changes
                moveCost, concretePrice: (prices['concrete'] ?? null),
                casePrice: (prices['case1'] ?? null),
                salaryDaily: salaryModeled, salaryActual: salaryInfo.total, salaryCount: salaryInfo.count,
                salaryWorksPerDay, salaryAvgPerWork,
                enginesPP, staffPP, priceOverrides: {},
                selfPP: Math.round(selfContribution),
                selfWorkItem: selfWorkCompany ? (META[selfWorkCompany.itemCode]?.name || selfWorkCompany.itemCode) : null,
                assumptions: { enginesPP, staffPP } };   // editable; throughput = sum
      renderAll();
    } catch (e) {
      steps.markActiveAsError(e.message);
      showStatus('error', escapeHtml(e.message));
    } finally {
      $submit.disabled = false;
    }
  }

  // ── Economics ───────────────────────────────────────────────────
  function price(code) {
    const o = model.priceOverrides[code];
    if (o != null && o !== '' && isFinite(+o)) return +o;
    return model.prices[code] != null ? model.prices[code] : null;
  }
  function rawCostOf(code) {
    const needs = model.gameItems[code]?.productionNeeds;
    if (!needs) return 0;
    let cost = 0;
    for (const r in needs) { const p = price(r); if (p == null) return null; cost += needs[r] * p; }
    return cost;
  }
  // Net profit per production point for an item at a given bonus %.
  function netPerPP(code, bonusPct) {
    const it = model.gameItems[code];
    const pp = it?.productionPoints || 0;
    if (!pp) return null;
    const sale = price(code);
    if (sale == null) return null;
    const rc = rawCostOf(code);
    if (rc == null) return null;
    return (sale - rc) * (1 + bonusPct / 100) / pp;
  }

  // ── Render ──────────────────────────────────────────────────────
  function renderAll() {
    renderAssumptions();
    renderTableAndIncome();
    renderCompanies();
    renderEmployees();
    $statsCard.classList.remove('hidden');
    $tableCard.classList.remove('hidden');
  }

  // Companies panel: automated-engine output per company, and AE with its region
  // production bonus applied — AE with bonus = AE × (1 + bonus%).
  function renderCompanies() {
    const cs = model.companies || [];
    if (!cs.length) { $compCard.classList.add('hidden'); return; }
    $compCard.classList.remove('hidden');
    const rows = cs.map(c => {
      const bonus = c._bonus ? c._bonus.total : 0;
      const ae = c._dailyAE || 0;
      return { name: c.name || '—', item: c.itemCode, bonus, ae, aeBonus: ae * (1 + bonus / 100) };
    }).sort((a, b) => b.aeBonus - a.aeBonus);
    const totAE  = rows.reduce((s, r) => s + r.ae, 0);
    const totAEB = rows.reduce((s, r) => s + r.aeBonus, 0);
    $companies.innerHTML = `
      <thead><tr>
        <th class="dp-l">Company</th>
        <th class="dp-l">Product</th>
        <th>Bonus</th>
        <th>AE / day</th>
        <th title="Automated-engine output with the region production bonus applied">AE with bonus</th>
      </tr></thead>
      <tbody>${rows.map(r => `<tr>
        <td class="dp-l">${escapeHtml(r.name)}</td>
        <td class="dp-l"><span class="dp-prod">${iconHtml(r.item)}<span>${escapeHtml(META[r.item]?.name || r.item)}</span></span></td>
        <td class="dp-bonus">${r.bonus ? '+' + fmt2(r.bonus) + '%' : '<span class="dp-muted">0%</span>'}</td>
        <td>${fmtPP(r.ae)}</td>
        <td><strong>${fmtPP(r.aeBonus)}</strong></td>
      </tr>`).join('')}
      <tr class="dp-comp-total">
        <td class="dp-l" colspan="3">Total</td>
        <td>${fmtPP(totAE)}</td>
        <td><strong>${fmtPP(totAEB)}</strong></td>
      </tr></tbody>`;
  }

  // An employee's daily profit to you, at a given fidelity:
  //   value − wage = basePP × (netPP × (1 + fid/100) − wage).
  // (Wage is paid on the pre-fidelity base, so only the output side scales.)
  function empNet(e, fid) {
    if (e.netPP == null) return null;
    return e.basePP * (e.netPP * (1 + fid / 100) - e.wage);
  }
  function empNetHtml(net) {
    if (net == null) return '<span class="dp-na">—</span>';
    return `<span class="${net < 0 ? 'dp-emp-loss' : 'dp-emp-gain'}">${net >= 0 ? '+' : ''}${fmtK(net)}/day</span>`;
  }
  // Adjusted PP = production PP lifted by fidelity + region bonus, ADDITIVELY:
  //   EmpPP × (1 + (fidelity% + bonus%)).  Matches the sheet's "Adj PP".
  function empAdjPP(e, fid) { return e.prod * (1 + (fid + (e.bonus || 0)) / 100); }
  function empSubHtml(emps) {
    const bad = emps.filter(e => { const n = empNet(e, e.fidelity); return n != null && n < 0; }).length;
    return bad
      ? `<strong class="dp-emp-badcount">${bad} of ${emps.length}</strong> employee${bad > 1 ? 's' : ''} not making you a profit at current fidelity — bump the fidelity field (max 10) to see if they'd turn a profit.`
      : `All ${emps.length} employees are profitable at their current fidelity.`;
  }
  // Employees panel: name, company, editable fidelity (0–10), and live net/day.
  // Unprofitable ones are flagged; raising fidelity shows if they'd turn around.
  function renderEmployees() {
    const emps = model.employees || [];
    if (!emps.length) { $empCard.classList.add('hidden'); return; }
    $empCard.classList.remove('hidden');
    $empSub.innerHTML = empSubHtml(emps);
    // Unprofitable first, then most-negative first.
    const order = emps.map((e, i) => ({ e, i })).sort((a, b) => {
      const na = empNet(a.e, a.e.fidelity), nb = empNet(b.e, b.e.fidelity);
      const ba = na != null && na < 0, bb = nb != null && nb < 0;
      return ba === bb ? ((na ?? 0) - (nb ?? 0)) : (ba ? -1 : 1);
    });
    $employees.innerHTML = order.map(({ e, i }) => empRowHtml(e, i)).join('');
    // Wage and fidelity are both editable per row; either recomputes the row.
    $employees.querySelectorAll('.dp-fid-in').forEach(inp => inp.addEventListener('input', ev => {
      const i = +ev.target.dataset.idx;
      let v = parseInt(ev.target.value, 10);
      if (!isFinite(v)) v = 0;
      model.employees[i].fidelity = Math.max(0, Math.min(10, v));
      updateEmpRow(i);
    }));
    $employees.querySelectorAll('.dp-wage-in').forEach(inp => inp.addEventListener('input', ev => {
      const i = +ev.target.dataset.idx;
      let v = parseFloat(ev.target.value);
      if (!isFinite(v) || v < 0) v = 0;
      model.employees[i].wage = v;
      updateEmpRow(i);
    }));
  }

  // Break-even wage at full fidelity (10): wage where net = 0 → netPP × 1.10.
  // Pay more than this and they can't be profitable at ANY fidelity.
  function empBreakeven(e) { return e.netPP == null ? null : e.netPP * 1.10; }
  function empRowHtml(e, i) {
    const net = empNet(e, e.fidelity);
    const be  = empBreakeven(e);
    const beHtml = be == null ? '' :
      `<span class="dp-emp-be">break-even wage @ full fidelity: <strong>${fmt3(be)}</strong> · you pay `
      + `<span id="dp-emp-pay-${i}" class="${e.wage > be ? 'dp-emp-loss' : 'dp-emp-gain'}">${fmt3(e.wage)}</span>`
      + `<span id="dp-emp-warn-${i}">${e.wage > be ? ' — unprofitable at any fidelity' : ''}</span></span>`;
    return `<div class="dp-emp${net != null && net < 0 ? ' dp-emp-bad' : ''}" id="dp-emp-row-${i}">
      <div class="dp-emp-main">
        <span class="dp-emp-name">${escapeHtml(e.name)}</span>
        <span class="dp-emp-co">${escapeHtml(e.company)} · ${escapeHtml(META[e.item]?.name || e.item)}</span>
        ${beHtml}
      </div>
      <label class="dp-emp-fld">wage <input type="number" class="dp-wage-in" data-idx="${i}" value="${e.wage}" min="0" step="0.001"></label>
      <label class="dp-emp-fld">fidelity <input type="number" class="dp-fid-in" data-idx="${i}" value="${e.fidelity}" min="0" max="10" step="1"></label>
      <div class="dp-emp-adj" title="Adjusted PP = ${fmtPP(e.prod)} PP × (1 + fidelity% + ${fmt2(e.bonus || 0)}% bonus)">Adj PP <strong id="dp-emp-adj-${i}">${fmtPP(empAdjPP(e, e.fidelity))}</strong></div>
      <div class="dp-emp-net" id="dp-emp-net-${i}">${empNetHtml(net)}</div>
    </div>`;
  }
  // Recompute a single row in place (keeps input focus while typing).
  function updateEmpRow(i) {
    const e = model.employees[i];
    const net = empNet(e, e.fidelity);
    const cell = $employees.querySelector(`#dp-emp-net-${i}`);
    if (cell) cell.innerHTML = empNetHtml(net);
    const adj = $employees.querySelector(`#dp-emp-adj-${i}`);
    if (adj) adj.textContent = fmtPP(empAdjPP(e, e.fidelity));
    const row = $employees.querySelector(`#dp-emp-row-${i}`);
    if (row) row.classList.toggle('dp-emp-bad', net != null && net < 0);
    const be = empBreakeven(e), pay = $employees.querySelector(`#dp-emp-pay-${i}`);
    if (pay && be != null) {
      pay.textContent = fmt3(e.wage);
      pay.className = e.wage > be ? 'dp-emp-loss' : 'dp-emp-gain';
      const warn = $employees.querySelector(`#dp-emp-warn-${i}`);
      if (warn) warn.textContent = e.wage > be ? ' — unprofitable at any fidelity' : '';
    }
    $empSub.innerHTML = empSubHtml(model.employees);
  }

  function renderAssumptions() {
    const a = model.assumptions;
    $statsHead.textContent = `Projected income · ${model.user.username}`;
    // Items with no market price (untraded, e.g. wood/paper) get a manual
    // price field — typing a raw's price (wood) also feeds recipes (paper).
    const unpriced = Object.keys(META).filter(c => model.gameItems[c] && model.prices[c] == null);
    const priceFields = unpriced.map(c => `
      <div class="dp-field">
        <label>${escapeHtml(META[c].name)} price</label>
        <input type="number" class="dp-price-in" data-code="${c}" value="${model.priceOverrides[c] ?? ''}" min="0" step="0.001" placeholder="—">
        <span class="dp-suffix">untraded · set it</span>
      </div>`).join('');
    $assump.innerHTML = `
      <div class="dp-field">
        <label title="Automated-engine output per day, summed across your companies">Engine PP / day</label>
        <input type="number" id="dp-engines" value="${a.enginesPP}" min="0" step="1">
        <span class="dp-suffix">automated engines</span>
      </div>
      <div class="dp-field">
        <label title="You + your employees working in your companies">Staff PP / day</label>
        <input type="number" id="dp-staff" value="${a.staffPP}" min="0" step="1">
        <span class="dp-suffix">employees${model.selfPP ? ` + your ${model.selfPP} self-work${model.selfWorkItem ? ` → ${escapeHtml(model.selfWorkItem)}` : ''}` : ''}</span>
      </div>
      <div class="dp-field">
        <label title="Engine + staff — drives Ceiling/day">Total throughput</label>
        <input type="number" id="dp-tp-total" value="${Math.round((a.enginesPP || 0) + (a.staffPP || 0))}" disabled>
        <span class="dp-suffix">engines + staff</span>
      </div>
      ${priceFields}
    `;
    const $eng = $assump.querySelector('#dp-engines');
    const $stf = $assump.querySelector('#dp-staff');
    const $tot = $assump.querySelector('#dp-tp-total');
    const onThroughput = () => {
      const e = parseFloat($eng.value); model.assumptions.enginesPP = isFinite(e) ? e : 0;
      const s = parseFloat($stf.value); model.assumptions.staffPP   = isFinite(s) ? s : 0;
      if ($tot) $tot.value = Math.round(model.assumptions.enginesPP + model.assumptions.staffPP);
      renderTableAndIncome();   // re-renders the table only — these inputs keep focus
    };
    $eng.addEventListener('input', onThroughput);
    $stf.addEventListener('input', onThroughput);
    $assump.querySelectorAll('.dp-price-in').forEach(inp => {
      inp.addEventListener('input', e => {
        const code = e.target.dataset.code, v = e.target.value;
        if (v === '' || !isFinite(+v)) delete model.priceOverrides[code];
        else model.priceOverrides[code] = +v;
        renderTableAndIncome();   // re-renders the table only — these inputs keep focus
      });
    });
  }

  function buildRows() {
    const rows = [];
    for (const code in META) {
      const it = model.gameItems[code];
      if (!it) continue;
      const bb = model.bestBonus[code] || { total: 0 };
      const npp = netPerPP(code, 0);            // Net/PP = net profit ÷ PP (bonus-free)
      // Actual = bonus-free Net/PP × the company's bonused throughput (AE-with-bonus
      // + bonused staff) − wages. The bonus now lives in the throughput, not Net/PP.
      let actual = 0, makesIt = false;
      for (const c of model.companies) {
        if (c.itemCode !== code) continue;
        makesIt = true;
        if (npp != null) actual += npp * (c._dailyPP || 0) - (c._wageCost || 0);
      }
      rows.push({ code, name: META[code].name, cat: META[code].cat, type: it.type,
                  netPP: npp, bonus: bb.total, region: bb.region, country: bb.country,
                  tax: bb.tax, deposit: bb.deposit,
                  makesIt, actual: makesIt ? actual : null });
    }
    rows.sort((a, b) => (b.netPP ?? -Infinity) - (a.netPP ?? -Infinity));
    return rows;
  }

  function iconHtml(code) {
    const f = ICON_FILE[code];
    if (!f) return `<span>📦</span>`;
    return `<div class="icon-box"><img src="images/${f}" alt="" onerror="this.parentElement.innerHTML='📦'"></div>`;
  }

  function renderTableAndIncome() {
    const tp = (model.assumptions.enginesPP || 0) + (model.assumptions.staffPP || 0);
    // Employee wages are a fixed cost — you pay them whatever the workers make.
    // Actual/day already nets them out, so Ceiling/day must too, or it reads high.
    const totalWageCost = model.companies.reduce((s, c) => s + (c._wageCost || 0), 0);
    const rows = buildRows();

    $table.innerHTML = `
      <thead><tr>
        <th class="dp-l">Product</th>
        <th class="dp-l">Type</th>
        <th>Sale</th>
        <th>Raw cost</th>
        <th>Bonus</th>
        <th class="dp-l" title="Country giving the best production bonus, and its income tax (Country › Account)">Country · tax</th>
        <th title="Temporary regional deposit driving the bonus, and when it expires">Deposit</th>
        <th>Net / PP</th>
        <th title="Theoretical ceiling: total throughput on this one product, minus wages">Ceiling / day</th>
        <th>Actual / day</th>
      </tr></thead>
      <tbody>${rows.map(r => {
        const sale = price(r.code);
        const rc = rawCostOf(r.code);
        const maxDay = r.netPP != null ? r.netPP * tp - totalWageCost : null;
        const regionTip = r.region ? `${escapeHtml(r.region.name)}${r.country ? ' · ' + escapeHtml(r.country.name) : ''}` : 'no bonus region';
        return `<tr class="${r.makesIt ? 'dp-owned' : ''}">
          <td class="dp-l"><span class="dp-prod">${iconHtml(r.code)}<span>${escapeHtml(r.name)}</span><span class="dp-cat">· ${r.cat}</span></span></td>
          <td class="dp-l"><span class="dp-pill ${r.type}">${r.type === 'product' ? 'Finished' : 'Raw'}</span></td>
          <td>${sale == null ? '<span class="dp-na">–</span>' : fmt3(sale)}</td>
          <td>${rc == null ? '<span class="dp-na">–</span>' : (rc ? fmt3(rc) : '<span class="dp-muted">0</span>')}</td>
          <td class="dp-bonus" title="${regionTip}">${r.bonus ? '+' + fmt2(r.bonus) + '%' : '<span class="dp-muted">0%</span>'}</td>
          <td class="dp-l">${r.country ? `${escapeHtml(r.country.name)} <span class="dp-tax">· ${r.tax != null ? r.tax + '%' : '–'}</span>` : '<span class="dp-na">—</span>'}</td>
          <td>${r.deposit ? `<span class="dp-dep" title="Temporary deposit (+${r.deposit.bonus}% ${escapeHtml(META[r.deposit.type]?.name || r.deposit.type)}) — expires ${fmtDate(r.deposit.endsAt)}">⏳ ${fmtDate(r.deposit.endsAt)}</span>` : '<span class="dp-muted">—</span>'}</td>
          <td class="dp-netpp ${r.netPP != null && r.netPP < 0 ? 'neg' : ''}">${r.netPP == null ? '<span class="dp-na">–</span>' : fmt3(r.netPP)}</td>
          <td>${maxDay == null ? '<span class="dp-na">–</span>' : fmtK(maxDay)}</td>
          <td>${r.actual == null ? '<span class="dp-na">—</span>' : `<span class="dp-actual">${fmtK(r.actual)}</span>`}</td>
        </tr>`;
      }).join('')}</tbody>
    `;

    const priced = rows.filter(r => r.netPP != null).length;
    const missing = rows.filter(r => r.netPP == null).map(r => r.name);
    const top = rows[0];
    $tableNote.innerHTML = `Best Net/PP: <strong>${top && top.netPP != null ? top.name + ' (' + fmt3(top.netPP) + '/PP)' : '–'}</strong>. `
      + `${priced}/${rows.length} products priced.` + (missing.length ? ` No market price for: <code>${missing.join('</code>, <code>')}</code>.` : '');

    model._companiesIncome = rows.reduce((s, r) => s + (r.actual || 0), 0);
    renderIncome();
  }

  // Income summary. Mission cadences each have a "done?" checkbox; Case sales and
  // Deductions each have a manual input. The fixed income lines are summed once,
  // and the two manual fields recompute Case sales / Deductions / Total in place
  // (no full re-render, so typing keeps focus). Checkbox toggles do re-render.
  function renderIncome() {
    const done = model.missionsDone;
    const modeledCases = (done.daily  ? model.missionCasesDaily  : 0)
                       + (done.weekly ? model.missionCasesWeekly : 0);
    const casePriced     = model.casePrice != null;
    const concretePriced = model.concretePrice != null;

    // Income that doesn't change with the two manual fields.
    const fixedIncome =
        (model._companiesIncome || 0)
      + (model.salaryDaily || 0)
      + (done.daily  ? model.missionMoney       : 0)
      + (done.weekly ? model.missionMoneyWeekly : 0);

    const caseVal   = () => casePriced ? ((model.casesManual != null ? model.casesManual : modeledCases) * model.casePrice) : 0;
    // Each move / production change costs `moveCost` concrete (5), valued live.
    const deductVal = () => concretePriced ? ((model.movesManual || 0) * model.moveCost * model.concretePrice) : 0;
    const grandTotal = () => fixedIncome + caseVal() - deductVal();

    const items = [
      { label: 'Companies',  val: model._companiesIncome, sub: `${model.companies.length} active${model.disabledCount ? ` · ${model.disabledCount} disabled excluded` : ''}, current output` },
      { label: 'Salary',     val: model.salaryDaily, sub: model.salaryCount
          ? `~${model.salaryWorksPerDay.toFixed(1)} works/day × ${fmt2(model.salaryAvgPerWork)} net · modeled (24h actual: ${fmtK(model.salaryActual)})`
          : 'no recent wages to model from' },
      { label: 'Daily missions',  val: model.missionMoney,       sub: 'daily reward',          toggle: 'daily',  done: done.daily },
      { label: 'Weekly missions', val: model.missionMoneyWeekly, sub: '30 / week (spread over 7 days)', toggle: 'weekly', done: done.weekly },
    ];

    // Case sales: manual "cases sold today" (empty → modeled count via placeholder).
    const caseSub = casePriced
      ? `<input type="number" class="dp-cases-in" value="${model.casesManual ?? ''}" placeholder="${fmt2(modeledCases)}" min="0" step="0.01"> cases × ${fmt2(model.casePrice)}`
      : 'no case price';
    const caseCard = `<div class="dp-inc"><div class="dp-inc-label">Case sales</div>`
      + `<div class="dp-inc-val" id="dp-case-val">${fmtK(caseVal())}</div><div class="dp-inc-sub">${caseSub}</div></div>`;

    // Deductions: company moves / production changes today × moveCost concrete × price.
    const deductSub = concretePriced
      ? `<input type="number" class="dp-moves-in" value="${model.movesManual ?? ''}" placeholder="0" min="0" step="1"> moves/changes × ${model.moveCost} concrete × ${fmt2(model.concretePrice)}`
      : 'no concrete price';
    const deductCard = `<div class="dp-inc dp-inc-deduct"><div class="dp-inc-label">Deductions</div>`
      + `<div class="dp-inc-val" id="dp-deduct-val">−${fmtK(deductVal())}</div><div class="dp-inc-sub">${deductSub}</div></div>`;

    $income.innerHTML = items.map(x => {
      const off = x.toggle && !x.done;
      const label = x.toggle
        ? `<label class="dp-inc-chk"><input type="checkbox" data-mission="${x.toggle}" ${x.done ? 'checked' : ''}>${x.label}</label>`
        : x.label;
      return `<div class="dp-inc${off ? ' dp-inc-off' : ''}"><div class="dp-inc-label">${label}</div>`
        + `<div class="dp-inc-val">${off ? '0.00' : fmtK(x.val)}</div><div class="dp-inc-sub">${x.sub}</div></div>`;
    }).join('') + caseCard + deductCard
      + `<div class="dp-inc total"><div class="dp-inc-label">Total / day</div><div class="dp-inc-val" id="dp-total-val">${fmtK(grandTotal())}</div><div class="dp-inc-sub" id="dp-total-sub">≈ ${fmtK(grandTotal() * 7)} / week</div></div>`;

    const recalc = () => {
      $income.querySelector('#dp-case-val').textContent = fmtK(caseVal());
      $income.querySelector('#dp-deduct-val').textContent = '−' + fmtK(deductVal());
      const t = grandTotal();
      $income.querySelector('#dp-total-val').textContent = fmtK(t);
      $income.querySelector('#dp-total-sub').textContent = `≈ ${fmtK(t * 7)} / week`;
    };

    $income.querySelectorAll('input[data-mission]').forEach(cb =>
      cb.addEventListener('change', () => { model.missionsDone[cb.dataset.mission] = cb.checked; renderIncome(); }));

    const casesIn = $income.querySelector('.dp-cases-in');
    if (casesIn) casesIn.addEventListener('input', e => {
      const raw = e.target.value.trim();
      model.casesManual = (raw === '' || !isFinite(+raw)) ? null : +raw;
      recalc();
    });
    const movesIn = $income.querySelector('.dp-moves-in');
    if (movesIn) movesIn.addEventListener('input', e => {
      const raw = e.target.value.trim();
      model.movesManual = (raw === '' || !isFinite(+raw)) ? null : +raw;
      recalc();
    });
  }

  // ── Wiring ──────────────────────────────────────────────────────
  $submit.addEventListener('click', handleSubmit);
  $username.addEventListener('keydown', e => { if (e.key === 'Enter') handleSubmit(); });
  $recent.addEventListener('click', e => {
    const del = e.target.closest('[data-dp-recent-del]');
    if (del) { forgetUsername(del.dataset.dpRecentDel); return; }
    const pick = e.target.closest('[data-dp-recent]');
    if (pick) { $username.value = pick.dataset.dpRecent; handleSubmit(); }
  });

  return {
    activate(params) {
      renderRecent();
      const u = (params && params.get && params.get('u')) || new URLSearchParams(location.search).get('u');
      if (u && $username.value.toLowerCase() !== u.toLowerCase()) { $username.value = u; handleSubmit(); }
      else if (!u && !$username.value) $username.focus();
    },
  };
})();
