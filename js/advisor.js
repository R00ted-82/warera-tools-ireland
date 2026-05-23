/* ═══════════════════════════════════════════════════════════════════
 *  COMPANY MIGRATION ADVISOR
 *
 *  Computes production bonuses locally from country + region data fetched
 *  through the warerastats gateway. The bonus model has four components:
 *
 *    strategic       — country.strategicResources.bonuses.productionPercent
 *                      (fires when item matches country.specializedItem)
 *    specialisation  — flat +30% "Industrialism", fires when the country is
 *                      INDUSTRIALIST-leaning (industrialism > 0), the item
 *                      matches its specialisedItem, AND the item is an
 *                      INDUSTRIAL item (not food/agrarian). Verified:
 *                      Bulgaria/steak (ind=+2) does NOT get +30, but
 *                      South Africa/steel and Guinea-Bissau/lead do.
 *    deposit         — region.deposit.bonusPercent, fires when the region
 *                      has an active matching deposit AND the country does
 *                      NOT specialise in this item
 *    depositCountry  — flat country-level deposit bonus (read from
 *                      gameConfig.company.depositResourceBonus, defaults
 *                      to 30), fires when there's a matching active deposit
 *                      AND the country is AGRARIAN-leaning (industrialism < 0)
 *
 *  Industrialism is a signed integer from the warerastats companion endpoint
 *  (range −2…+2; only sign matters for bonus gating). Each lean grants
 *  exactly one type of +30%, never both. Neutral (industrialism = 0)
 *  countries grant neither. If the companion endpoint is unreachable,
 *  industrialism defaults to 0 — the +30% bonuses just don't fire, which
 *  under-counts rather than wrong-counts.
 *
 *  This model was verified against in-game tooltips for Guinea-Bissau/lead
 *  (+56), Jordan/concrete (no +30), India/cookedFish (+20.5), Serbia/steak
 *  (+20), South Africa/steel (+34.25), Peru/lead deposit (+30 not +60),
 *  Ireland/grain deposit (+60), Bulgaria/steak (+10 not +40 — agrarian
 *  exclusion), and others. Do NOT re-introduce a +30 on food/agrarian items
 *  for industrialist countries — that was the bug.
 * ═══════════════════════════════════════════════════════════════════ */
