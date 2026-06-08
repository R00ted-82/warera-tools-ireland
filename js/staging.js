/* ═══════════════════════════════════════════════════════════════════
 *  UNIFIED IRISH TOOLKIT (prototype, staging)
 *
 *  A single-page shell over the four username/data tools. The user loads
 *  their name once; switching sub-tabs runs each tool for that name with
 *  no bouncing back to the home screen.
 *
 *  Reuse without rewrite: each tool is a self-contained IIFE whose DOM
 *  refs are captured once. They stay valid when the nodes are reparented,
 *  so this shell MOVES each tool's <section class="view"> into its mount
 *  and drives it through the tool's existing activate({u}). Nothing in
 *  mu/buddy-finder/advisor/clockin.js changes; borrowed views are handed
 *  back the moment the user leaves staging.
 *
 *  This iteration adds three things:
 *    1. Background prefetch. On entry we warm every username-independent
 *       bulk endpoint into the shared trpc cache, so by the time a name
 *       is typed the heavy data is already loaded.
 *    2. Gated display. Nothing is shown until a username is entered.
 *    3. Recent usernames. Last 3 are kept in localStorage as quick-pick
 *       chips, handy for long names.
 * ═══════════════════════════════════════════════════════════════════ */
const StagingTool = (() => {
  const DEFAULT_TOOL       = 'mu';
  const DEFAULT_AFTER_LOAD = 'advisor';   // user typed a name, show their data
  const TOOLS              = ['mu', 'buddy-finder', 'advisor', 'clockin'];
  const USERNAME_DRIVEN    = new Set(['buddy-finder', 'advisor', 'clockin']);

  const MODULES = {
    mu:             () => MUTool,
    'buddy-finder': () => BuddyFinderTool,
    advisor:        () => AdvisorTool,
    clockin:        () => ClockInTool,
  };

  const $mount    = document.getElementById('stg-mount');
  const $nav      = document.getElementById('stg-nav');
  const $username = document.getElementById('stg-username');
  const $load     = document.getElementById('stg-load');
  const $hint     = document.getElementById('stg-idbar-hint');
  const $empty    = document.getElementById('stg-empty');
  const $emptySub = document.getElementById('stg-empty-sub');
  const $recent   = document.getElementById('stg-recent');

  const state = { active: null, username: '', mounted: false, pendingTool: null };

  /* ── View hosting (reparent existing tool views) ────────── */
  const VIEW = {}; // tool -> { el, placeholder, hosted }
  function capture(tool) {
    if (VIEW[tool]) return VIEW[tool];
    const el = document.querySelector(`.view[data-view="${tool}"]`);
    if (!el) return null;
    VIEW[tool] = { el, placeholder: document.createComment(`stg:${tool}`), hosted: false };
    return VIEW[tool];
  }
  function hideTargets(tool) {
    const v = VIEW[tool]; if (!v) return [];
    const t = [];
    if (tool === 'advisor' || tool === 'clockin') {
      t.push(v.el.querySelector('.tool-header'));
    }
    if (tool === 'buddy-finder') {
      const inp  = v.el.querySelector('#bf-match-username');
      const row  = inp && inp.closest('.bf-input-row');
      const card = inp && inp.closest('.bf-card');
      t.push(row);
      if (card) t.push(card.querySelector('.bf-card-sub'));
    }
    return t.filter(Boolean);
  }
  function setHidden(tool, on) {
    hideTargets(tool).forEach(el => el.classList.toggle('stg-hide', on));
  }
  function host(tool) {
    const v = capture(tool); if (!v || v.hosted) return;
    v.el.parentNode.insertBefore(v.placeholder, v.el);
    $mount.appendChild(v.el);
    v.hosted = true;
    setHidden(tool, true);
  }
  function restore(tool) {
    const v = VIEW[tool]; if (!v || !v.hosted) return;
    setHidden(tool, false);
    if (v.placeholder.parentNode) {
      v.placeholder.parentNode.insertBefore(v.el, v.placeholder);
      v.placeholder.remove();
    }
    v.hosted = false;
  }
  function restoreAll() { TOOLS.forEach(restore); }

  /* ── Hash guard ─────────────────────────────────────────
   *  Hosted tools rewrite the address bar when they run. While the shell
   *  is showing we pin the URL to #staging. Reversible: the native
   *  replaceState is restored on leave. */
  let nativeReplace = null;
  function installHashGuard() {
    if (nativeReplace) return;
    nativeReplace = history.replaceState.bind(history);
    history.replaceState = function (s, t, url) {
      if (typeof url === 'string' && /^#(mu|buddy-finder|advisor|clockin)\b/.test(url)) url = '#staging';
      return nativeReplace(s, t, url);
    };
  }
  function removeHashGuard() {
    if (!nativeReplace) return;
    history.replaceState = nativeReplace;
    nativeReplace = null;
  }

  /* ── Background prefetch ─────────────────────────────────
   *  Warm the username-independent bulk data into the shared trpc cache
   *  so the tools find it hot. Fire-and-forget; failures are swallowed
   *  (the tools refetch on demand). Runs once per entry. */
  let prefetchStarted = false;

  function walkPaginated(endpoint, baseInput) {
    let cursor, safety = 0;
    (async () => {
      while (safety++ < 200) {
        const input = { ...baseInput, limit: 100 };
        if (cursor) input.cursor = cursor;
        let page;
        try { page = await trpc(endpoint, input, { retry: true }); }
        catch { break; }
        const arr  = page?.items ?? page?.data ?? (Array.isArray(page) ? page : []);
        const next = page?.nextCursor ?? page?.cursor ?? null;
        if (!next || arr.length === 0) break;
        cursor = next;
      }
    })();
  }

  async function warmCountries(arr) {
    const chunk = 20;
    for (let i = 0; i < arr.length; i += chunk) {
      await Promise.allSettled(
        arr.slice(i, i + chunk).map(c =>
          c?._id ? trpc('country.getCountryById', { countryId: c._id }, { retry: true }) : null)
      );
    }
  }

  function markReady() {
    if (!$emptySub) return;
    $emptySub.textContent = 'Data ready. Enter your username to begin.';
    $emptySub.classList.add('ready');
  }

  function prefetch() {
    if (prefetchStarted) return;
    prefetchStarted = true;

    // Migration Advisor's heavy block (also the default post-load view).
    const countriesP = trpc('country.getAllCountries', {}).catch(() => null);
    trpc('region.getRegionsObject', {}).catch(() => {});
    trpc('gameConfig.getGameConfig', {}).catch(() => {});
    fetch(`${WARERASTATS_BASE}/countries`).catch(() => {});
    countriesP.then(list => {
      const arr = Array.isArray(list) ? list : (list?.items || []);
      warmCountries(arr).then(markReady);
    });

    // MU + Buddy Finder share the Irish citizen list; MU also needs the MU list.
    walkPaginated('mu.getManyPaginated', {});
    walkPaginated('user.getUsersByCountry', { countryId: IRELAND_COUNTRY_ID });
  }

  /* ── Recent usernames (localStorage, last 3) ─────────────
   *  Stored most-recent-first, deduped case-insensitively. Saved on Load
   *  (not on verified resolution), so a typo can land here, cheap to drop
   *  via the x and not worth hooking the tools' resolvers. Best-effort:
   *  a disabled/full localStorage degrades to "no chips". */
  const RECENT_KEY = 'stg:recent-usernames';
  const RECENT_MAX = 3;

  function readRecent() {
    try {
      const arr = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
      return Array.isArray(arr) ? arr.filter(s => typeof s === 'string') : [];
    } catch { return []; }
  }
  function writeRecent(list) {
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX))); }
    catch { /* storage unavailable: chips just won't persist */ }
  }
  function rememberUsername(name) {
    const u = (name || '').trim();
    if (!u) return;
    const list = readRecent().filter(x => x.toLowerCase() !== u.toLowerCase());
    list.unshift(u);
    writeRecent(list);
    renderRecent();
  }
  function forgetUsername(name) {
    writeRecent(readRecent().filter(x => x.toLowerCase() !== name.toLowerCase()));
    renderRecent();
  }
  function renderRecent() {
    const list = readRecent();
    if (!list.length) { $recent.innerHTML = ''; $recent.classList.add('hidden'); return; }
    $recent.classList.remove('hidden');
    $recent.innerHTML =
      `<span class="stg-recent-label">Recent:</span>` +
      list.map(u => {
        const safe = escapeHtml(u);
        return `<span class="stg-recent-chip">
          <button class="stg-recent-pick" data-stg-recent="${safe}">${safe}</button>
          <button class="stg-recent-del" data-stg-recent-del="${safe}" title="Remove">×</button>
        </span>`;
      }).join('');
  }

  /* ── Gate ───────────────────────────────────────────────── */
  function revealTools() {
    $nav.classList.remove('hidden');
    $mount.classList.remove('hidden');
    $empty.classList.add('hidden');
  }
  function gateTools() {
    $nav.classList.add('hidden');
    $mount.classList.add('hidden');
    $empty.classList.remove('hidden');
  }

  /* ── Driving the active tool ─────────────────────────────
   *  Tools' activate() is idempotent: it re-runs only when the passed ?u=
   *  differs from their own input, so repeated calls are safe no-ops. */
  function driveActive() {
    const mod = MODULES[state.active] && MODULES[state.active]();
    if (!mod || typeof mod.activate !== 'function') return;
    const params = new URLSearchParams();
    if (USERNAME_DRIVEN.has(state.active) && state.username) params.set('u', state.username);
    try { mod.activate(params); }
    catch (e) { console.error(`[staging] activate ${state.active} failed`, e); }
  }

  function updateHint() {
    $hint.innerHTML = USERNAME_DRIVEN.has(state.active)
      ? `Your username is reused across Buddy Finder, Migration and Clock-In.`
      : `Military Units don't need a username. Pick another tool to use yours.`;
  }

  function selectTool(tool, { run = true } = {}) {
    if (!TOOLS.includes(tool)) tool = DEFAULT_TOOL;
    if (state.active === tool) { if (run) driveActive(); return; }
    if (state.active) restore(state.active);
    state.active = tool;
    host(tool);
    $nav.querySelectorAll('.stg-tab').forEach(b =>
      b.classList.toggle('active', b.dataset.stgTab === tool));
    $mount.dataset.active = tool;
    updateHint();
    if (run) driveActive();
  }

  function loadUsername() {
    const u = $username.value.trim();
    if (!u) { $username.focus(); return; }
    state.username = u;
    rememberUsername(u);
    revealTools();
    if (!state.active) selectTool(state.pendingTool || DEFAULT_AFTER_LOAD);
    else driveActive();              // re-run current tool with the new name
    state.pendingTool = null;
  }

  /* ── Wire-up ────────────────────────────────────────────── */
  $nav.addEventListener('click', e => {
    const btn = e.target.closest('.stg-tab');
    if (btn) selectTool(btn.dataset.stgTab);
  });
  $load.addEventListener('click', loadUsername);
  $username.addEventListener('keydown', e => { if (e.key === 'Enter') loadUsername(); });
  $recent.addEventListener('click', e => {
    const del = e.target.closest('[data-stg-recent-del]');
    if (del) { forgetUsername(del.dataset.stgRecentDel); return; }
    const pick = e.target.closest('[data-stg-recent]');
    if (pick) { $username.value = pick.dataset.stgRecent; loadUsername(); }
  });

  // Leaving staging: turn off the shared cache (clears it), hand the
  // borrowed views back, and reset so the next entry re-warms cleanly.
  window.addEventListener('hashchange', () => {
    const view = location.hash.replace(/^#/, '').split('?')[0] || 'home';
    if (view !== 'staging' && state.mounted) {
      removeHashGuard();
      setTrpcCache(false);
      restoreAll();
      state.mounted = false;
      state.active = null;
      prefetchStarted = false;
    }
  });

  return {
    /**
     * Router entry. Supports #staging?tool=advisor&u=toie for deep links.
     * @param {URLSearchParams} [params]
     */
    activate(params) {
      state.mounted = true;
      installHashGuard();
      setTrpcCache(true);
      prefetch();
      renderRecent();

      const tool = (params && TOOLS.includes(params.get('tool'))) ? params.get('tool') : null;
      const u = (params && params.get('u')) || state.username || '';

      if (u) {
        $username.value = u;
        state.username = u;
        rememberUsername(u);
        revealTools();
        selectTool(tool || state.active || DEFAULT_AFTER_LOAD);
      } else {
        gateTools();
        state.pendingTool = tool;
      }
    },
  };
})();