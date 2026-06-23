/* ═══════════════════════════════════════════════════════════════════
 *  MY DASHBOARD  (powers the standalone #dashboard view)
 *
 *  A single-glance overview of the tools an Irish player uses most,
 *  styled after the personal warera-toie dashboard: one centred column
 *  of detailed cards, each with per-row breakdowns, status pills and a
 *  link out to the full tool.
 *
 *    🏭 Migration  — every company with its current region/bonus/tax and
 *                    a verdict ("✓ Best placed" or "→ Country · +X%")
 *    ⏱ Clock-In    — each worker: status pill, last clock-in, stat chips,
 *                    plus 24h payroll
 *    📈 Daily Profit— simplified projected income broken into rows
 *    💰 Wealth      — current total, 7-day delta, gradient area chart
 *    🤝 Buddy       — reciprocal-pair status; join CTA if not in one
 *    🔫 Military Unit— Irish-MU status; join CTA if not in one
 *
 *  This page is deliberately NOT linked from the home view — reached only
 *  via #dashboard (or #dashboard?u=<name>).
 *
 *  Reuse: the economic model (production-bonus maths, net-per-PP pricing,
 *  salary modelling, mission rewards) and the clock-in/status logic are
 *  ported from js/daily-profit.js and js/clockin.js so the numbers and
 *  thresholds agree with the full tools.
 *
 *  Cards fill independently — cheap ones (Wealth, MU) land within a
 *  second; the heavy economy load (Migration + Profit) lands last. Each
 *  card owns its error state, so one failure never blanks the page.
 *
 *  Access: Irish-citizens-only via enforceIrishOnly (shared.js),
 *  honouring ?bypass=1.
 * ═══════════════════════════════════════════════════════════════════ */