const AdvisorTool = (() => {
  const companyUrlFor = id => `${GAME_BASE}/company/${id}`;

  const ITEMS = {
    cocain:     { name: 'Pill',            file: 'cocain.png',     fb: '💊' },
    coca:       { name: 'Mysterious Plant',file: 'coca.png',       fb: '🌿' },
    lightAmmo:  { name: 'Light Ammo',      file: 'lightAmmo.png',  fb: '•' },
    ammo:       { name: 'Ammo',            file: 'ammo.png',       fb: '🔫' },
    heavyAmmo:  { name: 'Heavy Ammo',      file: 'heavyAmmo.png',  fb: '💥' },
    lead:       { name: 'Lead',            file: 'lead.png',       fb: '⚫' },
    cookedFish: { name: 'Cooked Fish',     file: 'cookedFish.png', fb: '🍣' },
    steak:      { name: 'Steak',           file: 'steak.png',      fb: '🥩' },
    bread:      { name: 'Bread',           file: 'bread.png',      fb: '🍞' },
    fish:       { name: 'Fish',            file: 'fish.png',       fb: '🐟' },
    livestock:  { name: 'Livestock',       file: 'livestock.png',  fb: '🐄' },
    grain:      { name: 'Grain',           file: 'grain.png',      fb: '🌾' },
    oil:        { name: 'Oil',             file: 'oil.png',        fb: '⛽' },
    steel:      { name: 'Steel',           file: 'steel.png',      fb: '🏗️' },
    concrete:   { name: 'Concrete',        file: 'concrete.png',   fb: '🧱' },
    petroleum:  { name: 'Petroleum',       file: 'petroleum.png',  fb: '🛢️' },
    iron:       { name: 'Iron',            file: 'iron.png',       fb: '⛓️' },
    limestone:  { name: 'Limestone',       file: 'limestone.png',  fb: '🪨' },
  };

  const OPTIMAL_THRESHOLD = 2;
  const HUGE_THRESHOLD    = 20;

  // The +30% Industrialism (specialisation) bonus does NOT fire on
  // agrarian items, even when the country is industrialist-leaning.
  // Verified against Bulgaria/steak: industrialism=+2, specializedItem=steak,
  // strategic=+10, but the game's "Move company" panel shows Bulgaria at
  // +10% (not +40%), and Croatia (+21.25% from strategic alone) ranks
  // ahead of it. Compare with industrial items where the +30 does fire:
  // Guinea-Bissau/lead → +56, South Africa/steel → +34.25.
  //
  // This list includes the agrarian raw materials (fish, livestock, grain),
  // their processed forms (cookedFish, steak, bread), and the coca/pill
  // pair, which follow the same production model. If a future spec-eligible
  // food item is added, extend this set.
  const AGRARIAN_ITEMS = new Set([
    'steak', 'bread', 'fish', 'cookedFish', 'livestock', 'grain',
    'coca', 'cocain',
  ]);

  // Companion endpoint for industrialism. Lives on Hattorius's
  // warerastats.io, proxied through the same worker that fronts the
  // gateway. Set in the merged tool's CFG block; here we derive it from
  // the existing tRPC base so we don't need a second config knob.
  const WARERASTATS_BASE = (typeof CFG !== 'undefined' && CFG.API_BASE)
    ? CFG.API_BASE.replace(/\/trpc\/?$/, '') + '/warerastats'
    : 'https://warera-proxy.toie.workers.dev/warerastats';

  // Flat country-level deposit bonus, used when an active matching deposit
  // exists AND the country is agrarian-leaning. Defaults to 30 (observed
  // in gameConfig); overwritten at runtime if game config exposes a
  // different number.
  let GAME_DEPOSIT_BONUS = 30;

  const $grid     = document.getElementById('adv-grid');
  const $hint     = document.getElementById('adv-hint');
  const $username = document.getElementById('adv-username');
  const $go       = document.getElementById('adv-go');
  const $howto    = document.getElementById('adv-howto');
  const steps     = makeSteps(document.getElementById('adv-steps'));
  const setStatus = makeStatus(document.getElementById('adv-status'));

  let lastResult = null;

  const adv_trpc = (endpoint, input) => trpc(endpoint, input, { retry: true });

  let USER_ENDPOINT = null;
  async function fetchUser(userId) {
    if (USER_ENDPOINT) {
      try { return await adv_trpc(USER_ENDPOINT, { userId }); }
      catch { return null; }
    }
    const candidates = ['user.getById', 'user.getUserById', 'user.getUser', 'user.get'];
    for (const ep of candidates) {
      try {
        const u = await adv_trpc(ep, { userId });
        if (u) { USER_ENDPOINT = ep; return u; }
      } catch { /* try next */ }
    }
    return null;
  }

  /**
   * Resolve a username to the correct user ID.
   *
   * search.searchAnything is fuzzy/relevance-ranked across all entities,
   * so userIds[0] is NOT guaranteed to be an exact username match. We
   * pull profiles for the top N and pick the one whose username matches
   * exactly (case-insensitive). Fallback only when nothing can be verified.
   */
  async function resolveUserId(username) {
    const search = await adv_trpc('search.searchAnything', { searchText: username });
    const candidateIds = search?.userIds || [];
    if (!candidateIds.length) {
      throw new Error(`No user found matching "${username}"`);
    }

    steps.setStep(1, 'active', {
      sub: `Verifying username among ${candidateIds.length} match${candidateIds.length === 1 ? '' : 'es'}`,
      count: `0/${Math.min(candidateIds.length, 10)}`
    });

    const top = candidateIds.slice(0, 10);
    let checked = 0;
    const profiles = await Promise.all(top.map(async id => {
      const u = await fetchUser(id);
      checked++;
      steps.setStep(1, 'active', { count: `${checked}/${top.length}` });
      return u;
    }));

    const known = profiles.filter(Boolean);
    const normalise = s => (s || '').toLowerCase().trim();
    const target = normalise(username);

    const exact = known.find(u => normalise(u.username) === target);
    if (exact) return { userId: exact._id, username: exact.username, exact: true };

    if (!known.length) {
      console.warn('[advisor] Could not verify usernames; falling back to top search result.');
      return { userId: candidateIds[0], username, exact: false };
    }

    const found = known.map(u => u.username).filter(Boolean);
    throw new Error(
      `No exact match for "${username}". ` +
      `Search returned: ${found.slice(0, 5).join(', ')}${found.length > 5 ? '…' : ''}`
    );
  }

  function isDepositActive(dep) {
    if (!dep) return false;
    const now = Date.now();
    const starts = dep.startsAt ? new Date(dep.startsAt).getTime() : 0;
    const ends   = dep.endsAt   ? new Date(dep.endsAt).getTime()   : 0;
    return now >= starts && now <= ends;
  }

  function ethicsLean(country) {
    const ind = country?.industrialism;
    if (typeof ind !== 'number' || ind === 0) return 'neutral';
    return ind > 0 ? 'industrialist' : 'agrarian';
  }

  /**
   * Compute the four-component production bonus for a (country, region,
   * item) combination. Returns null if country is unknown.
   *
   * The asymmetric gating below is the heart of the model and was verified
   * against many in-game tooltips. Do not change without re-verifying:
   *
   *   • Strategic + Specialisation (+30) fire on the country's SPEC item
   *     when it's industrialist-leaning. They don't fire on deposits.
   *   • Deposit + DepositCountry (+30) fire when there's an active
   *     matching deposit AND the country does NOT specialise in this item.
   *     The +30 only applies if the country is agrarian-leaning.
   */
  function computeBonus(country, region, itemCode) {
    if (!country) return null;

    const isSpecialised = country.specializedItem === itemCode;
    const lean          = ethicsLean(country);

    const strategic = isSpecialised
      ? (country.strategicResources?.bonuses?.productionPercent || 0)
      : 0;
    // Industrialism (spec) +30 fires only for INDUSTRIAL items. Agrarian
    // items (food, plants, pills) don't get it even when the country
    // qualifies on lean + specialisation. See AGRARIAN_ITEMS comment.
    const specialisation = isSpecialised
      && lean === 'industrialist'
      && !AGRARIAN_ITEMS.has(itemCode)
      ? 30 : 0;

    const hasMatchingDeposit = !isSpecialised
      && !!region?.deposit
      && region.deposit.type === itemCode
      && isDepositActive(region.deposit);
    const deposit        = hasMatchingDeposit ? (region.deposit.bonusPercent || 0) : 0;
    const depositCountry = hasMatchingDeposit && lean === 'agrarian' ? GAME_DEPOSIT_BONUS : 0;

    const total   = strategic + specialisation + deposit + depositCountry;
    const tax     = country.taxes?.income ?? 0;
    const netMult = (1 + total / 100) * (1 - tax / 100);
    const depositEndsAt = hasMatchingDeposit ? region.deposit.endsAt : null;
    return { strategic, specialisation, deposit, depositCountry, depositEndsAt, lean, total, tax, netMult };
  }

  async function loadCountriesParallel(countries) {
    const byId = {};
    const total = countries.length;
    const chunk = 25;
    let done = 0;
    for (let i = 0; i < total; i += chunk) {
      const slice = countries.slice(i, i + chunk);
      await Promise.all(slice.map(async c => {
        try {
          const country = await adv_trpc('country.getCountryById', { countryId: c._id });
          if (country) byId[c._id] = country;
        } catch (e) { /* skip individual failures */ }
        done++;
      }));
      steps.setStep(3, 'active', { count: `${done}/${total}` });
    }
    return byId;
  }

  async function analyse(username) {
    steps.setStep(1, 'active', { sub: `Searching for "${username}"` });
    const resolved = await resolveUserId(username);
    const userId = resolved.userId;
    steps.setStep(1, 'done', {
      count: resolved.exact ? `→ ${resolved.username}` : `→ ${resolved.username} (unverified)`
    });

    steps.setStep(2, 'active', { sub: 'Fetching company list' });
    const [companyList, workersData] = await Promise.all([
      adv_trpc('company.getCompanies', { userId, perPage: 100 }),
      adv_trpc('worker.getWorkers', { userId }).catch(() => null),
    ]);
    const companyIds = companyList?.items || [];
    if (!companyIds.length) throw new Error(`"${resolved.username}" has no companies`);

    const ownCompaniesWhereUserWorks = new Set();
    (workersData?.workersPerCompany || []).forEach(({ company, workers }) => {
      (workers || []).forEach(w => {
        if (w.user === userId) ownCompaniesWhereUserWorks.add(company._id);
      });
    });

    steps.setStep(2, 'active', {
      sub: `Loading ${companyIds.length} company details`,
      count: `0/${companyIds.length}`
    });
    let loaded = 0;
    const companies = await Promise.all(companyIds.map(async id => {
      const c = await adv_trpc('company.getById', { companyId: id });
      loaded++;
      steps.setStep(2, 'active', { count: `${loaded}/${companyIds.length}` });
      return c;
    }));
    steps.setStep(2, 'done', { count: `${companies.filter(Boolean).length} loaded` });

    // Regions + country list + gameConfig + warerastats companion endpoint
    // (for industrialism) all in parallel. Companion endpoint fails open:
    // empty array → industrialism defaults to 0 → no +30% bonuses fire,
    // but everything else still works.
    steps.setStep(3, 'active', { sub: 'Loading regions, countries, and game config' });
    const [regionsObj, allCountriesRaw, gameConfig, warerastatsCountries] = await Promise.all([
      adv_trpc('region.getRegionsObject', {}),
      adv_trpc('country.getAllCountries', {}),
      adv_trpc('gameConfig.getGameConfig', {}).catch(() => null),
      fetch(`${WARERASTATS_BASE}/countries`).then(r => r.json()).catch(() => []),
    ]);
    const cfgDepBonus = gameConfig?.company?.depositResourceBonus;
    if (typeof cfgDepBonus === 'number') GAME_DEPOSIT_BONUS = cfgDepBonus;
    const allCountries = Array.isArray(allCountriesRaw)
      ? allCountriesRaw
      : (allCountriesRaw?.items || []);

    const industrialismById = {};
    (Array.isArray(warerastatsCountries) ? warerastatsCountries : []).forEach(c => {
      if (c && c.countryId != null && c.industrialism != null) {
        industrialismById[c.countryId] = c.industrialism;
      }
    });

    steps.setStep(3, 'active', {
      sub: `Loading bonuses for ${allCountries.length} countries`,
      count: `0/${allCountries.length}`
    });
    const countryById = await loadCountriesParallel(allCountries);
    Object.values(countryById).forEach(c => {
      if (c && c._id in industrialismById) c.industrialism = industrialismById[c._id];
    });
    steps.setStep(3, 'done', { count: `${allCountries.length} loaded` });

    const regionsByCountry = {};
    Object.values(regionsObj).forEach(r => {
      if (!r?.country) return;
      (regionsByCountry[r.country] = regionsByCountry[r.country] || []).push(r);
    });

    const analyses = companies.filter(Boolean).map(c => {
      const a = analyseCompany(c, regionsObj, regionsByCountry, countryById);
      a.userWorksHere = ownCompaniesWhereUserWorks.has(c._id);
      return a;
    });
    return { username: resolved.username, userId, analyses };
  }

  function analyseCompany(company, allRegions, regionsByCountry, countryById) {
    const currentRegion  = allRegions[company.region];
    const currentCountry = currentRegion ? countryById[currentRegion.country] : null;
    const currentBonus   = computeBonus(currentCountry, currentRegion, company.itemCode);

    // Enumerate every (country, region) pair. Most produce 0 bonus and
    // get filtered later by sort; the search space is small enough that
    // brute force is cleaner than per-country shortlisting.
    const candidates = [];
    for (const cid in countryById) {
      const country = countryById[cid];
      if (!country) continue;
      const regs = regionsByCountry[cid] || [];
      for (const region of regs) {
        const bonus = computeBonus(country, region, company.itemCode);
        if (!bonus) continue;
        candidates.push({ country, region, ...bonus });
      }
    }

    const current = currentBonus
      ? { country: currentCountry, region: currentRegion, ...currentBonus }
      : null;
    return { company, current, candidates };
  }

  function scoreOf(c, userWorksHere) {
    return userWorksHere ? c.netMult : (1 + c.total / 100);
  }
  function scoreLabel(userWorksHere) {
    return userWorksHere ? 'take-home (after tax)' : 'production bonus';
  }

  function improvementFor(current, best, userWorksHere) {
    if (!current || !best) return 0;
    const cur = scoreOf(current, userWorksHere);
    const bst = scoreOf(best, userWorksHere);
    return (bst - cur) / cur * 100;
  }

  function evaluate(analysis) {
    const { current, candidates, userWorksHere } = analysis;
    if (!current || !candidates.length) {
      return { cls: 'optimal', text: 'No data', showAlt: false, best: null, sorted: [] };
    }
    const sorted = [...candidates].sort((a, b) => scoreOf(b, userWorksHere) - scoreOf(a, userWorksHere));
    const best = sorted[0];
    const sameRegion  = current.region?._id  === best.region?._id;
    const sameCountry = current.country?._id === best.country?._id;
    const imp = improvementFor(current, best, userWorksHere);
    const gainLabel = userWorksHere ? 'more take-home' : 'more output';

    if (sameRegion || imp < 0.1) {
      return { cls: 'optimal', text: '✓ Best placed', showAlt: false, best, sorted };
    }
    if (imp < OPTIMAL_THRESHOLD) {
      return {
        cls: 'optimal',
        text: `✓ Stay put · top option only +${fmt(imp, 1)}% ${gainLabel}`,
        showAlt: false, best, sorted
      };
    }
    const target = sameCountry
      ? best.region.name
      : `${best.region.name} (${best.country.name})`;
    if (imp >= HUGE_THRESHOLD) {
      return { cls: 'huge', text: `⚠ Move to ${target}: +${fmt(imp, 1)}% ${gainLabel}`, showAlt: true, best, sorted };
    }
    return { cls: 'move', text: `↻ Move to ${target}: +${fmt(imp, 1)}% ${gainLabel}`, showAlt: true, best, sorted };
  }

  function iconHtml(itemCode) {
    const it = ITEMS[itemCode];
    if (!it) return `<div class="icon-box"><span class="fallback">📦</span></div>`;
    return `<div class="icon-box"><img src="images/${it.file}" alt="${it.name}" onerror="this.outerHTML='<span class=\\'fallback\\'>${it.fb}</span>'"></div>`;
  }

  function renderSide(side, label, compareWith, userWorksHere) {
    if (!side || !side.country) return `<div class="side"><div style="color:var(--muted)">Unknown location</div></div>`;
    const breakdown = [];
    if (side.strategic)       breakdown.push(`Strategic resources: +${fmt(side.strategic)}%`);
    if (side.specialisation)  breakdown.push(`Industrialism: +${side.specialisation}%`);
    if (side.deposit) {
      const ttl = side.depositEndsAt ? new Date(side.depositEndsAt).getTime() - Date.now() : null;
      const left = (ttl !== null && ttl > 0) ? ` (${formatDuration(ttl)} left)` : '';
      breakdown.push(`Regional deposit: +${fmt(side.deposit)}%${left}`);
    }
    if (side.depositCountry)  breakdown.push(`Industrialism: +${fmt(side.depositCountry)}%`);
    const taxClass = side.tax >= 12 ? 'tax-high' : side.tax >= 8 ? 'tax-mid' : 'tax-low';

    const inlineDelta = (delta, higherIsBetter, threshold = 0.05) => {
      if (compareWith === undefined || delta === null || Math.abs(delta) < threshold) return '';
      const sign = delta > 0 ? '+' : '−';
      const abs  = Math.abs(delta);
      const good = (delta > 0) === higherIsBetter;
      const tip  = good
        ? `${fmt(abs)} percentage points better than your current location`
        : `${fmt(abs)} percentage points worse than your current location`;
      return `<span class="delta ${good ? 'good' : 'bad'}" title="${tip}">(${sign}${fmt(abs)} pp)</span>`;
    };
    const bonusDelta = compareWith ? inlineDelta(side.total - compareWith.total, true) : '';

    const relativeDelta = (current, better, higherIsBetter, label) => {
      if (compareWith === undefined || current === undefined) return '';
      const pct = (better - current) / current * 100;
      if (Math.abs(pct) < 0.05) return '';
      const sign = pct > 0 ? '+' : '−';
      const good = (pct > 0) === higherIsBetter;
      return `<span class="delta ${good ? 'good' : 'bad'}">(${sign}${fmt(Math.abs(pct), 1)}% ${label})</span>`;
    };

    const taxOpacity = userWorksHere ? '' : ' style="opacity: 0.55"';
    const summary = userWorksHere
      ? {
          label: 'Your take-home per work cycle',
          value: `${side.netMult.toFixed(3)}× base wage`,
          help:  'How much you keep after income tax, relative to a no-bonus country.',
          delta: compareWith ? relativeDelta(compareWith.netMult, side.netMult, true, 'more take-home') : ''
        }
      : {
          label: 'Output per work cycle',
          value: `${(1 + side.total / 100).toFixed(3)}× base`,
          help:  'How much product you produce vs. a no-bonus country.',
          delta: compareWith ? relativeDelta(1 + compareWith.total / 100, 1 + side.total / 100, true, 'more output') : ''
        };

    return `
      <div class="side">
        ${label ? `<div class="label">${label}</div>` : ''}
        <div class="country">
          <span class="region">${side.region?.name || '?'}</span>
          <span class="controller">currently controlled by</span>
          <span class="flag">${flag(side.country.code)}</span>
          <span class="controller">${side.country.name}</span>
        </div>
        <div class="stats">
          <span><span class="stat-label">Production bonus</span> <span class="stat-value pos">+${fmt(side.total)}%</span>${bonusDelta}</span>
          <span${taxOpacity}><span class="stat-label">Income tax</span> <span class="stat-value ${taxClass}">${fmt(side.tax)}%</span></span>
        </div>
        <div class="net" title="${summary.help}">
          <span class="stat-label">${summary.label}</span>
          <span><span class="net-val">${summary.value}</span>${summary.delta}</span>
        </div>
        ${breakdown.length ? `<div class="breakdown">${breakdown.join(' &nbsp;·&nbsp; ')}</div>` : ''}
      </div>
    `;
  }

  function renderCard(analysis) {
    const { company, current, userWorksHere } = analysis;
    const item = ITEMS[company.itemCode] || { name: company.itemCode };
    const verdict = evaluate(analysis);
    const showCompanyName = company.name && company.name !== item.name;
    const workerBadge = userWorksHere
      ? `<span class="worker-badge" title="You are one of this company's workers, so income tax applies to your earnings here.">👷 You work here</span>`
      : '';

    if (!current) {
      return `<div class="adv-card"><div class="card-head"><div class="title">${iconHtml(company.itemCode)}<span>${item.name}</span><a href="${companyUrlFor(company._id)}" target="_blank" rel="noopener" class="link-icon" title="Open this company in War Era"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg></a></div></div>
        <div class="body" style="color:var(--muted)">Could not analyse (missing region/country data).</div></div>`;
    }

    const body = verdict.showAlt
      ? `<div class="panels compare">
           ${renderSide(current, 'Currently in', undefined, userWorksHere)}
           <div class="arrow">→</div>
           ${renderSide(verdict.best, 'Better option', current, userWorksHere)}
         </div>`
      : `<div class="panels">
           ${renderSide(current, 'Currently in', undefined, userWorksHere)}
         </div>`;

    const top10 = verdict.sorted.slice(0, 10);
    const currentScore = current ? scoreOf(current, userWorksHere) : null;
    const altsHtml = top10.map((c, i) => {
      const isCurrent = c.country._id === current.country?._id && c.region._id === current.region?._id;
      const isWorse   = !isCurrent && currentScore !== null && scoreOf(c, userWorksHere) < currentScore;
      const headline = userWorksHere
        ? `${c.netMult.toFixed(3)}× base take-home`
        : `${(1 + c.total / 100).toFixed(3)}× base output`;
      const depositTtl = c.depositEndsAt ? new Date(c.depositEndsAt).getTime() - Date.now() : null;
      const depositTag = (depositTtl !== null && depositTtl > 0)
        ? ` <span style="color:var(--warn)" title="Bonus comes from a deposit; will revert when the deposit expires.">⏱ ${formatDuration(depositTtl)}</span>`
        : '';
      const classes = ['alt'];
      if (isCurrent) classes.push('curr');
      if (isWorse)   classes.push('worse');
      return `
        <div class="${classes.join(' ')}">
          <span><span class="rank">${i + 1}.</span><strong>${c.region.name}</strong> <span style="color:var(--muted)">${flag(c.country.code)} ${c.country.name}</span>${isCurrent ? ' <span style="color:var(--link)">(your current)</span>' : ''}</span>
          <span class="right">+${fmt(c.total)}% bonus${depositTag} &nbsp;·&nbsp; ${fmt(c.tax)}% income tax &nbsp;·&nbsp; <span class="v">${headline}</span></span>
        </div>`;
    }).join('');

    return `
      <div class="adv-card">
        <div class="card-head">
          <div class="title">
            ${iconHtml(company.itemCode)}
            <span>${item.name}</span>
            ${showCompanyName ? `<span class="sub-title">· ${company.name}</span>` : ''}
            <a href="${companyUrlFor(company._id)}" target="_blank" rel="noopener" class="link-icon" title="Open this company in War Era"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg></a>
            ${workerBadge}
          </div>
          <div class="verdict ${verdict.cls}">${verdict.text}</div>
          <span class="chev">▾</span>
        </div>
        <div class="body">${body}</div>
        <details class="alts-wrap">
          <summary>Top ${top10.length} region${top10.length === 1 ? '' : 's'} ranked by ${scoreLabel(userWorksHere)}</summary>
          <div class="alts">${altsHtml}</div>
        </details>
      </div>
    `;
  }

  function render() {
    if (!lastResult) return;
    const { username, analyses } = lastResult;
    const moveCount = analyses.filter(a => evaluate(a).showAlt).length;
    setStatus(
      moveCount > 0
        ? `Showing ${analyses.length} companies for ${username}. ${moveCount} could improve by moving.`
        : `Showing ${analyses.length} companies for ${username}. All optimally placed.`
    );
    $grid.innerHTML = analyses.map(renderCard).join('');
    $howto.classList.remove('hidden');
  }

  async function run() {
    const username = $username.value.trim();
    if (!username) { $username.focus(); return; }

    // Make the current advisor view shareable as a URL. replaceState keeps
    // the back-button history intact and (unlike a real navigation) does
    // not fire hashchange, so this won't trigger a re-activation loop.
    const newHash = `#advisor?u=${encodeURIComponent(username)}`;
    if (location.hash !== newHash) {
      history.replaceState(null, '', newHash + location.search);
    }

    $go.disabled = true;
    $hint.classList.add('hidden');
    setStatus('');
    $grid.innerHTML = '';
    $howto.classList.add('hidden');
    steps.reset();
    try {
      lastResult = await analyse(username);
      steps.fadeOut(400);
      render();
    } catch (e) {
      steps.hide();
      const friendly = isTransientError(e)
        ? `The data server is having a moment (${e.message}). Wait a few seconds and try again.`
        : `Error: ${e.message}`;
      setStatus(friendly, true);
    } finally {
      $go.disabled = false;
    }
  }

  $go.addEventListener('click', run);
  $username.addEventListener('keydown', e => { if (e.key === 'Enter') run(); });

  $grid.addEventListener('click', e => {
    if (e.target.closest('details, summary, button, a')) return;
    const card = e.target.closest('.adv-card');
    if (!card) return;
    if (e.target.closest('.card-head')) {
      card.classList.toggle('expanded');
    }
  });

  return {
    /**
     * Called by the router every time this view becomes active. Idempotent:
     * if the username param differs from what's already in the input, the
     * field is updated and analysis re-runs. Otherwise it's a no-op (or
     * focuses the empty field).
     * @param {URLSearchParams} [params]
     */
    activate(params) {
      const u = (params && params.get('u'))
             || new URLSearchParams(location.search).get('u');
      if (u && $username.value !== u) {
        $username.value = u;
        run();
      } else if (!$username.value) {
        $username.focus();
      }
    }
  };
})();