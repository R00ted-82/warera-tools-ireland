/* ═══════════════════════════════════════════════════════════════════
 *  VIEW ROUTER
 *  Hash-based routing so views are deep-linkable.
 *    #home                Irish tools landing (default)
 *    #community           Community (external) tools landing
 *    #mu                  Irish Military Units
 *    #mu?filter=open      MU tool with the "Has slots" filter applied
 *    #advisor             Migration Advisor (empty)
 *    #advisor?u=toie      Migration Advisor auto-running for "toie"
 *    #clockin             Employee Clock-In Monitor (empty)
 *    #clockin?u=toie      Clock-In Monitor auto-running for "toie"
 *
 *  Params live inside the hash (after a literal '?') so the whole route
 *  is portable as one fragment and survives static hosting that doesn't
 *  rewrite query strings.
 *
 *  Tabs: the two landing views (home, community) show the tab bar and
 *  hide the back-link. Every tool view hides the tabs and shows the
 *  back-link, which returns to #home. All internal tools belong to the
 *  Irish tab, so "back to home" is always the right destination.
 *
 *  Idempotency: activate(params) runs every time a view becomes active,
 *  not just on first mount. Tools handle being called repeatedly: MU
 *  doesn't re-fetch its data, the advisor only re-runs if the username
 *  changed. This is what makes hash edits like #advisor to #advisor?u=toie
 *  pick up the new param without a full reload.
 *
 *  Navigation: two tabs sit in the header. Within the Irish tab, users
 *  click into tools via the cards; the .back-link and the brand title
 *  both return to #home. The Community tab is a directory of external
 *  links that open in a new tab — it registers no tool.
 * ═══════════════════════════════════════════════════════════════════ */
(() => {
  const VALID = new Set([
    'home', 'community', 'staging', 'mu', 'buddy-finder',
    'advisor', 'clockin', 'buddy', 'battle-orders',
  ]);
  const LANDING = new Set(['home', 'community', 'staging']);
  const DEFAULT_VIEW = 'home';
  const views = document.querySelectorAll('.view');
  const $backLink = document.querySelector('.back-link');
  const $tabs = document.getElementById('tabs');
  

  const tools = {
    home: null,
    community: null,
    staging: StagingTool,
    mu: MUTool,
    'buddy-finder': BuddyFinderTool,
    advisor: AdvisorTool,
    clockin: ClockInTool,
    buddy: BuddySystemGate,
    'battle-orders': BattleOrdersGate,
  };

  function parseRoute() {
    const raw = location.hash.replace(/^#/, '');
    const qIdx = raw.indexOf('?');
    const view = (qIdx >= 0 ? raw.slice(0, qIdx) : raw) || DEFAULT_VIEW;
    const queryStr = qIdx >= 0 ? raw.slice(qIdx + 1) : '';
    return { view, params: new URLSearchParams(queryStr) };
  }

  function writeHash(name, params) {
    const queryStr = params ? params.toString() : '';
    const newHash = queryStr ? `#${name}?${queryStr}` : `#${name}`;
    if (location.hash !== newHash) {
      history.replaceState(null, '', newHash + location.search);
    }
  }

  function setView(name, { updateHash = true, params = new URLSearchParams() } = {}) {
    if (!VALID.has(name)) name = DEFAULT_VIEW;
    views.forEach(v => v.classList.toggle('active', v.dataset.view === name));

    // Tab bar on the two landing pages, back-link inside tools.
    const isLanding = LANDING.has(name);
    $backLink.hidden = isLanding;
    if ($tabs) {
      $tabs.hidden = !isLanding;
      $tabs.querySelectorAll('.tab').forEach(t =>
        t.classList.toggle('active', t.dataset.tab === name));
    }

    if (updateHash) writeHash(name, params);

    const tool = tools[name];
    if (tool && typeof tool.activate === 'function') {
      try { tool.activate(params); }
      catch (e) { console.error(`Failed to activate ${name}:`, e); }
    }
  }

  window.addEventListener('hashchange', () => {
    const r = parseRoute();
    setView(r.view, { updateHash: false, params: r.params });
  });

  const initial = parseRoute();
  setView(initial.view, { updateHash: false, params: initial.params });
})();