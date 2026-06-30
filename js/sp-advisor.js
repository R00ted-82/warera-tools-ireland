/* ═══════════════════════════════════════════════════════════════════
 *  SKILL POINT ADVISOR — DOM wiring
 *
 *  Core math is pure client-side (no trpc needed for the calculator
 *  itself). Username lookup is OPTIONAL, additive auto-population:
 *  when the shell has a loaded username, we resolve it and pre-fill
 *  level/companies/workers from the real profile — but every field
 *  stays manually editable, and a failed lookup never touches
 *  existing values. Recomputes live on every input change (debounced
 *  lightly so rapid typing doesn't thrash the DOM).
 *
 *  Data sources (confirmed from a real captured response, not
 *  guessed — see project notes):
 *   - user.getUserLite({userId}) -> leveling.level (player level),
 *     leveling.availableSkillPoints (unspent SP), and skills.*level
 *     for all skills including entrepreneurship, energy, production,
 *     companies, management. Used to drive the live Current Allocation
 *     panel directly — no derivation needed.
 *   - company.getCompanies({userId, perPage}) -> { items: [companyId, ...] }.
 *     The items are ID strings, NOT full company objects, so worker
 *     counts are not attached here. companies owned = items.length.
 *     perPage must be passed (default page size is 10) or users with
 *     more than 10 companies get silently truncated.
 *   - worker.getWorkers({userId}) -> { workersPerCompany: [{ company,
 *     workers: [...] }, ...] }. Workers managed = sum of workers.length
 *     across every entry. Same source advisor/daily-profit/clockin use.
 *   - Username resolution follows the exact same anti-fuzzy pattern
 *     as buddy-finder.js: search.searchAnything for candidates, then
 *     verify by exact case-insensitive username match via
 *     user.getUserLite. Never falls back to a fuzzy top result.
 * ═══════════════════════════════════════════════════════════════════ */
