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
    'home', 'community', 'gov', 'mu', 'buddy-finder',
    'advisor', 'clockin', 'profit', 'profit-dev', 'wealth', 'buddy', 'battle-orders',  'beer',
    'dashboard', 'roster', 'tax', 'tax-dev', 'tax-partner', 'factory-tax', 'tax-deals',
  ]);
  const LANDING = new Set(['dashboard', 'home', 'community', 'gov', 'beer']);
  const DEFAULT_VIEW = 'dashboard';
  const views = document.querySelectorAll('.view');
  const $backLink = document.querySelector('.back-link');
  const $tabs = document.getElementById('tabs');
  const $footerAuthor = document.getElementById('footer-author');

  // Footer credit per view. R00ted's tools credit R00ted; the shared landing
  // pages credit both; everything else is toie's (the default).
  const AUTHOR = {
    roster: 'R00ted', 'sp-advisor': 'R00ted', tax: 'R00ted', 'tax-dev': 'R00ted', 'tax-partner': 'R00ted', 'factory-tax': 'R00ted', 'tax-deals': 'R00ted',
    home: 'toie & R00ted', gov: 'toie & R00ted', community: 'toie & R00ted',
  };
  // Exposed so the home shell can re-credit the footer as its sub-tool changes
  // (e.g. Skill Point Advisor runs inside #home but is R00ted's).
  function setFooterAuthor(key) { if ($footerAuthor) $footerAuthor.textContent = AUTHOR[key] || 'toie'; }
  window.setFooterAuthor = setFooterAuthor;


  const tools = {
    home: ToolkitShell,
    community: null,
    gov: null,
    mu: MUTool,
    'buddy-finder': BuddyFinderTool,
    advisor: AdvisorTool,
    clockin: ClockInTool,
    profit: DailyProfitTool,
    'profit-dev': DailyProfitDevTool,
    wealth: WealthMonitorTool,
    buddy: BuddySystemGate,
    'battle-orders': BattleOrdersGate,
    beer: BeerGate,
    dashboard: DashboardTool,
    roster: RosterTool,
    tax: IrishTaxGate,
    'tax-dev': IrishTaxDevTool,
    'tax-partner': IrishTaxPartnerTool,
    'factory-tax': IrishFactoryTaxTool,
    'tax-deals': TaxDealDashboardTool,
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

    // Footer attribution follows the active view.
    setFooterAuthor(name);

    // Tab bar on the two landing pages, back-link inside tools.
    const isLanding = LANDING.has(name);
    $backLink.hidden = isLanding;
    $backLink.setAttribute('href',
      (name === 'buddy' || name === 'battle-orders') ? '#gov' : '#dashboard');
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