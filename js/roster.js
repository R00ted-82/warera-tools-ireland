/* ═══════════════════════════════════════════════════════════════════
 *  ROSTER (#roster)
 *
 *  Country citizens list with build, pill (buff/debuff) status, health,
 *  hunger, MU and last-online time. Sortable columns + filters.
 *  Useful for war planning. Unlisted by design.
 *
 *  Loads automatically on open. Country is parametrised (default Ireland)
 *  so adding another country later is a CONFIG change, not a rewrite —
 *  see the COUNTRIES map below.
 *
 *  Data sources (all via the gateway your trpc() helper points at):
 *    - user.getUsersByCountry (paginated) → list of citizens (_id, username, mu)
 *    - user.getUserById       (per citizen) → FULL profile: skills, dates, buffs
 *    - mu.getById             (per unique MU) → MU names
 *
 *  Why getUserById and not getUserLite:
 *    getUserById is a superset of Lite and is the ONLY place the pill
 *    (buff/debuff) data lives. Confirmed from the official docs
 *    (api2.warera.io/docs → user.getUserById, input { userId }).
 *
 *  Field shapes below are all confirmed against REAL responses, not
 *  guessed. Citations are in the comments next to each reader.
 * ═══════════════════════════════════════════════════════════════════ */
const RosterTool = (() => {
  const PAGE_LIMIT = 100;

  /* ── Country config ───────────────────────────────────────────────
   * THE ONE PLACE to change for the multi-country rollout. To add a
   * country: add an entry here with its countryId. The roster reads the
   * active country from the route (#roster?country=<key>), default below.
   * IRELAND_COUNTRY_ID is the existing global the old code used. */
  const COUNTRIES = {
    ireland: { id: IRELAND_COUNTRY_ID, label: 'Ireland' },
    // example for later:
    // britain: { id: 'PUT_BRITAIN_COUNTRY_ID_HERE', label: 'Britain' },
  };
  const DEFAULT_COUNTRY = 'ireland';

  // Skill buckets — same definitions as the war detector bot, so the
  // build labels on the roster agree with what the bot uses internally.
  const COMBAT_SKILLS = ['attack','precision','dodge','armor','lootChance',
                          'criticalChance','criticalDamages','health'];
  const ECO_SKILLS    = ['companies','entrepreneurship','production','management'];

  const COMBAT_THRESHOLD = 70;   // combat % of (combat+economy) skill levels
  const ECO_THRESHOLD    = 30;
  // Sort ordering for the Build column (higher = more combat-leaning).
  const BUILD_ORDER = { combat: 3, mixed: 2, economy: 1, unknown: 0 };

  const ONLINE_FRESH = 24;   // < 24h ago → fresh (green)
  const ONLINE_STALE = 72;   // < 72h ago → stale (amber), else dead (red)

  const BAR_LOW  = 50;       // health/hunger % bands for colour
  const BAR_CRIT = 25;

  /* ── DOM ──────────────────────────────────────────────────────────
   * Only #roster-content is required now. #roster-status is used if
   * present. The old #roster-username / #roster-load are no longer used
   * (the tool loads on open) — you can delete them from the HTML. */
  const $status  = document.getElementById('roster-status');
  const $content = document.getElementById('roster-content');

  /* ── State ────────────────────────────────────────────────────────── */
  let countryKey = DEFAULT_COUNTRY;
  let allRows    = [];        // built once per load, then filtered/sorted in place
  let muNames    = {};
  let sortKey    = 'level';
  let sortDir    = 'desc';
  let filters    = freshFilters();
  let running    = false;

  function freshFilters() {
    return { mu: 'all', build: 'all', pill: 'all',
             healthBelow: 'all', hungerBelow: 'all', online: 'all' };
  }

  const rs_trpc = (ep, input) => trpc(ep, input, { retry: true });

  /* ── Status helper ────────────────────────────────────────────────── */
  function setStatus(text, isError = false) {
    if (!$status) return;
    if (!text) { $status.classList.add('hidden'); return; }
    $status.textContent = text;
    $status.classList.toggle('error', isError);
    $status.classList.remove('hidden');
  }

  /* ═══════════════════════════════════════════════════════════════════
   *  PURE LOGIC  (no DOM, no globals — unit-tested against real captures)
   * ═══════════════════════════════════════════════════════════════════ */

  // Skill level = skills.<name>.level (confirmed: getUserLite/getUserById
  // example responses). Read ONLY .level — the old code read .total first,
  // which on skills.health is the health *bar* total (e.g. 100), wrongly
  // inflating the combat score so everyone classified as combat.
  function skillLevel(user, skill) {
    const lvl = user?.skills?.[skill]?.level;
    return (typeof lvl === 'number' && isFinite(lvl)) ? lvl : 0;
  }

  function classifyBuild(user) {
    const combat = COMBAT_SKILLS.reduce((s, k) => s + skillLevel(user, k), 0);
    const eco    = ECO_SKILLS.reduce((s, k) => s + skillLevel(user, k), 0);
    if (combat + eco === 0) return { kind: 'unknown', ratio: null };
    const ratio = (combat / (combat + eco)) * 100;
    if (ratio >= COMBAT_THRESHOLD) return { kind: 'combat',  ratio };
    if (ratio <= ECO_THRESHOLD)    return { kind: 'economy', ratio };
    return { kind: 'mixed', ratio };
  }

  // Health / hunger live UNDER skills as { currentBarValue, total }
  // (confirmed: getUserLite/getUserById responses). Returns
  // { pct, cur, label } or null if absent. `cur` (raw points) is kept
  // separate from `pct` because each player's `total` (cap) differs with
  // their hunger/health skill level — sorting by % would rank a small-cap
  // player who's "full" (e.g. 4/4) above a bigger-cap player who isn't
  // (e.g. 6/7), which is backwards for war-planning purposes. Sort by
  // raw points (`cur`); use `pct` only for the bar's visual fill width.
  function statBar(user, key) {
    const s = user?.skills?.[key];
    if (!s || typeof s !== 'object') return null;
    const cur = s.currentBarValue, max = s.total;
    if (typeof cur !== 'number' || typeof max !== 'number' || max <= 0) return null;
    const pct = Math.max(0, Math.min(100, (cur / max) * 100));
    return { pct, cur, label: `${Math.round(cur)} / ${Math.round(max)}` };
  }

  // Buffs and debuffs are SEPARATE named fields inside the `buffs` object:
  //   buff   → buffs.buffCodes  (array) + buffs.buffEndAt   (ISO)
  //            confirmed from KyleTheTank's getUserById response
  //   debuff → buffs.debuffCodes(array) + buffs.debuffEndAt (ISO)
  //            confirmed from RevanEire's  getUserById response
  // NB: the same code (e.g. "cocain") can be a buff OR a debuff depending
  // which field it's in — so good/bad comes from the FIELD, never the code.
  // We return the raw timestamp; "is it active right now" is decided at
  // render time against the current clock (keeps this function deterministic).
  function parseEffects(user) {
    const b = user?.buffs;
    const grab = (codesKey, endKey) => {
      if (!b) return null;
      const codes = b[codesKey];
      const endStr = b[endKey];
      if (!Array.isArray(codes) || codes.length === 0 || !endStr) return null;
      const until = new Date(endStr).getTime();
      if (!isFinite(until)) return null;
      return { codes, until };
    };
    return {
      buff:   grab('buffCodes',   'buffEndAt'),
      debuff: grab('debuffCodes', 'debuffEndAt'),
    };
  }

  function effectActive(eff, now) {
    return !!eff && eff.until > now;
  }

  function onlineKind(hoursAgo) {
    if (hoursAgo == null) return 'dead';
    if (hoursAgo < ONLINE_FRESH) return 'fresh';
    if (hoursAgo < ONLINE_STALE) return 'stale';
    return 'dead';
  }

  // Turn a raw (list + full profile merged) citizen into a display row.
  // Computes everything once so filter/sort never recompute classify/parse.
  function buildRow(c) {
    const lastIso = c?.dates?.lastConnectionAt;          // confirmed: dates.lastConnectionAt
    const lastMs  = lastIso ? new Date(lastIso).getTime() : null;
    return {
      raw:        c,
      _id:        c._id,
      username:   c.username || c._id,
      mu:         c.mu || null,                          // from getUsersByCountry
      level:      c?.leveling?.level ?? null,            // confirmed: leveling.level
      build:      classifyBuild(c),
      health:     statBar(c, 'health'),
      hunger:     statBar(c, 'hunger'),
      effects:    parseEffects(c),
      lastConnMs: (lastMs != null && isFinite(lastMs)) ? lastMs : null,
    };
  }

  // Pill column has its own comparator (not a simple numeric key) because
  // buff and debuff must stay as two separate, non-interleaved groups:
  //
  //   asc  -> all BUFFED  (high time left -> low),
  //           then all DEBUFFED (low time left -> high)
  //   desc -> all DEBUFFED (high time left -> low),
  //           then all BUFFED  (low time left -> high)
  //   un-pilled players always last, in both directions.
  //
  // A single numeric key can't express "group A counts down, then group B
  // counts back up", so this compares rows directly instead of going
  // through the generic compareRows() number-flip path.
  function pillGroup(effects, now) {
    if (effectActive(effects.buff, now))   return 'buff';
    if (effectActive(effects.debuff, now)) return 'debuff';
    return 'none';
  }
  function pillRemainingMs(effects, now) {
    if (effectActive(effects.buff, now))   return effects.buff.until - now;
    if (effectActive(effects.debuff, now)) return effects.debuff.until - now;
    return null;
  }
  function comparePill(a, b, dir, now) {
    const ga = pillGroup(a.effects, now), gb = pillGroup(b.effects, now);
    if (ga === 'none' && gb === 'none') return 0;
    if (ga === 'none') return 1;     // un-pilled always sinks to the bottom
    if (gb === 'none') return -1;

    const leadGroup = dir === 'asc' ? 'buff' : 'debuff'; // which group goes first
    if (ga !== gb) return ga === leadGroup ? -1 : 1;

    // Same group: leading group counts DOWN (high->low), trailing group
    // counts back UP (low->high).
    const ra = pillRemainingMs(a.effects, now), rb = pillRemainingMs(b.effects, now);
    return ga === leadGroup ? (rb - ra) : (ra - rb);
  }

  const SORTERS = {
    name:   (r) => (r.username || '').toLowerCase(),
    level:  (r) => r.level ?? -1,
    build:  (r) => BUILD_ORDER[r.build.kind] ?? -1,
    health: (r) => r.health ? r.health.cur : -1,
    hunger: (r) => r.hunger ? r.hunger.cur : -1,
    online: (r) => r.lastConnMs ?? -Infinity,
    mu:     (r, ctx) => (ctx.muNames[r.mu] || '').toLowerCase(),
  };

  function compareRows(a, b, key, dir, ctx) {
    if (key === 'pill') return comparePill(a, b, dir, ctx.now);   // bespoke: see comparePill
    const va = SORTERS[key](a, ctx), vb = SORTERS[key](b, ctx);
    let c;
    if (typeof va === 'string' || typeof vb === 'string') {
      c = String(va).localeCompare(String(vb));
    } else {
      c = va < vb ? -1 : va > vb ? 1 : 0;
    }
    return dir === 'asc' ? c : -c;
  }

  // All filters AND together. now is needed for pill/online (time-based).
  function matchesFilters(row, f, now) {
    if (f.mu !== 'all' && row.mu !== f.mu) return false;

    if (f.build !== 'all' && row.build.kind !== f.build) return false;

    if (f.pill !== 'all') {
      const hasBuff   = effectActive(row.effects.buff, now);
      const hasDebuff = effectActive(row.effects.debuff, now);
      if (f.pill === 'buffed'   && !hasBuff)               return false;
      if (f.pill === 'debuffed' && !hasDebuff)             return false;
      if (f.pill === 'clean'    && (hasBuff || hasDebuff)) return false;
    }

    if (f.healthBelow !== 'all') {
      const thr = Number(f.healthBelow);
      if (!row.health || row.health.pct >= thr) return false;
    }
    if (f.hungerBelow !== 'all') {
      const thr = Number(f.hungerBelow);
      if (!row.hunger || row.hunger.pct >= thr) return false;
    }

    if (f.online !== 'all') {
      const hoursAgo = row.lastConnMs == null ? null : (now - row.lastConnMs) / 3600000;
      if (onlineKind(hoursAgo) !== f.online) return false;
    }
    return true;
  }

  /* ── Formatting helpers ───────────────────────────────────────────── */
  function fmtAgoHours(hoursAgo) {
    if (hoursAgo == null || !isFinite(hoursAgo)) return 'never';
    if (hoursAgo < 1) return 'just now';
    if (hoursAgo < 24) return `${Math.floor(hoursAgo)}h ago`;
    return `${Math.floor(hoursAgo / 24)}d ago`;
  }

  function fmtRemaining(ms) {
    if (ms <= 0) return '0m';
    const mins = Math.floor(ms / 60000);
    if (mins < 60) return `${mins}m`;
    const h = Math.floor(mins / 60), m = mins % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
  }

  /* ═══════════════════════════════════════════════════════════════════
   *  CONCURRENCY + DATA FETCHERS
   * ═══════════════════════════════════════════════════════════════════ */
  async function mapConcurrent(items, worker, concurrency = 20) {
    const out = new Array(items.length); let i = 0;
    async function pump() {
      while (i < items.length) {
        const idx = i++;
        try { out[idx] = await worker(items[idx]); }
        catch { out[idx] = null; }
      }
    }
    await Promise.all(Array(Math.min(concurrency, items.length || 1)).fill(0).map(pump));
    return out;
  }

  async function fetchAllCitizens(countryId) {
    const items = [];
    let cursor = null, safety = 0;
    while (safety++ < 200) {
      const input = { countryId, limit: PAGE_LIMIT };
      if (cursor) input.cursor = cursor;
      const page = await rs_trpc('user.getUsersByCountry', input);
      const arr = page?.items ?? page?.data ?? (Array.isArray(page) ? page : []);
      items.push(...arr);
      const next = page?.nextCursor ?? page?.cursor ?? null;
      if (!next || arr.length === 0) break;
      cursor = next;
    }
    return items;
  }

  // Hydrate each citizen with the FULL profile (getUserById). The gateway
  // batches these (400ms window) and caches them (~5 min), so repeated
  // loads in a short window mostly don't hit the game API at all.
  async function fetchFullProfiles(citizens) {
    return mapConcurrent(citizens, async (c) => {
      try {
        const full = await rs_trpc('user.getUserById', { userId: c._id });
        return full ? { ...c, ...full } : c;
      } catch { return c; }
    });
  }

  async function fetchMuNames(citizens) {
    const muIds = [...new Set(citizens.map(c => c.mu).filter(Boolean))];
    const names = {};
    await mapConcurrent(muIds, async (id) => {
      try {
        const mu = await rs_trpc('mu.getById', { muId: id });
        if (mu?.name) names[id] = mu.name;
      } catch {}
    }, 10);
    return names;
  }

  /* ═══════════════════════════════════════════════════════════════════
   *  ICONS
   *  Small inline SVGs (no icon font / CDN dependency — none is loaded
   *  on the site, so these are hand-sized to match: 12-13px, 1.6 stroke,
   *  currentColor so they pick up the surrounding chip's text colour
   *  (which is already a CSS variable, so dark/light both just work).
   * ═══════════════════════════════════════════════════════════════════ */
  const ICONS = {
    arrowUp:  '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="6 11 12 5 18 11"/></svg>',
    arrowDown:'<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="18 13 12 19 6 13"/></svg>',
    sword:    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="19" x2="19" y2="5"/><polyline points="13 5 19 5 19 11"/><line x1="19" y1="19" x2="5" y2="5"/><polyline points="11 5 5 5 5 11"/></svg>',
    coin:     '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><path d="M9.5 9.5c0-1.2 1-2 2.5-2s2.5.8 2.5 2-1 1.6-2.5 2.5-2.5 1.3-2.5 2.5 1 2 2.5 2 2.5-.8 2.5-2"/></svg>',
    overlap:  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9.5" cy="12" r="6.5"/><circle cx="14.5" cy="12" r="6.5"/></svg>',
  };

  /* ═══════════════════════════════════════════════════════════════════
   *  RENDERING
   * ═══════════════════════════════════════════════════════════════════ */
  function renderBar(stat) {
    if (!stat) return '<span class="rs-bar-val">–</span>';
    let cls = '';
    if (stat.pct <= BAR_CRIT) cls = 'crit';
    else if (stat.pct <= BAR_LOW) cls = 'low';
    return `<span class="rs-bar ${cls}"><i style="width:${stat.pct.toFixed(0)}%"></i></span>
            <span class="rs-bar-val">${escapeHtml(stat.label)}</span>`;
  }

  function renderBuild(build) {
    const labels = { combat: 'Combat', economy: 'Economy', mixed: 'Mixed', unknown: '–' };
    const icon   = { combat: ICONS.sword, economy: ICONS.coin, mixed: ICONS.overlap, unknown: '' };
    const tooltip = build.ratio != null
      ? `${build.ratio.toFixed(0)}% combat skills`
      : 'Too few skill points to classify';
    return `<span class="rs-build ${build.kind}" title="${tooltip}">${icon[build.kind]}${labels[build.kind]}</span>`;
  }

  // Pill cell shows any ACTIVE buff and/or debuff with time left. Labelled
  // generically ("Pill" / "Debuff") rather than the raw code (e.g. "cocain")
  // per request — the underlying code is still in the title tooltip in case
  // it's ever useful, just not in the visible chip text.
  // A player can never hold both at once (confirmed), but the buff/debuff
  // branches stay independent rather than else-if, since that's a true
  // fact about the GAME, not something to hardcode as a code invariant.
  function renderPill(effects, now) {
    const out = [];
    if (effectActive(effects.buff, now)) {
      const codes = effects.buff.codes.map(escapeHtml).join(', ');
      out.push(`<span class="rs-eff rs-buff" title="${codes}">${ICONS.arrowUp}Pill · ${fmtRemaining(effects.buff.until - now)}</span>`);
    }
    if (effectActive(effects.debuff, now)) {
      const codes = effects.debuff.codes.map(escapeHtml).join(', ');
      out.push(`<span class="rs-eff rs-debuff" title="${codes}">${ICONS.arrowDown}Debuff · ${fmtRemaining(effects.debuff.until - now)}</span>`);
    }
    if (!out.length) return `<span class="rs-eff rs-none">–</span>`;
    return out.join(' ');
  }

  function renderMu(row) {
    if (!row.mu) return `<span class="rs-mu rs-none">none</span>`;
    const name = muNames[row.mu] || 'unit';
    return `<span class="rs-mu"><a href="${GAME_BASE}/mu/${escapeHtml(row.mu)}" target="_blank" rel="noopener">${escapeHtml(name)}</a></span>`;
  }

  function renderOnline(row) {
    if (row.lastConnMs == null) return `<span class="rs-online dead">never</span>`;
    const hoursAgo = (Date.now() - row.lastConnMs) / 3600000;
    return `<span class="rs-online ${onlineKind(hoursAgo)}">${escapeHtml(fmtAgoHours(hoursAgo))}</span>`;
  }

  // Column definitions drive both the header (with sort arrows) and which
  // SORTERS key each click uses.
  const COLUMNS = [
    { key: 'name',   label: 'Player' },
    { key: 'level',  label: 'Lvl' },
    { key: 'build',  label: 'Build' },
    { key: 'pill',   label: 'Pill' },
    { key: 'health', label: 'Health' },
    { key: 'hunger', label: 'Hunger' },
    { key: 'mu',     label: 'MU' },
    { key: 'online', label: 'Last online' },
  ];

  function renderHeader() {
    return COLUMNS.map(col => {
      const active = col.key === sortKey;
      const arrow = active ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';
      const ariaSort = active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none';
      return `<th class="rs-th${active ? ' active' : ''}" data-sort="${col.key}"
                  role="button" tabindex="0" aria-sort="${ariaSort}">${escapeHtml(col.label)}${arrow}</th>`;
    }).join('');
  }

  function renderSummary(shownRows, now) {
    let combat = 0, economy = 0, mixed = 0, unknown = 0, buffed = 0, debuffed = 0;
    for (const r of shownRows) {
      if (r.build.kind === 'combat') combat++;
      else if (r.build.kind === 'economy') economy++;
      else if (r.build.kind === 'mixed') mixed++;
      else unknown++;
      if (effectActive(r.effects.buff, now)) buffed++;
      if (effectActive(r.effects.debuff, now)) debuffed++;
    }
    const filtered = shownRows.length !== allRows.length;
    return `
      <div class="rs-summary">
        <span><strong>${shownRows.length}</strong>${filtered ? ` of ${allRows.length}` : ''} shown</span>
        <span><strong>${combat}</strong> combat</span>
        <span><strong>${economy}</strong> economy</span>
        <span><strong>${mixed}</strong> mixed</span>
        ${unknown ? `<span><strong>${unknown}</strong> too new</span>` : ''}
        <span><strong>${buffed}</strong> buffed</span>
        <span><strong>${debuffed}</strong> debuffed</span>
      </div>`;
  }

  function renderRows(rows, now) {
    if (!rows.length) {
      return `<tr><td colspan="${COLUMNS.length}" class="rs-empty">No players match these filters.</td></tr>`;
    }
    return rows.map(r => `
      <tr>
        <td class="rs-name"><a href="${GAME_BASE}/user/${escapeHtml(r._id)}" target="_blank" rel="noopener">${escapeHtml(r.username)}</a></td>
        <td class="rs-lvl">${r.level ?? '–'}</td>
        <td>${renderBuild(r.build)}</td>
        <td>${renderPill(r.effects, now)}</td>
        <td>${renderBar(r.health)}</td>
        <td>${renderBar(r.hunger)}</td>
        <td>${renderMu(r)}</td>
        <td>${renderOnline(r)}</td>
      </tr>`).join('');
  }

  // Build the filter controls (rendered ONCE per load; values reflect state).
  function renderControls() {
    const muOptions = Object.keys(muNames)
      .map(id => ({ id, name: muNames[id] }))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(o => `<option value="${escapeHtml(o.id)}"${filters.mu === o.id ? ' selected' : ''}>${escapeHtml(o.name)}</option>`)
      .join('');

    const sel = (cur, val) => cur === val ? ' selected' : '';

    return `
      <div class="rs-controls">
        <label class="rs-filter">MU
          <select data-filter="mu">
            <option value="all"${sel(filters.mu,'all')}>All</option>
            ${muOptions}
          </select>
        </label>
        <label class="rs-filter">Build
          <select data-filter="build">
            <option value="all"${sel(filters.build,'all')}>All</option>
            <option value="combat"${sel(filters.build,'combat')}>Combat</option>
            <option value="economy"${sel(filters.build,'economy')}>Economy</option>
            <option value="mixed"${sel(filters.build,'mixed')}>Mixed</option>
          </select>
        </label>
        <label class="rs-filter">Pill
          <select data-filter="pill">
            <option value="all"${sel(filters.pill,'all')}>All</option>
            <option value="buffed"${sel(filters.pill,'buffed')}>Buffed</option>
            <option value="debuffed"${sel(filters.pill,'debuffed')}>Debuffed</option>
            <option value="clean"${sel(filters.pill,'clean')}>No pill</option>
          </select>
        </label>
        <label class="rs-filter">Health
          <select data-filter="healthBelow">
            <option value="all"${sel(filters.healthBelow,'all')}>Any</option>
            <option value="50"${sel(filters.healthBelow,'50')}>Below 50%</option>
            <option value="25"${sel(filters.healthBelow,'25')}>Below 25%</option>
          </select>
        </label>
        <label class="rs-filter">Hunger
          <select data-filter="hungerBelow">
            <option value="all"${sel(filters.hungerBelow,'all')}>Any</option>
            <option value="50"${sel(filters.hungerBelow,'50')}>Below 50%</option>
            <option value="25"${sel(filters.hungerBelow,'25')}>Below 25%</option>
          </select>
        </label>
        <label class="rs-filter">Online
          <select data-filter="online">
            <option value="all"${sel(filters.online,'all')}>Any</option>
            <option value="fresh"${sel(filters.online,'fresh')}>Active &lt;24h</option>
            <option value="stale"${sel(filters.online,'stale')}>24–72h</option>
            <option value="dead"${sel(filters.online,'dead')}>Inactive &gt;72h</option>
          </select>
        </label>
        <button type="button" class="rs-clear" data-clear>Clear filters</button>
      </div>
      <div class="rs-summary-host"></div>
      <div class="rs-table-host"></div>`;
  }

  // Re-render summary + table for the current filters/sort. Controls are
  // left untouched so dropdowns keep focus/value.
  function applyView() {
    const now = Date.now();
    const ctx = { now, muNames };
    const shown = allRows.filter(r => matchesFilters(r, filters, now));
    shown.sort((a, b) => compareRows(a, b, sortKey, sortDir, ctx));

    const summaryHost = $content.querySelector('.rs-summary-host');
    const tableHost   = $content.querySelector('.rs-table-host');
    if (summaryHost) summaryHost.innerHTML = renderSummary(shown, now);
    if (tableHost) {
      tableHost.innerHTML = `
        <div class="rs-table-wrap">
          <table class="rs-table">
            <thead><tr>${renderHeader()}</tr></thead>
            <tbody>${renderRows(shown, now)}</tbody>
          </table>
        </div>`;
    }
  }

  /* ── Event wiring (delegated; bound once per load) ────────────────── */
  function wireControls() {
    // Filter dropdowns.
    $content.querySelectorAll('[data-filter]').forEach(el => {
      el.addEventListener('change', () => {
        filters[el.dataset.filter] = el.value;
        applyView();
      });
    });
    // Clear button.
    const clear = $content.querySelector('[data-clear]');
    if (clear) clear.addEventListener('click', () => {
      filters = freshFilters();
      $content.querySelectorAll('[data-filter]').forEach(el => { el.value = 'all'; });
      applyView();
    });
    // Sort headers (delegated on the table host, since the table re-renders).
    const tableHost = $content.querySelector('.rs-table-host');
    if (tableHost) {
      const onSort = (key) => {
        if (!key) return;
        if (key === sortKey) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
        else { sortKey = key; sortDir = (key === 'name' || key === 'mu') ? 'asc' : 'desc'; }
        applyView();
      };
      tableHost.addEventListener('click', (e) => {
        const th = e.target.closest('[data-sort]');
        if (th) onSort(th.dataset.sort);
      });
      tableHost.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const th = e.target.closest('[data-sort]');
        if (th) { e.preventDefault(); onSort(th.dataset.sort); }
      });
    }
  }

  /* ═══════════════════════════════════════════════════════════════════
   *  ORCHESTRATION
   * ═══════════════════════════════════════════════════════════════════ */
  async function run() {
    if (running) return;
    const country = COUNTRIES[countryKey] || COUNTRIES[DEFAULT_COUNTRY];

    running = true;
    setStatus('');
    $content.innerHTML = `<div class="rs-loading"><span class="rs-spinner"></span>Loading ${escapeHtml(country.label)} citizens…</div>`;

    try {
      const citizens = await fetchAllCitizens(country.id);
      if (!citizens.length) {
        $content.innerHTML = `<div class="rs-empty">No citizens returned. The data service may be down — try again in a minute.</div>`;
        return;
      }

      $content.innerHTML = `<div class="rs-loading"><span class="rs-spinner"></span>Loading ${citizens.length} player profiles…</div>`;
      const hydrated = await fetchFullProfiles(citizens);

      muNames = await fetchMuNames(hydrated);
      allRows = hydrated.map(buildRow);

      // Reset view state for the fresh dataset.
      filters = freshFilters();
      sortKey = 'level'; sortDir = 'desc';

      $content.innerHTML = renderControls();
      wireControls();
      applyView();
    } catch (e) {
      $content.innerHTML = '';
      const friendly = (typeof isTransientError === 'function' && isTransientError(e))
        ? `The data server is having a moment (${e.message}). Wait a few seconds and try again.`
        : e.message;
      setStatus(friendly, true);
    } finally {
      running = false;
    }
  }

  /* ── Public API ───────────────────────────────────────────────────── */
  return {
    // Loads on open. Reads #roster?country=<key>; defaults to Ireland.
    activate(params) {
      const get = (k) => (params && params.get && params.get(k))
        || new URLSearchParams(location.search).get(k);
      const c = (get('country') || DEFAULT_COUNTRY).toLowerCase();
      countryKey = COUNTRIES[c] ? c : DEFAULT_COUNTRY;
      try { history.replaceState(null, '', `#roster?country=${encodeURIComponent(countryKey)}`); } catch {}
      run();
    },
  };
})();