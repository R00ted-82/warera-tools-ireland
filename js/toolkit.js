/* ═══════════════════════════════════════════════════════════════════
 *  UNIFIED IRISH TOOLKIT  (powers the #home view)
 *
 *  A single-page shell over the four username/data tools. The user loads
 *  their name once; switching sub-tabs runs each tool for that name with
 *  no bouncing back to a landing screen. This is now the default Irish
 *  tools view (#home); it began life as the "staging" prototype, hence
 *  the StagingTool name kept here to avoid churn.
 *
 *  Reuse without rewrite: each tool is a self-contained IIFE whose DOM
 *  refs are captured once. They stay valid when the nodes are reparented,
 *  so this shell MOVES each tool's <section class="view"> into its mount
 *  and drives it through the tool's existing activate({u}). Nothing in
 *  mu/buddy-finder/advisor/clockin.js changes; borrowed views are handed
 *  back the moment the user leaves home.
 *
 *  Features:
 *    1. Background prefetch. On entry we warm every username-independent
 *       bulk endpoint into the shared trpc cache, so by the time a name
 *       is typed the heavy data is already loaded.
 *    2. Gated display. Nothing is shown until a username is entered.
 *    3. Recent usernames. Last 3 are kept in localStorage as quick-pick
 *       chips, handy for long names. Saved only on SUCCESSFUL resolution
 *       (see the hash guard), so failed searches never pollute the list.
 *    4. URL sync. The address bar tracks the loaded user + active tool as
 *       #home?u=<name>&tool=<tool>, so the view is deep-linkable and
 *       shareable, and switching users updates it.
 *    5. Nav overflow fade. On mobile the tool pills scroll horizontally;
 *       a right-edge fade signals there are more off-screen, and clears
 *       once scrolled to the end.
 * ═══════════════════════════════════════════════════════════════════ */
