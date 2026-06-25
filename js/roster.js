/* ═══════════════════════════════════════════════════════════════════
 *  ROSTER (#roster)
 *
 *  Unlisted Irish citizens list with build, pill status, health,
 *  hunger, MU and last-online time. Useful for war planning.
 *
 *  Phase 1: read-only list, no filters yet. Citizenship-gated.
 *
 *  Data sources:
 *    - user.getUsersByCountry (paginated) → list of Irish citizens
 *    - user.getUserLite (per citizen)     → skills, status, dates
 *    - mu.getById (per unique MU)         → MU names
 *
 *  Build classification mirrors the war detector bot:
 *    combat skills:  attack, precision, dodge, armor, lootChance,
 *                    criticalChance, criticalDamages, health
 *    economy skills: companies, entrepreneurship, production, management
 *    ratio = combat / (combat + economy)
 *      >= 70%  → combat
 *      <= 30%  → economy
 *      else    → mixed
 * ═══════════════════════════════════════════════════════════════════ */
const RosterTool = (() => {
  const PAGE_LIMIT = 100;

  // Skill buckets — same definitions as the war detector bot, so the
  // build labels on the roster agree with what the bot uses internally.
  const COMBAT_SKILLS = ['attack','precision','dodge','armor','lootChance',
                          'criticalChance','criticalDamages','health'];
  const ECO_SKILLS    = ['companies','entrepreneurship','production','management'];

  // Build classification thresholds (combat % of combat+economy skill points).
  const COMBAT_THRESHOLD = 70;
  const ECO_THRESHOLD    = 30;

  // Last-online colour bands. Numbers are "hours since last connection".
  const ONLINE_FRESH = 24;     // < 24h ago → green
  const ONLINE_STALE = 72;     // < 72h ago → amber, else red

  // Health/hunger colour bands. Bars below these % go amber / red.
  const BAR_LOW  = 50;
  const BAR_CRIT = 25;

  // DOM
  const $username = document.getElementById('roster-username');
  const $load     = document.getElementById('roster-load');
  const $status   = document.getElementById('roster-status');
  const $content  = document.getElementById('roster-content');

  let running = false;
  const rs_trpc = (ep, input) => trpc(ep, input, { retry: true });

  /* ── Helpers ─────────────────────────────────────────────────────── */
  function setStatus(text, isError = false) {
    if (!text) { $status.classList.add('hidden'); return; }
    $status.textContent = text;
    $status.classList.toggle('error', isError);
    $status.classList.remove('hidden');
  }

  function skillLevel(user, skill) {
    const s = user?.skills?.[skill];
    if (!s || typeof s !== 'object') return 0;
    for (const k of ['total','value','level']) {
      const n = s[k];
      if (typeof n === 'number' && isFinite(n)) return n;
    }
    return 0;
  }

  // Sum combat / economy skill levels, return null if both are zero
  // (otherwise we'd classify brand-new players with no skills as "economy").
  function classifyBuild(user) {
    const combat = COMBAT_SKILLS.reduce((s, k) => s + skillLevel(user, k), 0);
    const eco    = ECO_SKILLS.reduce((s, k) => s + skillLevel(user, k), 0);
    if (combat + eco === 0) return { kind: 'unknown', ratio: null };
    const ratio = (combat / (combat + eco)) * 100;
    if (ratio >= COMBAT_THRESHOLD) return { kind: 'combat',  ratio };
    if (ratio <= ECO_THRESHOLD)    return { kind: 'economy', ratio };
    return { kind: 'mixed', ratio };
  }

  // Pill (drug) buff status. War Era exposes this as a `pill` block on
  // the lite profile; the active state has an expiry timestamp in the
  // future. Defensive about field names — we treat anything with a
  // future expiry as active.
  function pillStatus(user) {
    const p = user?.pill || user?.activePill || user?.pillCycle;
    if (!p) return { active: false, until: null };
    const untilStr = p.endsAt || p.activeUntil || p.expiresAt || p.until;
    if (!untilStr) return { active: false, until: null };
    const until = new Date(untilStr).getTime();
    if (!isFinite(until)) return { active: false, until: null };
    return { active: until > Date.now(), until };
  }

  // Health / hunger come as { current, max } pairs on the lite profile.
  // Returns { pct, label } or null if the field isn't there.
  function statBar(user, key) {
    const s = user?.[key];
    if (!s || typeof s !== 'object') return null;
    const cur = s.current, max = s.max;
    if (typeof cur !== 'number' || typeof max !== 'number' || max <= 0) return null;
    const pct = Math.max(0, Math.min(100, (cur / max) * 100));
    return { pct, label: `${Math.round(cur)} / ${Math.round(max)}` };
  }

  function fmtAgoHours(hoursAgo) {
    if (hoursAgo == null || !isFinite(hoursAgo)) return 'never';
    if (hoursAgo < 1) return 'just now';
    if (hoursAgo < 24) return `${Math.floor(hoursAgo)}h ago`;
    const days = Math.floor(hoursAgo / 24);
    return `${days}d ago`;
  }

  function onlineKind(hoursAgo) {
    if (hoursAgo == null) return 'dead';
    if (hoursAgo < ONLINE_FRESH) return 'fresh';
    if (hoursAgo < ONLINE_STALE) return 'stale';
    return 'dead';
  }

  /* ── Concurrency helper (matches other tools) ─────────────────────── */
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

  /* ── Data fetchers ────────────────────────────────────────────────── */
  async function fetchAllIrishCitizens() {
    const items = [];
    let cursor = null;
    let safety = 0;
    while (safety++ < 200) {
      const input = { countryId: IRELAND_COUNTRY_ID, limit: PAGE_LIMIT };
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

  async function fetchLiteProfiles(citizens) {
    return mapConcurrent(citizens, async (c) => {
      try {
        const lite = await rs_trpc('user.getUserLite', { userId: c._id });
        return lite ? { ...c, ...lite } : c;
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

  /* ── Rendering ───────────────────────────────────────────────────── */
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
    const tooltip = build.ratio != null
      ? `${build.ratio.toFixed(0)}% combat skills`
      : 'Too few skill points to classify';
    return `<span class="rs-build ${build.kind}" title="${tooltip}">${labels[build.kind]}</span>`;
  }

  function renderPill(pill) {
    if (!pill.active) return `<span class="rs-pill inactive">–</span>`;
    const hoursLeft = (pill.until - Date.now()) / 3600000;
    const left = hoursLeft < 1
      ? `${Math.round(hoursLeft * 60)}m`
      : `${Math.floor(hoursLeft)}h`;
    return `<span class="rs-pill active" title="Pill active for ~${left} more">Active</span>`;
  }

  function renderMu(citizen, muNames) {
    if (!citizen.mu) return `<span class="rs-mu rs-none">none</span>`;
    const name = muNames[citizen.mu] || 'unit';
    return `<span class="rs-mu"><a href="${GAME_BASE}/mu/${escapeHtml(citizen.mu)}" target="_blank" rel="noopener">${escapeHtml(name)}</a></span>`;
  }

  function renderOnline(citizen) {
    const iso = citizen?.dates?.lastConnectionAt;
    if (!iso) return `<span class="rs-online dead">never</span>`;
    const ts = new Date(iso).getTime();
    if (!isFinite(ts)) return `<span class="rs-online dead">unknown</span>`;
    const hoursAgo = (Date.now() - ts) / 3600000;
    const kind = onlineKind(hoursAgo);
    return `<span class="rs-online ${kind}">${escapeHtml(fmtAgoHours(hoursAgo))}</span>`;
  }

  function renderTable(citizens, muNames) {
    let combatN = 0, economyN = 0, mixedN = 0, unknownN = 0;
    let pillActiveN = 0;

    const rows = citizens.map(c => {
      const build = classifyBuild(c);
      if (build.kind === 'combat')  combatN++;
      else if (build.kind === 'economy') economyN++;
      else if (build.kind === 'mixed') mixedN++;
      else unknownN++;

      const pill = pillStatus(c);
      if (pill.active) pillActiveN++;

      const health = statBar(c, 'health');
      const hunger = statBar(c, 'hunger');

      return `
        <tr>
          <td class="rs-name"><a href="${GAME_BASE}/user/${escapeHtml(c._id)}" target="_blank" rel="noopener">${escapeHtml(c.username || c._id)}</a></td>
          <td>${renderBuild(build)}</td>
          <td>${renderPill(pill)}</td>
          <td>${renderBar(health)}</td>
          <td>${renderBar(hunger)}</td>
          <td>${renderMu(c, muNames)}</td>
          <td>${renderOnline(c)}</td>
        </tr>`;
    }).join('');

    const summary = `
      <div class="rs-summary">
        <span><strong>${citizens.length}</strong> citizens loaded</span>
        <span><strong>${combatN}</strong> combat</span>
        <span><strong>${economyN}</strong> economy</span>
        <span><strong>${mixedN}</strong> mixed</span>
        ${unknownN ? `<span><strong>${unknownN}</strong> too new to classify</span>` : ''}
        <span><strong>${pillActiveN}</strong> on pills</span>
      </div>`;

    if (!citizens.length) {
      return `${summary}<div class="rs-empty">No citizens returned. The data service may be down.</div>`;
    }

    return `${summary}
      <div class="rs-table-wrap">
        <table class="rs-table">
          <thead>
            <tr>
              <th>Player</th>
              <th>Build</th>
              <th>Pill</th>
              <th>Health</th>
              <th>Hunger</th>
              <th>MU</th>
              <th>Last online</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  /* ── Orchestration ───────────────────────────────────────────────── */
  async function run() {
    if (running) return;
    const raw = $username.value.trim();
    if (!raw) { $username.focus(); return; }

    running = true;
    $load.disabled = true;
    setStatus('');
    $content.innerHTML = `<div class="rs-loading"><span class="rs-spinner"></span>Looking up <strong>${escapeHtml(raw)}</strong>…</div>`;

    try {
      // Step 1: resolve the requester. Used only for the citizenship
      // gate — we don't display them anywhere specially.
      const searchRes = await rs_trpc('search.searchAnything', { searchText: raw });
      const ids = (searchRes?.userIds || []).slice(0, 10);
      const candidates = await mapConcurrent(ids, (id) =>
        rs_trpc('user.getUserLite', { userId: id }).catch(() => null), 10);
      const needle = raw.toLowerCase();
      const me = candidates.find(u => u && typeof u.username === 'string' && u.username.toLowerCase() === needle);
      if (!me) throw new Error(`No War Era user found with username "${raw}". Check the spelling and try again.`);

      const country = me.country ?? me.countryId;
      enforceIrishOnly(country, me.username);

      try { history.replaceState(null, '', `#roster?u=${encodeURIComponent(me.username)}`); } catch {}

      // Step 2: fetch the citizen pool.
      $content.innerHTML = `<div class="rs-loading"><span class="rs-spinner"></span>Loading Irish citizens…</div>`;
      const citizens = await fetchAllIrishCitizens();
      if (!citizens.length) {
        $content.innerHTML = `<div class="rs-empty">No citizens returned. The data service may be down — try again in a minute.</div>`;
        return;
      }

      // Step 3: hydrate with lite profiles (skills, status, dates).
      $content.innerHTML = `<div class="rs-loading"><span class="rs-spinner"></span>Loading ${citizens.length} player details…</div>`;
      const hydrated = await fetchLiteProfiles(citizens);

      // Step 4: collect MU names.
      const muNames = await fetchMuNames(hydrated);

      // Step 5: render.
      hydrated.sort((a, b) => (b.leveling?.level || 0) - (a.leveling?.level || 0));
      $content.innerHTML = renderTable(hydrated, muNames);
    } catch (e) {
      $content.innerHTML = '';
      const friendly = (typeof isTransientError === 'function' && isTransientError(e))
        ? `The data server is having a moment (${e.message}). Wait a few seconds and try again.`
        : e.message;
      setStatus(friendly, true);
    } finally {
      running = false;
      $load.disabled = false;
    }
  }

  /* ── Wire-up ─────────────────────────────────────────────────────── */
  $load.addEventListener('click', run);
  $username.addEventListener('keydown', e => { if (e.key === 'Enter') run(); });

  return {
    activate(params) {
      const u = (params && params.get && params.get('u')) || new URLSearchParams(location.search).get('u');
      if (u && $username.value.toLowerCase() !== u.toLowerCase()) {
        $username.value = u;
        run();
      } else if (!u && !$username.value) {
        $username.focus();
      }
    },
  };
})();