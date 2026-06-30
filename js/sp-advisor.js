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
 *   - user.getUserLite({userId}) -> leveling.level (player level).
 *     Official documented schema confirms this field exists on the
 *     LITE endpoint, no need for the heavier getUserById.
 *   - company.getCompanies({userId}) -> array of company objects,
 *     each with workerCount already attached. companies owned =
 *     array.length; workers managed = sum of workerCount across the
 *     array. Confirmed from a real capture showing workerCount on
 *     individual company objects (including 0 for unstaffed
 *     companies — they appear in the array, not omitted).
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
    $el.innerHTML = [
      buildChip('💡 Entrepreneurship', entL, null, `(${entrepreneurshipValue(entL)})`),
      buildChip('⚡ Energy', eneL, null, `(${energyValue(eneL)})`),
      buildChip('⛏️ Production', prodL, null, `(${productionValue(prodL)})`),
      buildChip('🏢 Companies', companiesLevel, null, `(${companiesCap(companiesLevel)})`),
      buildChip('🙍 Management', managementLevel, null, `(${managementWorkers(managementLevel)})`),
    ].join('');
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

    let companies;
    try {
      companies = await trpc('company.getCompanies', { userId: user._id, perPage: 100 }, { retry: true });
    } catch (e) {
      if (myGeneration !== lookupGeneration) return;
      showLookupStatus('error', `Found ${escapeHtml(user.username)}, but couldn't load their companies. ${escapeHtml(e.message)}`);
      return;
    }
    if (myGeneration !== lookupGeneration) return;

    const companyList = Array.isArray(companies) ? companies : (companies?.items || []);
    const numCompanies = companyList.length;
    const numWorkers = companyList.reduce((sum, c) => sum + (Number(c?.workerCount) || 0), 0);
    const level = user?.leveling?.level;

    if (!Number.isFinite(level)) {
      showLookupStatus('error', `Found ${escapeHtml(user.username)}, but couldn't read their level from the profile. Your manually entered values are unchanged.`);
      return;
    }

    lastResolvedUsername = user.username;
    $level.value = level;
    $companies.value = Math.max(2, numCompanies); // 2 is the game's free floor
    $workers.value = numWorkers;

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
      return;
    }
    hideError();

    // Absolute optimum
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

    // No-resets path
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