const ToolkitShell = (() => {
  const DEFAULT_TOOL       = 'advisor';   // first tab; used when no name yet
  const DEFAULT_AFTER_LOAD = 'advisor';   // user typed a name, show their data
  const TOOLS              = ['advisor', 'clockin', 'buddy-finder', 'profit', 'wealth', 'mu', 'sp-advisor'];
  const USERNAME_DRIVEN    = new Set(['buddy-finder', 'advisor', 'clockin', 'profit', 'wealth', 'sp-advisor']);

  const MODULES = {
    mu:             () => MUTool,
    'buddy-finder': () => BuddyFinderTool,
    advisor:        () => AdvisorTool,
    clockin:        () => ClockInTool,
    profit:         () => DailyProfitTool,
    wealth:         () => WealthMonitorTool,
    'sp-advisor':   () => SkillPointAdvisorTool,
  };

  // One-line explainer shown in the info box for each tool. Replaces every
  // tool's own header (hidden in the shell) so the framing is consistent.
  const TOOL_INFO = {
    advisor:        { icon: '🏭', title: 'Migration Advisor', desc: `For each of your companies, find whether a different country or region would produce more — and by how much.` },
    clockin:        { icon: '⏱',  title: 'Clock-In Monitor',  desc: `See when each of your workers last clocked in, on a 48-hour timeline, plus a payroll projection.` },
    wealth:         { icon: '💰', title: 'Wealth Tracker',    desc: `Track any Irish player's wealth over time — total, or split into companies, items, money, equipment and weapons.` },
    'buddy-finder': { icon: '🤝', title: 'Buddy Finder',      desc: `Find a buddy for the Irish buddy system (you hire each other at minimum wage), or join the waiting list.` },
    profit:         { icon: '📈', title: 'Daily Profit',      desc: `Your projected daily profit — companies, salary, missions and case sales — plus which products pay best per production point.` },
    mu:             { icon: '🇮🇪', title: 'Irish Military Units', desc: `Military Units owned by Irish citizens, based in Ireland, with a majority-Irish roster.` },
    'sp-advisor':   { icon: '🧮', title: 'Skill Point Advisor', desc: `Optimize your skill point allocation across different attributes and abilities.` },
  };

  const $mount    = document.getElementById('stg-mount');
  const $toolInfo = document.getElementById('stg-tool-info');
  const $nav      = document.getElementById('stg-nav');
  const $navWrap  = document.getElementById('stg-nav-wrap');
  const $username = document.getElementById('stg-username');
  const $load     = document.getElementById('stg-load');
  const $toolsHead = document.getElementById('stg-tools-head');
  const $empty    = document.getElementById('stg-empty');
  const $emptySub = document.getElementById('stg-empty-sub');
  const $preview  = document.getElementById('stg-preview');
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
    // Every tool's own header is replaced by the shell's unified info box.
    t.push(v.el.querySelector('.tool-header'));
    if (tool === 'wealth' || tool === 'profit') {
      // Shell provides the username field, so also hide the tool's own
      // lookup bar (input + recent chips). The shared name drives it.
      t.push(v.el.querySelector('.stg-idbar'));
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

  /* ── Secondary input sync ───────────────────────────────
   *  The tools drive their run decision off their PRIMARY input and update
   *  it themselves on activate(), so the shell must NOT pre-set those (the
   *  tool would see no change and skip loading). But buddy-finder's
   *  waitlist input is a separate field it only fills when empty, so it
   *  keeps a stale name when the shell switches users. That field is safe
   *  to write directly (it isn't used for any run decision), so push the
   *  current name into it here. */
  function syncSecondaryInputs(name) {
    const wl = document.getElementById('bf-waitlist-username');
    if (wl) wl.value = name || '';
  }

  /* ── Nav overflow fade ──────────────────────────────────
   *  Show a right-edge fade while there are pills off-screen, hide it once
   *  scrolled to the end (or when nothing overflows). Pure affordance. */
  function updateNavFade() {
    if (!$navWrap) return;
    const atEnd = $nav.scrollLeft + $nav.clientWidth >= $nav.scrollWidth - 2;
    $navWrap.classList.toggle('at-end', atEnd);
  }

  /* ── URL sync ───────────────────────────────────────────
   *  Author the address bar so the view is shareable/deep-linkable as
   *  #home?u=<name>&tool=<active>. Uses the native replaceState (set up
   *  by installHashGuard) so it bypasses the guard's tool-hash transform.
   *  replaceState doesn't fire hashchange, so no re-activation loop. */
  function writeStagingHash() {
    const params = new URLSearchParams();
    if (state.username) params.set('u', state.username);
    if (state.active)   params.set('tool', state.active);
    const qs  = params.toString();
    const url = qs ? `#home?${qs}` : '#home';
    if (location.hash !== url) {
      (nativeReplace || history.replaceState).call(history, null, '', url + location.search);
    }
  }

  /* ── Hash guard ─────────────────────────────────────────
   *  Hosted tools rewrite the address bar when they run (e.g. advisor →
   *  #advisor?u=…). We intercept those and fold them back into a single
   *  #home?u=…&tool=… URL, so the shell owns the address bar.
   *
   *  The rewrite is also our success signal for the recent list: a tool
   *  only rewrites AFTER resolving the username, and the name it writes is
   *  the canonical (correct-case) one. So this is the right and only
   *  reliable place to commit a name to the recent list and to sync the
   *  canonical name into the secondary inputs. Failed searches never reach
   *  a rewrite, so they never get saved. */
  let nativeReplace = null;
  function installHashGuard() {
    if (nativeReplace) return;
    nativeReplace = history.replaceState.bind(history);
    history.replaceState = function (s, t, url) {
      if (typeof url === 'string') {
        const m = url.match(/^#(mu|buddy-finder|advisor|clockin|profit|wealth|sp-advisor)\b/);
        if (m) {
          const q = url.split('?')[1] || '';
          const u = new URLSearchParams(q).get('u');
          if (u) {
            state.username = u;            // adopt the canonical casing
            rememberUsername(u);
            syncSecondaryInputs(u);
          }
          const params = new URLSearchParams();
          if (u) params.set('u', u);
          params.set('tool', m[1]);
          url = `#home?${params.toString()}`;
        }
      }
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
   *  Stored most-recent-first, deduped case-insensitively. Committed only
   *  on a tool's successful resolution (via the hash guard), so failed
   *  searches never land here. Best-effort: a disabled/full localStorage
   *  degrades to "no chips". */
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
    $toolsHead.classList.remove('hidden');
    $toolInfo.classList.remove('hidden');
    $mount.classList.remove('hidden');
    $empty.classList.add('hidden');
    updateNavFade();
  }
  function gateTools() {
    $nav.classList.add('hidden');
    $toolsHead.classList.add('hidden');
    $toolInfo.classList.add('hidden');
    $mount.classList.add('hidden');
    $empty.classList.remove('hidden');
  }

  /* Full reset back to the landing state: clear the loaded username, hand
   *  the active tool's view back, and re-show the preview. Wired to the
   *  brand link so clicking the title is a clean "start over". */
  function resetHome() {
    if (state.active) restore(state.active);
    state.active = null;
    state.pendingTool = null;
    state.username = '';
    $username.value = '';
    syncSecondaryInputs('');
    $nav.querySelectorAll('.stg-tab').forEach(b => b.classList.remove('active'));
    gateTools();
    // No hash rewrite here: the brand's href="#home" fires the navigation,
    // and the router re-activates the shell. Because state.username is now
    // cleared, that re-activation lands on the gated landing. (A replaceState
    // here would suppress that hashchange and strand other views on-screen.)
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
    catch (e) { console.error(`[home] activate ${state.active} failed`, e); }
  }

  // Preview of every tool on the empty/landing state, so newcomers see
  // what's inside before typing a name. Clicking one pre-selects it.
  // Landing cards, grouped into sections (same style as the Community tab).
  const PREVIEW_CATS = [
    { title: '🏭 Production', tools: ['advisor', 'clockin'] },
    { title: '💰 Profits',    tools: ['buddy-finder', 'profit', 'wealth'] },
    { title: '⚔️ Combat',   tools: ['mu'] },
    { title: '🧮 Planning',  tools: ['sp-advisor'] },
  ];
  function renderPreview() {
    if (!$preview || $preview.dataset.done) return;
    const card = t => {
      const i = TOOL_INFO[t]; if (!i) return '';
      return `<button class="tool-card" data-prev="${t}">
        <div class="tool-card-icon">${i.icon}</div>
        <div class="tool-card-body">
          <h3>${escapeHtml(i.title)}</h3>
          <p>${escapeHtml(i.desc)}</p>
          <span class="tool-link">Open ${escapeHtml(i.title)} →</span>
        </div>
      </button>`;
    };
    $preview.innerHTML = PREVIEW_CATS.map(c =>
      `<h3 class="community-cat">${c.title}</h3><div class="tool-cards">${c.tools.map(card).join('')}</div>`
    ).join('');
    $preview.dataset.done = '1';
  }

  function renderToolInfo(tool) {
    const info = TOOL_INFO[tool];
    $toolInfo.innerHTML = info
      ? `<span class="stg-ti-icon">${info.icon}</span><div class="stg-ti-body"><h3>${info.title}</h3><p>${info.desc}</p></div>`
      : '';
  }

  function selectTool(tool, { run = true } = {}) {
    if (!TOOLS.includes(tool)) tool = DEFAULT_TOOL;
    if (state.active === tool) { if (run) driveActive(); writeStagingHash(); return; }
    if (state.active) restore(state.active);
    state.active = tool;
    host(tool);
    $nav.querySelectorAll('.stg-tab').forEach(b =>
      b.classList.toggle('active', b.dataset.stgTab === tool));
    $mount.dataset.active = tool;
    renderToolInfo(tool);
    if (run) driveActive();
    writeStagingHash();
  }

  function loadUsername() {
    const u = $username.value.trim();
    if (!u) { $username.focus(); return; }
    state.username = u;
    // Not saved to the recent list here — the name isn't verified yet.
    // Saving on Load is what let typos land in the list. The recent list
    // is committed only when a tool successfully resolves (hash guard).
    syncSecondaryInputs(u);          // immediate; canonical overwrites later
    revealTools();
    if (!state.active) selectTool(state.pendingTool || DEFAULT_AFTER_LOAD);
    else driveActive();              // re-run current tool with the new name
    state.pendingTool = null;
    writeStagingHash();
  }

  /* ── Wire-up ────────────────────────────────────────────── */
  $nav.addEventListener('click', e => {
    const btn = e.target.closest('.stg-tab');
    if (btn) selectTool(btn.dataset.stgTab);
  });
  $nav.addEventListener('scroll', updateNavFade, { passive: true });
  window.addEventListener('resize', updateNavFade);
  $load.addEventListener('click', loadUsername);
  $username.addEventListener('keydown', e => { if (e.key === 'Enter') loadUsername(); });
  $recent.addEventListener('click', e => {
    const del = e.target.closest('[data-stg-recent-del]');
    if (del) { forgetUsername(del.dataset.stgRecentDel); return; }
    const pick = e.target.closest('[data-stg-recent]');
    if (pick) { $username.value = pick.dataset.stgRecent; loadUsername(); }
  });
  // Landing preview: clicking a tool pre-selects it, then prompts for a name.
  $preview.addEventListener('click', e => {
    const card = e.target.closest('[data-prev]');
    if (card) { state.pendingTool = card.dataset.prev; $username.focus(); }
  });

  // Clicking the brand/title is a clean "start over": reset to the landing
  // and clear the loaded username. The href="#home" still handles the view
  // switch when we're coming from another tab; resetHome() clears the state
  // first, so the router's re-activation lands on the gated landing.
  const $brand = document.querySelector('.brand');
  if ($brand) $brand.addEventListener('click', () => resetHome());

  // Leaving home: turn off the shared cache (clears it), hand the borrowed
  // views back, and reset so the next entry re-warms cleanly.
  window.addEventListener('hashchange', () => {
    const view = location.hash.replace(/^#/, '').split('?')[0] || 'home';
    if (view !== 'home' && state.mounted) {
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
     * Router entry. Supports #home?tool=advisor&u=toie for deep links.
     * @param {URLSearchParams} [params]
     */
    activate(params) {
      state.mounted = true;
      installHashGuard();
      setTrpcCache(true);
      prefetch();
      renderRecent();
      renderPreview();

      const tool = (params && TOOLS.includes(params.get('tool'))) ? params.get('tool') : null;
      const u = (params && params.get('u')) || state.username || '';

      if (u) {
        // Deep-link / returning name: don't pre-save it. If it resolves,
        // the tool's hash rewrite commits it; if not, it stays out.
        $username.value = u;
        state.username = u;
        syncSecondaryInputs(u);
        revealTools();
        selectTool(tool || state.active || DEFAULT_AFTER_LOAD);
      } else {
        gateTools();
        state.pendingTool = tool;
      }
    },
  };
})();