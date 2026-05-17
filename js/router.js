/* ═══════════════════════════════════════════════════════════════════
 *  VIEW ROUTER
 *  Hash-based routing so views are deep-linkable.
 *    #home                landing page (default)
 *    #mu                  Irish Military Units
 *    #mu?filter=open      MU tool with the "Has slots" filter applied
 *    #advisor             Migration Advisor (empty)
 *    #advisor?u=toie      Migration Advisor auto-running for "toie"
 *
 *  Params live inside the hash (after a literal '?') so the whole route
 *  is portable as one fragment and survives static hosting that doesn't
 *  rewrite query strings.
 *
 *  Idempotency: activate(params) runs every time a view becomes active,
 *  not just on first mount. Tools handle being called repeatedly: MU
 *  doesn't re-fetch its data, the advisor only re-runs if the username
 *  changed. This is what makes hash edits like #advisor to #advisor?u=toie
 *  pick up the new param without a full reload.
 *
 *  Navigation: there are no tabs. Users land on Home and click into
 *  tools via the cards. The .back-link in the header sends them back,
 *  and clicking the brand title does the same.
 * ═══════════════════════════════════════════════════════════════════ */
(() => {
  const VALID = new Set(['home', 'mu', 'advisor', 'buddy', 'battle-orders']);
  const DEFAULT_VIEW = 'home';
  const views = document.querySelectorAll('.view');
  const $backLink = document.querySelector('.back-link');

  const tools = {
    home: null,
    mu: MUTool,
    advisor: AdvisorTool,
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
    $backLink.hidden = (name === DEFAULT_VIEW);

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