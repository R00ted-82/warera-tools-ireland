/* ═══════════════════════════════════════════════════════════════════
 *  UNIFIED IRISH TOOLKIT (prototype, staging)
 *
 *  A single-page shell over the four username/data tools. The user
 *  loads their name once; switching sub-tabs runs each tool for that
 *  name without bouncing back to the home screen.
 *
 *  Reuse without rewrite: each existing tool is a self-contained IIFE
 *  whose DOM references are captured once at load. Those references
 *  stay valid when the nodes are reparented, so this shell MOVES each
 *  tool's <section class="view"> into its mount and drives it through
 *  the tool's existing activate({u}) entry point. Nothing in mu.js /
 *  buddy-finder.js / advisor.js / clockin.js changes, and the
 *  standalone routes keep working: borrowed views are restored to
 *  their home position the moment the user leaves staging.
 * ═══════════════════════════════════════════════════════════════════ */
const StagingTool = (() => {
  const DEFAULT_TOOL    = 'mu';
  const TOOLS           = ['mu', 'buddy-finder', 'advisor', 'clockin'];
  const USERNAME_DRIVEN = new Set(['buddy-finder', 'advisor', 'clockin']);

  // Modules resolved lazily (they're globals defined by the tool files).
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

  const state = { active: null, username: '', mounted: false };

  /* ── View hosting (reparent existing tool views) ────────── */
  const VIEW = {}; // tool -> { el, placeholder, hosted }
  function capture(tool) {
    if (VIEW[tool]) return VIEW[tool];
    const el = document.querySelector(`.view[data-view="${tool}"]`);
    if (!el) return null;
    VIEW[tool] = { el, placeholder: document.createComment(`stg:${tool}`), hosted: false };
    return VIEW[tool];
  }

  // Tool chrome we hide because the shell provides one shared username
  // bar. JS-driven (not fragile CSS) and fully reversible on restore.
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
      if (card) t.push(card.querySelector('.bf-card-sub')); // the "enter username" prompt
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
   *  Each hosted tool self-manages its address bar (advisor rewrites to
   *  #advisor?u=… when it runs, etc.). While the shell is showing we
   *  pin the URL to #staging by intercepting those rewrites. Contained
   *  and reversible: the native replaceState is restored on leave.
   *  Prototype-stage shim; a proper fix is to split the tools into
   *  engine + view binding so they don't own the hash at all. */
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

  /* ── Driving the active tool ─────────────────────────────
   *  Tools' activate() is idempotent: it only re-runs when the passed
   *  ?u= differs from their own input, so calling this repeatedly with
   *  the same name is a safe no-op. */
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
      ? `Enter your username once. It's reused across Buddy Finder, Migration and Clock-In.`
      : `Military Units load automatically. Pick another tool to use your username.`;
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
    // From MU (no username needed) jump straight to a tool that uses it
    // so the user immediately sees their data. Otherwise just re-run.
    if (!USERNAME_DRIVEN.has(state.active)) selectTool('advisor');
    else driveActive();
  }

  /* ── Wire-up ────────────────────────────────────────────── */
  $nav.addEventListener('click', e => {
    const btn = e.target.closest('.stg-tab');
    if (btn) selectTool(btn.dataset.stgTab);
  });
  $load.addEventListener('click', loadUsername);
  $username.addEventListener('keydown', e => { if (e.key === 'Enter') loadUsername(); });

  // Leaving staging: hand the borrowed views back so standalone routes
  // work unchanged. Registered before router.js, so this runs first;
  // the router's own hashchange then toggles the restored views.
  window.addEventListener('hashchange', () => {
    const view = location.hash.replace(/^#/, '').split('?')[0] || 'home';
    if (view !== 'staging' && state.mounted) {
      removeHashGuard();
      restoreAll();
      state.mounted = false;
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
      const u = params && params.get('u');
      if (u) { $username.value = u; state.username = u; }
      const tool = (params && params.get('tool')) || state.active || DEFAULT_TOOL;
      selectTool(tool);
    },
  };
})();