const DashboardTool = (() => {
  const WS_BASE   = (typeof WARERASTATS_BASE !== 'undefined') ? WARERASTATS_BASE : 'https://warera-proxy.r00ted82.workers.dev/warerastats';
  const ITEMS_URL = `${WS_BASE}/items`;
  const WORK_FACTOR = 0.24;            // works/day per energy point (see daily-profit.js)
  const ACTIVE_MS = 24 * 3600 * 1000;  // < this since last clock-in → Active
  const WINDOW_MS = 48 * 3600 * 1000;  // < this → Slowing; older/never → Idle
  const MIN_MIGRATION_GAIN = 1;        // ignore sub-1% "improvements" as noise
  const CLOCKIN_PREVIEW = 6;           // worker rows shown before "show more"

  const ITEM_NAME = {
    iron:'Iron', steel:'Steel', limestone:'Limestone', concrete:'Concrete', paper:'Paper',
    wood:'Wood', oil:'Oil', petroleum:'Petroleum', fish:'Fish', steak:'Steak', grain:'Grain',
    cookedFish:'Cooked Fish', livestock:'Cow', bread:'Bread', lead:'Lead', coca:'Plant',
    lightAmmo:'Light Ammo', ammo:'Ammo', cocain:'Pill', heavyAmmo:'Heavy Ammo',
  };
  const ICON_FILE = {
    paper:'paper.png',iron:'iron.png',steel:'steel.png',limestone:'limestone.png',concrete:'concrete.png',
    wood:'wood.png',oil:'oil.png',petroleum:'petroleum.png',fish:'fish.png',steak:'steak.png',grain:'grain.png',
    cookedFish:'cookedFish.png',livestock:'livestock.png',bread:'bread.png',lead:'lead.png',
    coca:'coca.png',lightAmmo:'lightAmmo.png',ammo:'ammo.png',cocain:'cocain.png',heavyAmmo:'heavyAmmo.png',
  };
  const itemName = (code) => ITEM_NAME[code] || code || '—';
  function iconHtml(code) {
    const f = ICON_FILE[code];
    if (!f) return `<span class="dash-ic">📦</span>`;
    return `<span class="dash-ic"><img src="images/${f}" alt="" onerror="this.parentElement.textContent='📦'"></span>`;
  }

  /* ── Production-bonus model (ported from daily-profit.js / advisor) ── */
  const AGRARIAN_ITEMS = new Set(['steak','bread','fish','cookedFish','livestock','grain','coca','cocain']);
  let GAME_DEPOSIT_BONUS = 30;
  const isDepositActive = (d) => {
    if (!d) return false;
    const now = Date.now();
    const s = d.startsAt ? new Date(d.startsAt).getTime() : 0;
    const e = d.endsAt   ? new Date(d.endsAt).getTime()   : 0;
    return now >= s && now <= e;
  };
  const ethicsLean = (c) => {
    const ind = c?.industrialism;
    if (typeof ind !== 'number' || ind === 0) return 'neutral';
    return ind > 0 ? 'industrialist' : 'agrarian';
  };
  function computeBonus(country, region, itemCode) {
    if (!country) return null;
    const isSpec = country.specializedItem === itemCode;
    const lean = ethicsLean(country);
    const strategic = isSpec ? (country.strategicResources?.bonuses?.productionPercent || 0) : 0;
    const specialisation = isSpec && lean === 'industrialist' && !AGRARIAN_ITEMS.has(itemCode) ? 30 : 0;
    const hasDep = !!region?.deposit && region.deposit.type === itemCode && isDepositActive(region.deposit)
      && !(isSpec && lean === 'industrialist');
    const deposit = hasDep ? (region.deposit.bonusPercent || 0) : 0;
    const depositCountry = hasDep && lean === 'agrarian' ? GAME_DEPOSIT_BONUS : 0;
    const total = strategic + specialisation + deposit + depositCountry;
    const tax = country.taxes?.income ?? 0;
    return { total, tax, region, country };
  }

  /* ── DOM ─────────────────────────────────────────────────────────── */
  const $username = document.getElementById('dash-username');
  const $load     = document.getElementById('dash-load');
  const $status   = document.getElementById('dash-status');
  const $grid     = document.getElementById('dash-grid');

  let running = false;
  let mounted = false;

  /* ── Helpers ─────────────────────────────────────────────────────── */
  const db_trpc = (ep, input) => trpc(ep, input, { retry: true });

  function setStatus(text, isError = false) {
    if (!text) { $status.classList.add('hidden'); return; }
    $status.textContent = text;
    $status.classList.toggle('error', isError);
    $status.classList.remove('hidden');
  }

  const fmtK = (v, dp = 1) => {
    if (v == null || !isFinite(v)) return '–';
    if (Math.abs(v) >= 1_000_000) return (v / 1_000_000).toFixed(dp) + 'M';
    if (Math.abs(v) >= 1000)      return (v / 1000).toFixed(dp) + 'K';
    return v.toFixed(dp).replace(/\.0$/, '');
  };
  const pct = (v) => (v == null || !isFinite(v)) ? '–' : (v >= 0 ? '+' : '') + v.toFixed(1) + '%';
  const fmtAgo = (ms) => {
    if (ms == null || !isFinite(ms)) return 'never';
    if (ms < 60_000) return 'just now';
    if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
    if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
    return `${Math.floor(ms / 86_400_000)}d ago`;
  };

  async function mapConcurrent(items, worker, concurrency = 12) {
    const out = new Array(items.length); let i = 0;
    async function pump() {
      while (i < items.length) { const idx = i++; try { out[idx] = await worker(items[idx]); } catch { out[idx] = null; } }
    }
    await Promise.all(Array(Math.min(concurrency, items.length || 1)).fill(0).map(pump));
    return out;
  }
  async function fetchJsonUrl(url) {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) { if (res.status === 404) return null; throw new Error(`HTTP ${res.status}`); }
    return res.json();
  }

  function skill(u, name) {
    const sk = u?.skills?.[name];
    if (!sk || typeof sk !== 'object') return 0;
    for (const k of ['total','value','level']) { const n = sk[k]; if (typeof n === 'number' && isFinite(n)) return n; }
    return 0;
  }

  function orderLowestOffer(d) {
    const so = d?.sellOrders || []; let ask = Infinity;
    for (const o of so) if (typeof o.price === 'number' && o.price < ask) ask = o.price;
    return isFinite(ask) ? ask : null;
  }
  function orderMid(d) {
    const bo = d?.buyOrders || [], so = d?.sellOrders || [];
    let bid = -Infinity, ask = Infinity;
    for (const o of bo) if (typeof o.price === 'number' && o.price > bid) bid = o.price;
    for (const o of so) if (typeof o.price === 'number' && o.price < ask) ask = o.price;
    if (isFinite(bid) && isFinite(ask)) return (bid + ask) / 2;
    if (isFinite(ask)) return ask;
    if (isFinite(bid)) return bid;
    return null;
  }

  async function resolveUser(username) {
    const needle = username.trim().toLowerCase();
    if (!needle) return null;
    const res = await db_trpc('search.searchAnything', { searchText: username });
    const ids = (res?.userIds || []).slice(0, 10);
    if (!ids.length) return null;
    const profiles = await mapConcurrent(ids, (id) => db_trpc('user.getUserLite', { userId: id }).catch(() => null), 10);
    return profiles.find(u => u && typeof u.username === 'string' && u.username.toLowerCase() === needle) || null;
  }

  async function dailySalary(userId) {
    const cutoff = Date.now() - 86400000;
    let cursor = null, pages = 0, total = 0, count = 0, older = false;
    while (pages < 6 && !older) {
      const input = { userId, transactionType: 'wage', limit: 100 };
      if (cursor) input.cursor = cursor;
      const page = await db_trpc('transaction.getPaginatedTransactions', input).catch(() => null);
      if (!page) break;
      const items = page.items || page.data || [];
      for (const tx of items) {
        if (new Date(tx.createdAt).getTime() < cutoff) { older = true; continue; }
        if (tx.sellerId === userId) { total += (tx.money || 0); count++; }
      }
      cursor = page.nextCursor ?? null;
      pages++;
      if (!cursor || !items.length) break;
    }
    return { total, count };
  }

  /* ── Visual building blocks (toie style) ─────────────────────────── */
  function pill(label, kind) { return `<span class="dash-pill ${kind}">${escapeHtml(label)}</span>`; }
  function statusPill(lastMs) {
    if (lastMs == null)        return pill('Idle · never', 'loss');
    if (lastMs < ACTIVE_MS)    return pill(`Active · ${fmtAgo(lastMs)}`, 'ok');
    if (lastMs < WINDOW_MS)    return pill(`Slowing · ${fmtAgo(lastMs)}`, 'warn');
    return pill(`Idle · ${fmtAgo(lastMs)}`, 'loss');
  }
  const chip = (label, value) => `<span class="dash-chip"><i>${escapeHtml(label)}</i>${escapeHtml(String(value))}</span>`;

  /* ── Card scaffolding ────────────────────────────────────────────── */
  const CARDS = [
    { key: 'migration', icon: '🏭', title: 'Migration',     href: '#advisor' },
    { key: 'clockin',   icon: '⏱',  title: 'Clock-In',      href: '#clockin' },
    { key: 'profit',    icon: '📈', title: 'Daily Profit',  href: '#profit'  },
    { key: 'wealth',    icon: '💰', title: 'Wealth Trend',  href: '#wealth'  },
    { key: 'buddy',     icon: '🤝', title: 'Buddy System',  href: '#buddy-finder' },
    { key: 'mu',        icon: '🔫', title: 'Military Unit', href: '#mu'      },
  ];

  function renderScaffold(username) {
    const u = encodeURIComponent(username);
    $grid.innerHTML = CARDS.map(c => `
      <section class="dash-card" id="dash-card-${c.key}">
        <header class="dash-card-head">
          <span class="dash-card-icon">${c.icon}</span>
          <h3>${escapeHtml(c.title)}</h3>
          <span class="dash-card-note" id="dash-note-${c.key}"></span>
          <a class="dash-open" href="${c.href}?u=${u}" title="Open the full ${escapeHtml(c.title)} tool">Open →</a>
        </header>
        <div class="dash-card-body" id="dash-body-${c.key}">
          <div class="dash-skel"><span class="dash-spinner"></span> Loading…</div>
        </div>
      </section>`).join('');
  }
  const body = (key) => document.getElementById(`dash-body-${key}`);
  function setBody(key, html) { const el = body(key); if (el) el.innerHTML = html; }
  function setNote(key, text) { const el = document.getElementById(`dash-note-${key}`); if (el) el.textContent = text || ''; }
  function setError(key, msg) { setBody(key, `<div class="dash-err">${escapeHtml(msg)}</div>`); }
  function setHref(key, href) { const a = document.querySelector(`#dash-card-${key} .dash-open`); if (a) a.setAttribute('href', href); }
  // Big lead figure + supporting line, used by the simpler cards.
  function lead(value, sub) { return `<div class="dash-lead">${value}</div><div class="dash-sub">${sub}</div>`; }

  /* ── Card: Wealth Trend ── (toie-style: one chart; switch the metric via
   *  tabs — Total / Companies / Items / Money / Gear / Weapons — and the
   *  bucket via Day / Week / Month. The headline, delta and line colour all
   *  follow the selected metric.) ───────────────────────────────────── */
  const WEALTH_METRICS = [
    ['total',      'Total',     'var(--accent)'],
    ['companies',  'Companies', '#60a5fa'],
    ['items',      'Items',     '#fbbf24'],
    ['money',      'Money',     '#34d399'],
    ['equipments', 'Gear',      '#a78bfa'],
    ['weapons',    'Weapons',   '#f87171'],
  ];
  const wealthState = { snaps: [], metric: 'total', bucket: 'day' };

  async function fillWealth(full) {
    try {
      const w = full?.stats?.wealth;
      if (!w || typeof w !== 'object') { setBody('wealth', lead('–', 'No wealth data available.')); return; }
      const hist = await fetchJsonUrl(`data/wealth/${full._id}.json?t=${Math.floor(Date.now() / 30000)}`).catch(() => null);
      let snaps = (hist && Array.isArray(hist.snapshots)) ? hist.snapshots.filter(s => typeof s.total === 'number') : [];
      // Live "now" point carries every component so every metric tab matches.
      snaps = snaps.concat([{ t: new Date().toISOString(), companies: w.companies, items: w.items, money: w.money, equipments: w.equipments, weapons: w.weapons, total: w.total }]);
      snaps.sort((a, b) => new Date(a.t) - new Date(b.t));
      wealthState.snaps = snaps; wealthState.metric = 'total'; wealthState.bucket = 'day';

      setNote('wealth', `${snaps.length} record${snaps.length === 1 ? '' : 's'}`);

      if (snaps.length < 2) {
        setBody('wealth', lead(`₿${fmtK(w.total)}`, 'Tracking just started — the chart fills in as daily snapshots accumulate.'));
        return;
      }

      const metricTabs = WEALTH_METRICS.map(([k, label]) =>
        `<button class="dash-seg-btn${k === 'total' ? ' active' : ''}" data-val="${k}">${label}</button>`).join('');
      setBody('wealth', `
        <div class="dash-seg-row">
          <div class="dash-seg wrap" data-group="metric">${metricTabs}</div>
        </div>
        <div class="dash-seg-row">
          <div class="dash-seg" data-group="bucket">
            <button class="dash-seg-btn active" data-val="day">Day</button>
            <button class="dash-seg-btn" data-val="week">Week</button>
            <button class="dash-seg-btn" data-val="month">Month</button>
          </div>
        </div>
        <div id="dash-wlead"></div>
        <div id="dash-wchart"></div>`);
      renderWealth();
      wireWealthTabs();
    } catch (e) { setError('wealth', `Couldn't load wealth: ${e.message}`); }
  }

  // Delta for a metric over the tracked span: latest value vs the last point
  // at least a week old (else the oldest available point).
  function wealthDelta(snaps, key) {
    const pts = snaps.filter(s => typeof s[key] === 'number');
    if (pts.length < 2) return null;
    const cur = pts[pts.length - 1][key];
    const weekAgo = Date.now() - 7 * 86400000;
    let base = null;
    for (const s of pts) { if (new Date(s.t).getTime() <= weekAgo) base = s; }
    if (!base) base = pts[0];
    const change = cur - base[key];
    const pctv = base[key] ? change / base[key] * 100 : null;
    const days = Math.round((Date.now() - new Date(base.t).getTime()) / 86400000);
    return { cur, change, pctv, days };
  }

  /* ── Wealth bucketing + charts ──
   *  Buckets the full snapshot history by day / week / month (one point per
   *  bucket = the latest reading in it), so the chart uses ALL stored
   *  history, not just the endpoints. */
  function bucketKey(iso, bucket) {
    const d = new Date(iso); if (isNaN(d)) return null;
    if (bucket === 'month') return iso.slice(0, 7);
    if (bucket === 'day')   return iso.slice(0, 10);
    const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const dow = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() - (dow - 1));
    return t.toISOString().slice(0, 10);   // Monday of the ISO week
  }
  function bucketedSeries(snaps, key, bucket) {
    const m = new Map();
    for (const s of snaps) {
      const bk = bucketKey(s.t, bucket); if (!bk) continue;
      const v = s[key]; if (typeof v !== 'number') continue;
      const prev = m.get(bk); if (!prev || s.t > prev.t) m.set(bk, { t: s.t, v });
    }
    return [...m.values()].sort((a, b) => new Date(a.t) - new Date(b.t));
  }

  // preserveAspectRatio "none" stretches to full width; non-scaling-stroke
  // keeps the 2px line crisp despite the horizontal scaling.
  const CW = 600, CPAD = { t: 8, r: 6, b: 6, l: 6 };
  function geom(points, height) {
    const vals = points.map(p => p.v);
    const min = Math.min(...vals), max = Math.max(...vals), span = (max - min) || 1;
    const n = points.length, pw = CW - CPAD.l - CPAD.r, ph = height - CPAD.t - CPAD.b;
    const x = i => CPAD.l + (n === 1 ? pw / 2 : (i / (n - 1)) * pw);
    const y = v => CPAD.t + ph - ((v - min) / span) * ph;
    return { x, y, n, baseY: CPAD.t + ph };
  }
  function areaSvg(points, { color, gradId, height, hlId }) {
    const g = geom(points, height);
    const line = points.map((p, i) => `${i ? 'L' : 'M'}${g.x(i).toFixed(1)} ${g.y(p.v).toFixed(1)}`).join('');
    const area = `${line} L${g.x(g.n - 1).toFixed(1)} ${g.baseY} L${g.x(0).toFixed(1)} ${g.baseY} Z`;
    const hl = hlId ? `<line id="${hlId}" class="dash-chart-hl" x1="0" y1="${CPAD.t}" x2="0" y2="${g.baseY}" style="display:none" vector-effect="non-scaling-stroke"/>` : '';
    return `<svg class="dash-chart" style="height:${height}px" viewBox="0 0 ${CW} ${height}" preserveAspectRatio="none" aria-hidden="true">
      <defs><linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${color}" stop-opacity="0.30"/><stop offset="1" stop-color="${color}" stop-opacity="0"/>
      </linearGradient></defs>
      <path d="${area}" fill="url(#${gradId})"/>
      <path d="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>${hl}
    </svg>`;
  }
  function renderWealth() {
    const { snaps, metric, bucket } = wealthState;
    const [key, label, color] = WEALTH_METRICS.find(m => m[0] === metric) || WEALTH_METRICS[0];

    const $lead = document.getElementById('dash-wlead');
    if ($lead) {
      const d = wealthDelta(snaps, key);
      if (!d) { $lead.innerHTML = `<div class="dash-wlead-row"><span class="dash-lead">–</span></div>`; }
      else {
        const cls = d.change >= 0 ? 'dash-pos' : 'dash-neg';
        const arrow = d.change >= 0 ? '▲' : '▼';
        $lead.innerHTML = `<div class="dash-wlead-row">
          <span class="dash-lead">₿${fmtK(d.cur)}</span>
          <span class="dash-wdelta ${cls}">${arrow} ₿${fmtK(Math.abs(d.change))}${d.pctv != null ? ` (${pct(d.pctv)})` : ''}</span>
          <span class="dash-wmetric" style="color:${color}">· ${escapeHtml(label)}</span>
        </div>`;
      }
    }

    const cont = document.getElementById('dash-wchart'); if (!cont) return;
    const pts = bucketedSeries(snaps, key, bucket);
    if (pts.length < 2) { cont.innerHTML = `<div class="dash-chart-note">Only ${pts.length} ${bucket}-point so far — try Day, or check back as more snapshots accumulate.</div>`; return; }
    cont.innerHTML = `<div class="dash-chart-wrap">
      ${areaSvg(pts, { color, gradId: 'g_w', height: 130, hlId: 'dash-chl' })}
      <div class="dash-chart-tip" id="dash-chart-tip"></div>
      <div class="dash-chart-axis"><span>${escapeHtml(fmtDateShort(pts[0].t))}</span><span class="dash-chart-hint">tap chart for a date</span><span>now</span></div>
    </div>`;
    wireChartHover(pts);
  }
  function wireWealthTabs() {
    const card = document.getElementById('dash-card-wealth'); if (!card) return;
    card.addEventListener('click', e => {
      const btn = e.target.closest('.dash-seg-btn'); if (!btn) return;
      const group = btn.parentElement.dataset.group, val = btn.dataset.val;
      if (group === 'metric') wealthState.metric = val; else wealthState.bucket = val;
      btn.parentElement.querySelectorAll('.dash-seg-btn').forEach(b => b.classList.toggle('active', b === btn));
      renderWealth();
    });
  }
  function wireChartHover(points) {
    const svg = document.querySelector('#dash-card-wealth .dash-chart');
    const hl  = document.getElementById('dash-chl');
    const tip = document.getElementById('dash-chart-tip');
    if (!svg || !hl || !tip) return;
    const g = geom(points, 130);
    const move = (clientX) => {
      const r = svg.getBoundingClientRect();
      const sx = (clientX - r.left) / r.width * CW;
      let best = 0, bd = Infinity;
      for (let i = 0; i < g.n; i++) { const d = Math.abs(g.x(i) - sx); if (d < bd) { bd = d; best = i; } }
      hl.setAttribute('x1', g.x(best)); hl.setAttribute('x2', g.x(best)); hl.style.display = '';
      tip.textContent = `₿${fmtK(points[best].v)} · ${fmtDateShort(points[best].t)}`;
      tip.style.left = `${Math.min(Math.max((g.x(best) / CW) * r.width, 30), r.width - 30)}px`;
      tip.style.opacity = 1;
    };
    svg.addEventListener('mousemove', e => move(e.clientX));
    svg.addEventListener('touchmove', e => { if (e.touches[0]) move(e.touches[0].clientX); }, { passive: true });
    svg.addEventListener('mouseleave', () => { hl.style.display = 'none'; tip.style.opacity = 0; });
  }
  function fmtDateShort(iso) {
    try { return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }); } catch { return '?'; }
  }

  /* ── Card: Military Unit ─────────────────────────────────────────── */
  async function fillMU(full) {
    const findCta = `<a class="dash-cta" href="#mu?u=${encodeURIComponent(full.username)}">Find an Irish MU →</a>`;
    try {
      if (!full.mu) {
        setHref('mu', `#mu?u=${encodeURIComponent(full.username)}`);
        setBody('mu', `${pill('Not in a unit', 'loss')}
          <div class="dash-sub">Join an Irish military unit to fight together and earn rewards.</div>${findCta}`);
        return;
      }
      const mu = await db_trpc('mu.getById', { muId: full.mu }).catch(() => null);
      const name = mu?.name || 'your unit';
      const members = Array.isArray(mu?.members) ? mu.members.length : null;
      const link = `<a href="${GAME_BASE}/mu/${escapeHtml(full.mu)}" target="_blank" rel="noopener">${escapeHtml(name)}</a>`;
      const chips = members != null ? `<div class="dash-chips">${chip('Members', members)}</div>` : '';
      if (mu?.country === IRELAND_COUNTRY_ID) {
        setBody('mu', `${pill('🇮🇪 Irish unit', 'ok')}
          <div class="dash-sub">Member of ${link}.</div>${chips}`);
      } else {
        setBody('mu', `${pill('Not Irish-based', 'warn')}
          <div class="dash-sub">You're in ${link}, which isn't Irish-based. Consider an Irish unit.</div>${chips}${findCta}`);
      }
    } catch (e) { setError('mu', `Couldn't load unit: ${e.message}`); }
  }

  /* ── Card: Buddy system ──────────────────────────────────────────── */
  async function fillBuddy(full, workersP) {
    const joinCta = `<a class="dash-cta" href="#buddy-finder?u=${encodeURIComponent(full.username)}">Find a buddy →</a>`;
    // Pitch: the buddy system is close to free money, so make the upside obvious.
    const why = `
      <div class="dash-why">
        <strong>Why buddy up? It's basically free production:</strong>
        <ul>
          <li>👷 You instantly gain an extra worker in your company — more production points every single day.</li>
          <li>💸 You hire each other at <strong>minimum wage</strong>, so the wages just circle back between you — near-zero real cost.</li>
          <li>📈 More output means more profit and a faster climb up the rankings — for both of you.</li>
          <li>🇮🇪 It strengthens the whole Irish economy. We grow faster together.</li>
        </ul>
        <p class="dash-why-foot">Takes 30 seconds: get matched with a player at your level, message them, and you each post a minimum-wage job. That's it.</p>
      </div>`;
    const notIn = (reason) => {
      setHref('buddy', `#buddy-finder?u=${encodeURIComponent(full.username)}`);
      setBody('buddy', `${pill('Not in the buddy system', 'warn')}<div class="dash-sub">${reason}</div>${why}${joinCta}`);
    };
    try {
      if (!full.company) { notIn('You have no energy job. A buddy hires you (and you hire them) at minimum wage, so both your companies get a free-ish worker.'); return; }
      const jobCo = await db_trpc('company.getById', { companyId: full.company }).catch(() => null);
      const employer = jobCo?.user || jobCo?.owner || null;
      if (!employer || employer === full._id) { notIn('Your energy job is in your own company — no reciprocal buddy yet.'); return; }

      const workersData = await workersP;
      const myWorkerIds = new Set();
      (workersData?.workersPerCompany || []).forEach(({ workers }) =>
        (workers || []).forEach(w => { const id = w?.user || (typeof w === 'string' ? w : null); if (id) myWorkerIds.add(id); }));

      if (myWorkerIds.has(employer)) {
        const partner = await db_trpc('user.getUserLite', { userId: employer }).catch(() => null);
        const pName = partner?.username || 'your buddy';
        setBody('buddy', `${pill('🤝 In a buddy pair', 'ok')}
          <div class="dash-sub">Reciprocal hire with <a href="${GAME_BASE}/user/${escapeHtml(employer)}" target="_blank" rel="noopener">${escapeHtml(pName)}</a> — you each employ the other.</div>`);
      } else {
        notIn('You work for someone who doesn\'t employ you back — that\'s not a reciprocal buddy pair.');
      }
    } catch (e) { setError('buddy', `Couldn't check buddy status: ${e.message}`); }
  }

  /* ── Card: Clock-In ──────────────────────────────────────────────── */
  async function fillClockin(full, companiesP, workersP) {
    try {
      const workersData = await workersP;
      // Build worker rows from the roster: id, wage, fidelity, company tag.
      const rows = [];
      (workersData?.workersPerCompany || []).forEach((entry) => {
        const co = (entry && typeof entry.company === 'object') ? entry.company : null;
        (entry.workers || []).forEach(w => {
          const id = w?.user || (typeof w === 'string' ? w : null);
          if (!id || id === full._id) return;
          rows.push({ id, wage: typeof w?.wage === 'number' ? w.wage : null, fidelity: w?.fidelity || 0,
                      coName: co?.name || null, coItem: co?.itemCode || null });
        });
      });
      // De-dupe (a worker holds one contract).
      const seen = new Set();
      const workers = rows.filter(r => (seen.has(r.id) ? false : seen.add(r.id)));
      if (!workers.length) { setBody('clockin', lead('No workers', 'Nobody is employed in your companies right now.')); return; }

      // Profiles (name + skills) and latest clock-in / 24h pay, per worker.
      const now = Date.now(), cutoff = now - ACTIVE_MS;
      await mapConcurrent(workers, async (w) => {
        const [lite, page] = await Promise.all([
          db_trpc('user.getUserLite', { userId: w.id }).catch(() => null),
          db_trpc('transaction.getPaginatedTransactions', { userId: w.id, transactionType: 'wage', limit: 100 }).catch(() => null),
        ]);
        w.name = lite?.username || null;
        w.production = skill(lite, 'production');
        w.energy = skill(lite, 'energy');
        let last = null, paid = 0;
        for (const tx of (page?.items || page?.data || [])) {
          if (tx.sellerId !== w.id) continue;
          if (full._id && tx.buyerId !== full._id) continue;
          const t = new Date(tx.createdAt).getTime();
          if (!isFinite(t)) continue;
          if (last == null || t > last) last = t;
          if (t >= cutoff) paid += (tx.money || 0);
        }
        w.lastMs = last == null ? null : now - last;
        w.paid24 = paid;
      }, 6);

      const active = workers.filter(w => w.lastMs != null && w.lastMs < ACTIVE_MS).length;
      const idle   = workers.length - active;
      const payroll = workers.reduce((s, w) => s + (w.paid24 || 0), 0);
      setNote('clockin', `${workers.length} worker${workers.length === 1 ? '' : 's'}`);

      // Idle first, then most-recently-active.
      workers.sort((a, b) => (b.lastMs ?? Infinity) - (a.lastMs ?? Infinity));
      const rowHtml = (w) => {
        const link = w.name
          ? `<a href="${GAME_BASE}/user/${w.id}" target="_blank" rel="noopener">${escapeHtml(w.name)}</a>`
          : `<span class="dash-muted">user ${escapeHtml(w.id).slice(-6)}</span>`;
        const co = w.coName || w.coItem
          ? `<span class="dash-tag">${w.coItem ? iconHtml(w.coItem) : ''}${escapeHtml(w.coName || itemName(w.coItem))}</span>` : '';
        const chips = [
          w.production ? chip('Prod', Math.round(w.production)) : '',
          w.energy ? chip('Energy', Math.round(w.energy)) : '',
          w.wage != null ? chip('Wage', w.wage) : '',
          w.fidelity ? chip('Fid', w.fidelity) : '',
        ].join('');
        return `<div class="dash-row">
          <div class="dash-row-main"><div class="dash-row-title">${link} ${co}</div>${statusPill(w.lastMs)}</div>
          <div class="dash-chips">${chips}</div>
        </div>`;
      };

      const preview = workers.slice(0, CLOCKIN_PREVIEW).map(rowHtml).join('');
      const rest = workers.slice(CLOCKIN_PREVIEW);
      const more = rest.length
        ? `<details class="dash-more"><summary>Show ${rest.length} more worker${rest.length === 1 ? '' : 's'}</summary>${rest.map(rowHtml).join('')}</details>`
        : '';
      setBody('clockin', `
        <div class="dash-statline">
          <span class="dash-pos">${active} active</span> · <span class="${idle ? 'dash-neg' : 'dash-muted'}">${idle} idle</span>
          <span class="dash-muted">· payroll 24h <strong>₿${fmtK(payroll)}</strong></span>
        </div>
        <div class="dash-rows">${preview}${more}</div>`);
    } catch (e) { setError('clockin', `Couldn't load workers: ${e.message}`); }
  }

  /* ── Heavy shared load: economy (Profit + Migration) ─────────────── */
  async function fillEconomy(full, companiesP, workersP) {
    try {
      const companyList = await companiesP;
      const companyIds = companyList?.items || [];
      if (!companyIds.length) {
        setBody('profit', lead('No companies', 'You own no companies to project profit from.'));
        setBody('migration', lead('No companies', 'Buy a company first, then check for a better location.'));
        return;
      }

      const workersData = await workersP;
      const [allCompaniesRaw, itemsArr, gameConfig, regionsObj, allCountriesRaw, wsCountries, salaryInfo] = await Promise.all([
        mapConcurrent(companyIds, (id) => db_trpc('company.getById', { companyId: id }).catch(() => null)),
        fetchJsonUrl(ITEMS_URL).catch(() => []),
        db_trpc('gameConfig.getGameConfig', {}).catch(() => null),
        db_trpc('region.getRegionsObject', {}),
        db_trpc('country.getAllCountries', {}),
        fetch(`${WS_BASE}/countries`).then(r => r.json()).catch(() => []),
        dailySalary(full._id),
      ]);
      const companies = allCompaniesRaw.filter(c => c && !c.disabledAt);
      if (!companies.length) {
        setBody('profit', lead('No active companies', 'All your companies are disabled.'));
        setBody('migration', lead('No active companies', 'All your companies are disabled.'));
        return;
      }

      const gameItems = gameConfig?.items || {};
      const aeLevels  = gameConfig?.upgradesConfig?.automatedEngine?.levels || {};
      const aeDailyProd = (lvl) => aeLevels[lvl]?.stats?.dailyProd || 0;
      const cfgDep = gameConfig?.company?.depositResourceBonus;
      if (typeof cfgDep === 'number') GAME_DEPOSIT_BONUS = cfgDep;

      const ownedItems = new Set(companies.map(c => c.itemCode).filter(Boolean));
      const needed = new Set(ownedItems);
      for (const code of ownedItems) {
        const needs = gameItems[code]?.productionNeeds || {};
        for (const k in needs) needed.add(k);
      }
      const avgPrices = {};
      (Array.isArray(itemsArr) ? itemsArr : []).forEach(it => { if (it?.itemCode != null && typeof it.avg === 'number') avgPrices[it.itemCode] = it.avg; });
      const prices = {};
      await mapConcurrent([...needed], async (code) => {
        const ob = await db_trpc('tradingOrder.getTopOrders', { itemCode: code }).catch(() => null);
        const p = orderLowestOffer(ob) ?? orderMid(ob) ?? avgPrices[code];
        if (p != null) prices[code] = p;
      });

      const allCountries = Array.isArray(allCountriesRaw) ? allCountriesRaw : (allCountriesRaw?.items || []);
      const countryById = {};
      await mapConcurrent(allCountries, async (c) => {
        const fc = await db_trpc('country.getCountryById', { countryId: c._id }).catch(() => null);
        if (fc) countryById[c._id] = fc;
      }, 25);
      (Array.isArray(wsCountries) ? wsCountries : []).forEach(c => {
        if (c && c.countryId != null && c.industrialism != null && countryById[c.countryId]) countryById[c.countryId].industrialism = c.industrialism;
      });

      const netPerPP = (code, bonusPct) => {
        const it = gameItems[code]; const pp = it?.productionPoints || 0;
        const sale = prices[code]; if (!pp || sale == null) return null;
        let rc = 0; const needs = it.productionNeeds || {};
        for (const k in needs) { if (prices[k] == null) return null; rc += needs[k] * prices[k]; }
        return (sale - rc) * (1 + bonusPct / 100) / pp;
      };

      const regionsByCountry = {};
      Object.values(regionsObj).forEach(r => { if (r?.country) (regionsByCountry[r.country] = regionsByCountry[r.country] || []).push(r); });

      const workerEntries = [];
      (workersData?.workersPerCompany || []).forEach(({ company, workers }) =>
        (workers || []).forEach(w => { if (w && w.user) workerEntries.push({ companyId: company?._id, userId: w.user, wage: w.wage, fidelity: w.fidelity }); }));
      const uniqueWorkerIds = [...new Set(workerEntries.map(w => w.userId).filter(id => id !== full._id))];
      const workerProfiles = { [full._id]: full };
      await mapConcurrent(uniqueWorkerIds, async (id) => {
        const lite = await db_trpc('user.getUserLite', { userId: id }).catch(() => null);
        if (lite) workerProfiles[id] = lite;
      });

      const companyById = {};
      companies.forEach(c => {
        companyById[c._id] = c;
        const region  = regionsObj[c.region];
        const country  = region ? countryById[region.country] : null;
        c._region = region;
        c._bonus  = computeBonus(country, region, c.itemCode) || { total: 0, tax: country?.taxes?.income ?? null, country };
        c._netPP  = netPerPP(c.itemCode, 0);
        c._dailyAE = aeDailyProd(c.activeUpgradeLevels?.automatedEngine);
        c._aeBonus = c._dailyAE * (1 + c._bonus.total / 100);
        c._workersManual = 0;
        c._wageCost = 0;
      });
      workerEntries.forEach(w => {
        const c = companyById[w.companyId]; if (!c) return;
        const prof = workerProfiles[w.userId]; if (!prof) return;
        const basePP = skill(prof, 'production') * skill(prof, 'energy') * WORK_FACTOR;
        const fid  = typeof w.fidelity === 'number' ? w.fidelity : 0;
        const wage = typeof w.wage === 'number' ? w.wage : 0;
        c._workersManual += basePP * (1 + (fid + c._bonus.total) / 100);
        c._wageCost      += basePP * wage;
      });
      const selfPP = skill(full, 'production') * skill(full, 'entrepreneurship') * WORK_FACTOR;
      if (selfPP > 0) {
        let best = null, bestv = -Infinity;
        for (const c of companies) { const v = c._netPP == null ? -Infinity : c._netPP; if (v > bestv) { bestv = v; best = c; } }
        if (best) best._workersManual += selfPP * (1 + best._bonus.total / 100);
      }

      // ── Profit ──
      let companiesIncome = 0;
      companies.forEach(c => { if (c._netPP != null) companiesIncome += c._netPP * (c._aeBonus + c._workersManual) - c._wageCost; });
      const salaryWorksPerDay = skill(full, 'energy') * WORK_FACTOR;
      const salaryAvg = salaryInfo.count ? salaryInfo.total / salaryInfo.count : 0;
      const salaryDaily = salaryWorksPerDay * salaryAvg;
      const total = companiesIncome + salaryDaily;

      const incRow = (label, value, sub) =>
        `<div class="dash-inc"><span class="dash-inc-l">${escapeHtml(label)}</span><span class="dash-inc-v">₿${fmtK(value)}</span><span class="dash-inc-s">${escapeHtml(sub)}</span></div>`;
      setNote('profit', `${companies.length} compan${companies.length === 1 ? 'y' : 'ies'}`);
      setBody('profit', `
        <div class="dash-lead">₿${fmtK(total)}<small>/day</small></div>
        <div class="dash-sub">Projected daily profit.</div>
        <div class="dash-inc-list">
          ${incRow('Companies', companiesIncome, `${companies.length} active, current output`)}
          ${incRow('Salary', salaryDaily, salaryInfo.count ? `~${salaryWorksPerDay.toFixed(0)} works/day × ${salaryAvg.toFixed(2)} net` : 'no recent wages')}
        </div>`);

      // ── Migration ──
      const bestForItem = {};
      for (const code of ownedItems) {
        let best = { total: 0, country: null, region: null };
        for (const cid in countryById) {
          const country = countryById[cid];
          for (const region of (regionsByCountry[cid] || [])) {
            const b = computeBonus(country, region, code);
            if (b && b.total > best.total) best = { total: b.total, country, region };
          }
        }
        bestForItem[code] = best;
      }
      const migs = companies.map(c => {
        const best = bestForItem[c.itemCode] || { total: 0 };
        return { c, best, gain: best.total - c._bonus.total };
      }).sort((a, b) => b.gain - a.gain);
      const improvable = migs.filter(m => m.gain > MIN_MIGRATION_GAIN);
      const placed = migs.filter(m => m.gain <= MIN_MIGRATION_GAIN);
      setNote('migration', `${companies.length} compan${companies.length === 1 ? 'y' : 'ies'}`);

      const migRow = (m, ok) => {
        const c = m.c;
        const curRegion = c._region?.name || '—';
        const curTax = c._bonus.tax != null ? ` · ${c._bonus.tax}% tax` : '';
        const verdict = ok
          ? `<span class="dash-verdict ok">✓ Best placed</span>`
          : `<span class="dash-verdict move">→ ${escapeHtml(m.best.country?.name || 'elsewhere')}${m.best.region ? ' · ' + escapeHtml(m.best.region.name) : ''}<b>${pct(m.gain)}</b></span>`;
        return `<div class="dash-row mig">
          <div class="dash-row-main">
            <div class="dash-row-title">${iconHtml(c.itemCode)} <strong>${escapeHtml(c.name || itemName(c.itemCode))}</strong></div>
            ${verdict}
          </div>
          <div class="dash-sub small">${escapeHtml(itemName(c.itemCode))} · ${escapeHtml(curRegion)} · ${pct(c._bonus.total)} bonus${curTax}</div>
        </div>`;
      };

      let html = '';
      if (improvable.length) {
        const topGain = improvable[0].gain;   // migs are sorted by gain, descending
        const who = improvable.length === 1 ? 'Your company' : `${improvable.length} of your companies`;
        const urgency = topGain >= 15 ? 'Worth relocating now.' : 'Worth a move.';
        html += `<div class="dash-warn">${pill('⚠ Move suggested', 'warn')}
          <span>${who} could produce more elsewhere — up to <strong>+${topGain.toFixed(1)}%</strong>. ${urgency}</span></div>`;
        html += `<div class="dash-rows">${improvable.map(m => migRow(m, false)).join('')}</div>`;
        html += `<a class="dash-cta" href="#advisor?u=${encodeURIComponent(full.username)}">Plan the move →</a>`;
      }
      if (placed.length && !improvable.length) {
        html += `<div class="dash-statline"><span class="dash-pos">🎉 All ${placed.length} compan${placed.length === 1 ? 'y is' : 'ies are'} best-placed</span></div>`;
      } else if (placed.length) {
        html += `<details class="dash-more"><summary>${placed.length} already best-placed</summary><div class="dash-rows">${placed.map(m => migRow(m, true)).join('')}</div></details>`;
      }
      setBody('migration', html || lead('—', 'No placement data.'));
    } catch (e) {
      setError('profit', `Couldn't load economy: ${e.message}`);
      setError('migration', `Couldn't load economy: ${e.message}`);
    }
  }

  /* ── Orchestration ───────────────────────────────────────────────── */
  async function run() {
    if (running) return;
    const raw = $username.value.trim();
    if (!raw) { $username.focus(); return; }

    running = true;
    $load.disabled = true;
    setStatus('');
    setTrpcCache(true);   // dedupe the country/profile fetches shared across cards
    $grid.innerHTML = `<div class="dash-loading"><span class="dash-spinner"></span> Looking up “${escapeHtml(raw)}”…</div>`;

    try {
      const lite = await resolveUser(raw);
      if (!lite) throw new Error(`No War Era user found with username “${raw}”. Check the spelling and try again.`);
      enforceIrishOnly(lite.country ?? lite.countryId, lite.username);

      const full = await db_trpc('user.getUserById', { userId: lite._id });
      if (!full) throw new Error(`Couldn't load profile for ${lite.username}.`);

      try { history.replaceState(null, '', `#dashboard?u=${encodeURIComponent(full.username)}`); } catch {}
      renderScaffold(full.username);

      const companiesP = db_trpc('company.getCompanies', { userId: full._id, perPage: 100 }).catch(() => null);
      const workersP   = db_trpc('worker.getWorkers',    { userId: full._id }).catch(() => null);

      fillWealth(full);
      fillMU(full);
      fillBuddy(full, workersP);
      fillClockin(full, companiesP, workersP);
      fillEconomy(full, companiesP, workersP);
    } catch (e) {
      $grid.innerHTML = '';
      const friendly = isTransientError(e)
        ? `The data server is having a moment (${e.message}). Wait a few seconds and try again.`
        : e.message;
      setStatus(friendly, true);
    } finally {
      running = false;
      $load.disabled = false;
    }
  }

  // Leaving the dashboard: turn the shared cache off (and clear it) so other
  // views behave exactly as before.
  window.addEventListener('hashchange', () => {
    const view = location.hash.replace(/^#/, '').split('?')[0] || 'home';
    if (view !== 'dashboard' && mounted) { setTrpcCache(false); mounted = false; }
  });

  /* ── Wire-up ─────────────────────────────────────────────────────── */
  $load.addEventListener('click', run);
  $username.addEventListener('keydown', e => { if (e.key === 'Enter') run(); });

  return {
    activate(params) {
      mounted = true;
      const u = (params && params.get && params.get('u')) || new URLSearchParams(location.search).get('u');
      if (u && $username.value.toLowerCase() !== u.toLowerCase()) { $username.value = u; run(); }
      else if (!u && !$username.value) $username.focus();
    },
  };
})();
