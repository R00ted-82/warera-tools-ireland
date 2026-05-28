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
 *                      matches its specialisedItem, AND the item is covered
 *                      by the Fanatic Industrialist trait (which says "ammo
 *                      or construction specialization good"). The
 *                      AGRARIAN_ITEMS set lists items NOT covered — food,
 *                      plants, pills. Verified: Bulgaria/steak (ind=+2)
 *                      no +30, Morocco/cocain (Fanatic Industrialist) no
 *                      +30, but South Africa/steel and Guinea-Bissau/lead
 *                      and Egypt/iron all do get +30.
 *    deposit         — region.deposit.bonusPercent, fires when the region
 *                      has an active matching deposit, EXCEPT when the
 *                      country specialises in the item AND is industrialist
 *                      (in which case the deposit is suppressed; this is a
 *                      generalisation of Fanatic Industrialist's "deposits
 *                      cannot spawn within your borders" trait). Stacks
 *                      with strategic when the country specialises but is
 *                      NOT industrialist — verified Brazil/coca/Recife:
 *                      +15 strategic + +30 deposit = +45. Does NOT stack
 *                      when the country IS industrialist — verified
 *                      Egypt/iron/Ouham: +32 strategic + +30 specialisation
 *                      = +62, deposit suppressed despite being active.
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
 *  (+20), South Africa/steel (+34.25), Ireland/grain deposit (+60),
 *  Bulgaria/steak (+10 not +40 — pills/food not covered by trait),
 *  Morocco/cocain (+15.5 not +45.5 — Fanatic Industrialist trait does
 *  NOT cover pills), Egypt/iron/Ouham (+62 = +32 strategic + +30
 *  specialisation, deposit suppressed when country is industrialist),
 *  Brazil/coca/Recife (+45 = +15 strategic + +30 deposit — deposit stacks
 *  with non-industrialist specialisation), and others.
 *
 *  Bugs to NOT repeat:
 *  - DO put food/agrarian items in AGRARIAN_ITEMS — the +30 doesn't fire
 *    on them. Bulgaria/steak proves it.
 *  - DO put coca and cocain in AGRARIAN_ITEMS — the Fanatic Industrialist
 *    trait literally says "ammo or construction specialization good";
 *    plants and pills aren't covered. Morocco/cocain proves it for pills.
 *    Earlier we removed them based on misreading Brazil/coca, where the
 *    +30% turned out to come from a regional deposit, not from Industrialism.
 *  - DO keep the !(isSpecialised && industrialist) gate on hasMatchingDeposit;
 *    Egypt/iron proves deposits don't stack with industrialist specialisation.
 *  - Open question: the mirror case for agrarian-leaning countries (does
 *    an agrarian country's regional deposit still fire on its specialised
 *    item?) is unverified. If a Fanatic Agrarian country shows a miscount,
 *    that's where to look.
 *
 *  Access: restricted to Irish citizens (enforceIrishOnly from
 *  shared.js). The bypass=1 URL param lifts the restriction.
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

  // The +30% "Industrialism" bonus comes from the Fanatic Industrialist
  // ruling-party trait, which reads in-game: "All companies in your
  // borders get +30% bonus towards ammo or construction specialization
  // good. Deposits cannot spawn within your borders."
  //
  // The trait is gated by item category — it only fires on "ammo or
  // construction" items. This set lists items that DON'T qualify (i.e.
  // items where the +30% does NOT fire even when the country is Fanatic
  // Industrialist and specialises in the item).
  //
  // Verified non-eligible:
  //   - steak/bread/fish/cookedFish/livestock/grain (food/agrarian):
  //     Bulgaria/steak doesn't get +30 despite ind=+2.
  //   - cocain (pills): Morocco specialises in cocain, is Fanatic
  //     Industrialist, in-game shows +15.5% (strategic only, no +30).
  //   - coca (plants): no verified case of a Fanatic Industrialist
  //     country specialising in coca AND getting +30. Added by symmetry
  //     with pills — plants and pills aren't "ammo or construction"
  //     either. If a counter-example shows up, drop coca from this set.
  //
  // Verified eligible (where +30 does fire):
  //   - lead (ammo precursor): Guinea-Bissau/lead → +56 (=+26 strategic
  //     + +30 Industrialism).
  //   - steel: South Africa/steel → +34.25.
  //   - iron: Egypt/iron → +62 (=+32 strategic + +30 Industrialism).
  //   - heavyAmmo, ammo, lightAmmo, concrete: assumed eligible by the
  //     trait text ("ammo or construction"); not all directly verified
  //     but consistent with the rule.
  //
  // Misnamed — these aren't agrarian, they're "items the Fanatic
  // Industrialist trait doesn't cover". Kept as AGRARIAN_ITEMS for
  // backwards-compatibility with the rest of the file; rename if you
  // refactor to an inclusion list of ammo/construction items.
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
   *
   * Returns the resolved user's `country` alongside id/username so the
   * Irish-only gate has it without an extra call.
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
    if (exact) return { userId: exact._id, username: exact.username, country: exact.country, exact: true };

    if (!known.length) {
      console.warn('[advisor] Could not verify usernames; falling back to top search result.');
      return { userId: candidateIds[0], username, country: null, exact: false };
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
   *     when it's industrialist-leaning.
   *   • Deposit fires whenever there's an active matching deposit, EXCEPT
   *     when the country specialises in the item AND is industrialist
   *     (deposit suppressed — see header comment for verification).
   *   • DepositCountry (+30) additionally fires when the country is
   *     agrarian-leaning.
   */
  function computeBonus(country, region, itemCode) {
    if (!country) return null;

    const isSpecialised = country.specializedItem === itemCode;
    const lean          = ethicsLean(country);

    const strategic = isSpecialised
      ? (country.strategicResources?.bonuses?.productionPercent || 0)
      : 0;
    // Industrialism (spec) +30 fires only on items covered by the Fanatic
    // Industrialist trait ("ammo or construction"). Food, plants, and pills
    // (in AGRARIAN_ITEMS) don't qualify even when the country specialises
    // and is industrialist-leaning. The set name is historical — it
    // includes more than just food now. See AGRARIAN_ITEMS comment.
    const specialisation = isSpecialised
      && lean === 'industrialist'
      && !AGRARIAN_ITEMS.has(itemCode)
      ? 30 : 0;

    const hasMatchingDeposit = !!region?.deposit
      && region.deposit.type === itemCode
      && isDepositActive(region.deposit)
      && !(isSpecialised && lean === 'industrialist');
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

    // Irish-citizens-only gate. The bypass=1 URL param lifts this
    // for admin/debugging. Non-Irish users get a hard block here,
    // before any of the expensive company/country loading runs.
    enforceIrishOnly(resolved.country, resolved.username);

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

    // Make the current advisor view shareable as a URL. Preserve any
    // extra params (like bypass=1) the user came in with so they survive
    // the re-write — otherwise the gate can't see them after the run starts.
    // replaceState keeps back-button history intact and (unlike a real
    // navigation) does not fire hashchange, so this won't trigger a
    // re-activation loop.
    const existingQuery = location.hash.split('?')[1] || '';
    const params = new URLSearchParams(existingQuery);
    params.set('u', username);
    const newHash = `#advisor?${params.toString()}`;
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