const SkillPointAdvisorTool = (() => {
  const $level     = document.getElementById('spa-level');
  const $companies = document.getElementById('spa-companies');
  const $workers    = document.getElementById('spa-workers');
  const $totalSpHint = document.getElementById('spa-total-sp-hint');

  const $lookupStatus = document.getElementById('spa-lookup-status');
  const $error   = document.getElementById('spa-error');
  const $results = document.getElementById('spa-results');

  const $optimalBuild    = document.getElementById('spa-optimal-build');
  const $optimalLeftover = document.getElementById('spa-optimal-leftover');

  const $noResetsBuild = document.getElementById('spa-noresets-build');
  const $noResetsEmpty = document.getElementById('spa-noresets-empty');

  const $currentAlloc = document.getElementById('spa-current-alloc');
  const $currentBuild = document.getElementById('spa-current-build');
  const $spRemaining  = document.getElementById('spa-sp-remaining');

  const $ecoCard      = document.getElementById('spa-eco-card');
  const $warCard      = document.getElementById('spa-war-card');
  const $warBuild     = document.getElementById('spa-war-build');
  const $warUnspent   = document.getElementById('spa-war-unspent');
  const $warEmpty     = document.getElementById('spa-war-empty');
  const $buildTypeInputs    = document.querySelectorAll('input[name="spa-build-type"]');
  const $companiesField = document.getElementById('spa-companies-field');
  const $workersField   = document.getElementById('spa-workers-field');

  // Tracks the last username we successfully resolved, so re-activating
  // with the same ?u= (e.g. switching tabs and back) is a no-op rather
  // than re-fetching. A generation counter guards against a slow,
  // superseded lookup overwriting fields with stale data if the shell's
  // username changes again before the first lookup finishes.
  let lastResolvedUsername = null;
  let lookupGeneration = 0;

  function showLookupStatus(level, html) {
    $lookupStatus.className = `spa-lookup-status ${level}`;
    $lookupStatus.innerHTML = html;
    $lookupStatus.classList.remove('hidden');
  }
  function hideLookupStatus() {
    $lookupStatus.classList.add('hidden');
    $lookupStatus.innerHTML = '';
  }

  function showError(msg) {
    $error.textContent = msg;
    $error.classList.remove('hidden');
    $results.classList.add('hidden');
    $currentAlloc.classList.add('hidden');
    $spRemaining.classList.add('hidden');
  }
  function hideError() {
    $error.classList.add('hidden');
    $results.classList.remove('hidden');
  }

  function buildChip(label, level, value, unitSuffix) {
    return `
      <div class="spa-build-chip">
        <span class="k">${escapeHtml(label)}</span>
        <span class="v">Lv ${level}<small>${unitSuffix ? escapeHtml(unitSuffix) : ''}</small></span>
      </div>
    `;
  }

  function renderBuild($el, { companiesLevel, managementLevel, entL, eneL, prodL }) {
    const chips = [
      buildChip('🏢 Companies', companiesLevel, null, `(${companiesCap(companiesLevel)})`),
      buildChip('🙍 Management', managementLevel, null, `(${managementWorkers(managementLevel)})`),
    ];
    if (entL !== null) chips.push(buildChip('💡 Entrepreneurship', entL, null, `(${entrepreneurshipValue(entL)})`));
    if (eneL !== null) chips.push(buildChip('⚡ Energy', eneL, null, `(${energyValue(eneL)})`));
    if (prodL !== null) chips.push(buildChip('⛏️ Production', prodL, null, `(${productionValue(prodL)})`));
    $el.innerHTML = chips.join('');
  }

  /* ── Username resolution — same anti-fuzzy pattern as buddy-finder.js ── */
  async function resolveUsername(username) {
    const needle = username.trim().toLowerCase();
    if (!needle) return null;

    const searchRes = await trpc('search.searchAnything', { searchText: username }, { retry: true });
    const candidateIds = (searchRes?.userIds || []).slice(0, 10);
    if (candidateIds.length === 0) return null;

    for (const id of candidateIds) {
      let u;
      try { u = await trpc('user.getUserLite', { userId: id }, { retry: true }); }
      catch { continue; }
      if (u && typeof u.username === 'string' && u.username.toLowerCase() === needle) {
        return u;
      }
    }
    return null;
  }

  /* ── Auto-population from a resolved profile ─────────────────────
   *  Called from activate() AFTER the initial recompute() already ran
   *  (see activate() below) — so these early returns don't need their
   *  own recompute() call; the fields are already showing a correct
   *  result for whatever was in them before this lookup started. */
  async function autoPopulate(rawUsername) {
    const needle = rawUsername.trim().toLowerCase();
    if (!needle) return;
    if (needle === (lastResolvedUsername || '').toLowerCase()) {
      // Already resolved this exact username before — per the shell's
      // idempotency contract, don't re-fetch.
      return;
    }

    const myGeneration = ++lookupGeneration;
    showLookupStatus('info', `<span class="bf-spinner"></span>Looking up <strong>${escapeHtml(rawUsername)}</strong>…`);

    let user;
    try {
      user = await resolveUsername(rawUsername);
    } catch (e) {
      if (myGeneration !== lookupGeneration) return; // superseded by a newer lookup
      showLookupStatus('error', `Couldn't reach the War Era Gateway. ${escapeHtml(e.message)}`);
      return;
    }
    if (myGeneration !== lookupGeneration) return; // a newer lookup has since started

    if (!user) {
      showLookupStatus('error', `No War Era user found with username <strong>${escapeHtml(rawUsername)}</strong>. Your manually entered values are unchanged.`);
      return;
    }

    let companies, workersData;
    try {
      [companies, workersData] = await Promise.all([
        trpc('company.getCompanies', { userId: user._id, perPage: 100 }, { retry: true }),
        trpc('worker.getWorkers', { userId: user._id }, { retry: true }),
      ]);
    } catch (e) {
      if (myGeneration !== lookupGeneration) return;
      showLookupStatus('error', `Found ${escapeHtml(user.username)}, but couldn't load their companies. ${escapeHtml(e.message)}`);
      return;
    }
    if (myGeneration !== lookupGeneration) return;

    // company.getCompanies returns { items: [companyId, ...] } — the items are
    // ID strings, not full company objects, so worker counts are NOT attached
    // here. Workers come from worker.getWorkers -> workersPerCompany, the same
    // source advisor/daily-profit/clockin use.
    const companyList = Array.isArray(companies) ? companies : (companies?.items || []);
    const numCompanies = companyList.length;
    const numWorkers = (workersData?.workersPerCompany || [])
      .reduce((sum, entry) => sum + (entry?.workers?.length || 0), 0);
    const level = user?.leveling?.level;

    if (!Number.isFinite(level)) {
      showLookupStatus('error', `Found ${escapeHtml(user.username)}, but couldn't read their level from the profile. Your manually entered values are unchanged.`);
      return;
    }

    lastResolvedUsername = user.username;
    $level.value = level;
    $companies.value = Math.max(2, numCompanies); // 2 is the game's free floor
    $workers.value = numWorkers;

    // Current allocation — live in-game skill levels from the API
    const s = user.skills || {};
    renderBuild($currentBuild, {
      companiesLevel:  s.companies?.level      ?? 0,
      managementLevel: s.management?.level     ?? 0,
      entL:            s.entrepreneurship?.level ?? null,
      eneL:            s.energy?.level          ?? null,
      prodL:           s.production?.level      ?? null,
    });
    const availableSP = user.leveling?.availableSkillPoints ?? 0;
    if (availableSP > 0) {
      $spRemaining.innerHTML = `<span class="spa-remain-count">${availableSP} SP unspent</span> — being saved for your next level-up upgrade.`;
      $spRemaining.classList.remove('hidden');
    } else {
      $spRemaining.innerHTML = '';
      $spRemaining.classList.add('hidden');
    }
    $currentAlloc.classList.remove('hidden');

    showLookupStatus('success', `✅ Auto-filled from <strong>${escapeHtml(user.username)}</strong>'s profile. Adjust any field below if you want to try a different scenario.`);
    recompute();
    setTimeout(() => {
      // Only clear if nothing newer has replaced this message in the meantime.
      if (myGeneration === lookupGeneration) hideLookupStatus();
    }, 5000);

    // Match the shell's hash-rewrite contract (same as advisor/clockin/etc.):
    // write our own canonical-username hash so the shell's guard folds it
    // back into #home?u=...&tool=sp-advisor and commits it to the recent list.
    const newHash = `#sp-advisor?u=${encodeURIComponent(user.username)}`;
    if (location.hash !== newHash) {
      history.replaceState(null, '', newHash + location.search);
    }
  }

  function selectedBuildType() {
    for (const r of $buildTypeInputs) { if (r.checked) return r.value; }
    return 'eco';
  }

  const WAR_SKILL_DEFS = [
    { key: 'attack',     label: '⚔️ Attack'      },
    { key: 'precision',  label: '🎯 Precision'    },
    { key: 'critChance', label: '🎲 Crit Chance'  },
    { key: 'critDamage', label: '💥 Crit Damage'  },
    { key: 'armor',      label: '🛡️ Armor'        },
    { key: 'dodge',      label: '💨 Dodge'        },
    { key: 'health',     label: '❤️ Health'       },
    { key: 'loot',       label: '💰 Loot'         },
    { key: 'hunger',     label: '🍖 Hunger'       },
    { key: 'companies',  label: '🏢 Companies'    },
  ];

  function renderWarBuild(level) {
    const row = lookupWarBuildTable(level);
    if (!row) {
      $warBuild.innerHTML = '';
      $warUnspent.textContent = '';
      $warEmpty.classList.remove('hidden');
      return;
    }
    $warEmpty.classList.add('hidden');
    // Companies is always Lv 4 for war build (6 companies active)
    const display = { ...row, companies: 4 };
    $warBuild.innerHTML = WAR_SKILL_DEFS.map(({ key, label }) =>
      buildChip(label, display[key], null, '')
    ).join('');
    $warUnspent.textContent = display.unspentSP > 0
      ? `${display.unspentSP} SP left unspent — save it for your next level-up upgrade.`
      : '';
  }

  function recompute() {
    const level = parseInt($level.value, 10);
    const numCompanies = parseInt($companies.value, 10);
    const numWorkers = parseInt($workers.value, 10);

    if (!Number.isFinite(level) || level < 1) {
      showError('Enter a valid player level (1 or higher).');
      return;
    }
    if (!Number.isFinite(numCompanies) || numCompanies < 2) {
      showError('Companies owned must be 2 or higher (everyone starts with 2 free).');
      return;
    }
    if (!Number.isFinite(numWorkers) || numWorkers < 0) {
      showError('Workers managed must be 0 or higher.');
      return;
    }

    const advice = computeAdvice({ level, numCompanies, numWorkers });

    $totalSpHint.textContent = `= ${level * 4} SP total`;

    if (advice.error) {
      showError(advice.error);
      $currentAlloc.classList.add('hidden');
      return;
    }
    hideError();

    const buildType = selectedBuildType();

    if (buildType === 'war') {
      $companiesField.classList.add('spa-field-hidden');
      $workersField.classList.add('spa-field-hidden');
      $ecoCard.classList.add('hidden');
      $warCard.classList.remove('hidden');
      renderWarBuild(level);
      return;
    }

    // Eco mode
    $companiesField.classList.remove('spa-field-hidden');
    $workersField.classList.remove('spa-field-hidden');
    $warCard.classList.add('hidden');
    $ecoCard.classList.remove('hidden');

    // Current allocation panel is populated by autoPopulate() from live API data.
    // recompute() does not touch it — if no username has been looked up it stays hidden.

    // Absolute optimum (hidden card — still computed, just not shown)
    const opt = advice.allocation;
    renderBuild($optimalBuild, {
      companiesLevel: advice.companiesLevel,
      managementLevel: advice.managementLevel,
      entL: opt.entL, eneL: opt.eneL, prodL: opt.prodL,
    });
    if (advice.leftoverSP > 0) {
      $optimalLeftover.textContent = `${advice.leftoverSP} SP left unspent — not enough for the next upgrade in any skill yet. Save it.`;
      $optimalLeftover.classList.remove('hidden');
    } else {
      $optimalLeftover.textContent = '';
    }

    // Recommended (no-resets / Eco Mode) path
    if (advice.noResets) {
      const nr = advice.noResets;
      renderBuild($noResetsBuild, {
        companiesLevel: advice.companiesLevel,
        managementLevel: advice.managementLevel,
        entL: nr.entL, eneL: nr.eneL, prodL: nr.prodL,
      });
      $noResetsEmpty.classList.add('hidden');
    } else {
      $noResetsBuild.innerHTML = '';
      $noResetsEmpty.classList.remove('hidden');
    }
  }

  // Debounce so rapid typing/arrow-key-holding doesn't thrash re-renders.
  let debounceTimer = null;
  function scheduleRecompute() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(recompute, 150);
  }

  [$level, $companies, $workers].forEach($el => {
    $el.addEventListener('input', scheduleRecompute);
  });
  $buildTypeInputs.forEach($el => {
    $el.addEventListener('change', scheduleRecompute);
  });

  return {
    /**
     * Router/shell entry. If the shell has a loaded username (params.get('u')),
     * auto-populate from that profile — but only if it's actually new (per the
     * idempotency contract every shell tool follows). With no username, this
     * is a pure no-op beyond the initial recompute(), exactly as before.
     */
    activate(params) {
      // Always render immediately with whatever's currently in the fields
      // (defaults, or values from a previous visit) — this must never be
      // gated behind a username lookup. The lookup below is purely
      // additive: if it succeeds, it overwrites the fields and calls
      // recompute() again with the real data. If it fails or there's no
      // username at all, this first recompute() is the only one, and the
      // cards still show a correct result for the current field values.
      recompute();

      const u = params && params.get('u');
      if (u) {
        autoPopulate(u);
      }
    },
  };
})();