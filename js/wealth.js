/* ═══════════════════════════════════════════════════════════════════
 *  WEALTH MONITOR  (#wealth, and a tab in the #home shell)
 *
 *  Look up an Irish player → show their current wealth (its own box) and
 *  a wealth-over-time chart (total or 5-way breakdown), bucketed by
 *  day/week/month. Inside the home shell it's driven by the shared
 *  username field via activate({u}); standalone (#wealth) it uses its own
 *  input. Nothing renders until a username is supplied.
 *
 *  Data:
 *    - Current wealth: user.getUserById → stats.wealth (live).
 *    - History: data/wealth-history.json, collected every 2h by
 *      wealth_log.py. The API has no per-user wealth history, so the
 *      chart only covers the period since a player was added; gaps
 *      (incl. removed-then-re-added) render as real-width blanks.
 *    - Monitor list: monitored-users.json, toggled via the Worker's
 *      /monitored-update route (repository_dispatch → Action).
 *
 *  Access: Irish-citizens-only via enforceIrishOnly (shared.js),
 *  honouring ?bypass=1.
 * ═══════════════════════════════════════════════════════════════════ */
const WealthMonitorTool = (() => {
  const MONITORED_URL = 'monitored-users.json';
  const HISTORY_URL   = 'data/wealth-history.json';
  const MONITORED_UPDATE_URL = 'https://warera-proxy.toie.workers.dev/monitored-update';

  const COMPONENTS = [
    { key: 'companies',  label: 'Companies', color: '#60a5fa' },
    { key: 'items',      label: 'Items',     color: '#fbbf24' },
    { key: 'money',      label: 'Money',     color: '#34d399' },
    { key: 'equipments', label: 'Equipment', color: '#a78bfa' },
    { key: 'weapons',    label: 'Weapons',   color: '#f87171' },
  ];
  const TOTAL_COLOR = '#4ade80';

  const RECENT_KEY = 'wm:recent-usernames';
  const RECENT_MAX = 8;

  // DOM
  const $username  = document.getElementById('wm-username');
  const $submit    = document.getElementById('wm-submit');
  const $recent    = document.getElementById('wm-recent');
  const $status    = document.getElementById('wm-status');
  const $count     = document.getElementById('wm-count');
  const $statsCard = document.getElementById('wm-stats-card');
  const $chartCard = document.getElementById('wm-chart-card');
  const $monitorCard = document.getElementById('wm-monitor-card');
  const $monitorText = document.getElementById('wm-monitor-text');
  const $summary   = document.getElementById('wm-summary');
  const $breakdown = document.getElementById('wm-breakdown');
  const $metricSeg = document.getElementById('wm-metric-seg');
  const $bucketSeg = document.getElementById('wm-bucket-seg');
  const $chartBox  = document.getElementById('wm-chart-box');
  const $legend    = document.getElementById('wm-legend');
  const steps      = makeSteps(document.getElementById('wm-steps'));

  // State
  let monitored = [];                 // [{ userId, username }]
  let history   = { users: {} };      // wealth-history.json
  let current   = null;               // { user, wealth, avatarUrl } for the resolved player
  let dataLoaded = false;             // monitored list + history fetched once
  const chart   = { user: null, metric: 'total', bucket: 'day' };

  // Helpers
  const wm_trpc = (endpoint, input) => trpc(endpoint, input, { retry: true });

  function fmtK(v, dp = 2) {
    if (v == null || !isFinite(v)) return '–';
    return Math.abs(v) >= 1000 ? (v / 1000).toFixed(dp) + 'K' : v.toFixed(dp);
  }

  function showStatus(level, html) {
    $status.className = `bf-inline-status ${level}`;
    $status.innerHTML = html;
    $status.classList.remove('hidden');
  }
  function hideStatus() { $status.classList.add('hidden'); $status.innerHTML = ''; }

  async function fetchJson(url) {
    const res = await fetch(`${url}?t=${Math.floor(Date.now() / 30000)}`, { cache: 'no-cache' });
    if (!res.ok) { if (res.status === 404) return null; throw new Error(`HTTP ${res.status}`); }
    return res.json();
  }

  async function mapConcurrent(items, worker, concurrency = 10) {
    const results = new Array(items.length);
    let i = 0;
    async function pump() {
      while (i < items.length) {
        const idx = i++;
        try { results[idx] = await worker(items[idx]); } catch { results[idx] = null; }
      }
    }
    await Promise.all(Array(Math.min(concurrency, items.length)).fill(0).map(pump));
    return results;
  }

  // Same anti-fuzzy resolution as the other tools: search, then verify an
  // exact username match. Never fall back to the top hit.
  async function resolveUsername(username) {
    const needle = username.trim().toLowerCase();
    if (!needle) return null;
    const searchRes = await wm_trpc('search.searchAnything', { searchText: username });
    const ids = (searchRes?.userIds || []).slice(0, 10);
    if (!ids.length) return null;
    const profiles = await mapConcurrent(ids, async (id) => {
      try { return await wm_trpc('user.getUserLite', { userId: id }); } catch { return null; }
    });
    return profiles.find(u =>
      u && typeof u.username === 'string' && u.username.toLowerCase() === needle
    ) || null;
  }

  async function fetchCurrentWealth(userId) {
    const data = await wm_trpc('user.getUserById', { userId });
    const wealth = data?.stats?.wealth;
    if (!wealth || typeof wealth !== 'object') return null;
    return { username: data.username, avatarUrl: data.avatarUrl, wealth };
  }

  async function dispatchUpdate(action, userId, username) {
    const res = await fetch(MONITORED_UPDATE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, userId, username }),
    });
    if (!res.ok) {
      let detail = '';
      try { const b = await res.json(); detail = b?.error ? `: ${b.error}` : ''; }
      catch { const t = await res.text().catch(() => ''); if (t) detail = `: ${t.slice(0, 200)}`; }
      throw new Error(`Update failed (HTTP ${res.status})${detail}`);
    }
    return true;
  }

  function setCount() {
    const n = monitored.length;
    $count.innerHTML = `Monitoring <strong>${n}</strong> player${n === 1 ? '' : 's'}`;
  }

  // ── Recent usernames (localStorage) — mirrors the toolkit shell ─
  function readRecent() {
    try { const a = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); return Array.isArray(a) ? a.filter(x => typeof x === 'string') : []; }
    catch { return []; }
  }
  function writeRecent(list) {
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX))); } catch { /* storage off */ }
  }
  function rememberUsername(u) {
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
          <button class="stg-recent-pick" data-wm-recent="${safe}">${safe}</button>
          <button class="stg-recent-del" data-wm-recent-del="${safe}" title="Remove">×</button>
        </span>`;
      }).join('');
  }

  // ── Look-up flow ────────────────────────────────────────────────
  async function handleSubmit() {
    const raw = $username.value.trim();
    if (!raw) { showStatus('warn', 'Please enter an in-game username.'); $username.focus(); return; }
    if (raw.length > 40) { showStatus('warn', 'Username looks too long. Please double-check.'); return; }

    $submit.disabled = true;
    $statsCard.classList.add('hidden');
    $chartCard.classList.add('hidden');
    $monitorCard.classList.add('hidden');
    hideStatus();
    steps.reset();

    try {
      steps.setStep(1, 'active', { sub: `Searching for "${raw}"` });
      let user;
      try { user = await resolveUsername(raw); }
      catch (e) {
        steps.markActiveAsError('Lookup failed');
        throw new Error(isTransientError(e)
          ? `The data server is having a moment (${e.message}). Wait a few seconds and try again.`
          : `Username lookup failed: ${e.message}`);
      }
      if (!user) {
        steps.markActiveAsError('No user found with that name');
        throw new Error(`No War Era user found with username "${raw}". Check the spelling and try again.`);
      }

      // Irish-citizens-only. ?bypass=1 (query or hash) lifts it.
      enforceIrishOnly(user.country ?? user.countryId, user.username);
      steps.setStep(1, 'done', { count: `→ ${user.username}` });

      // Shareable URL + remember the verified name as a quick-pick chip.
      // The hash rewrite (same shape as the other tools) is what the home
      // shell's hash guard folds back into #home?u=…&tool=wealth. Use the
      // real window.history — `history` is our local wealth-history state.
      try { window.history.replaceState(null, '', `#wealth?u=${encodeURIComponent(user.username)}`); } catch {}
      rememberUsername(user.username);

      steps.setStep(2, 'active', { sub: 'Fetching current wealth' });
      const live = await fetchCurrentWealth(user._id);
      if (!live) { steps.markActiveAsError('No wealth data'); throw new Error(`Couldn't read wealth for ${user.username}.`); }
      const hist = await fetchJson(HISTORY_URL).catch(() => null);
      if (hist && hist.users) history = hist;
      steps.setStep(2, 'done');
      steps.fadeOut(300);

      current = { user, wealth: live.wealth, avatarUrl: live.avatarUrl };
      chart.user = user._id;
      renderResults();
    } catch (e) {
      steps.markActiveAsError(e.message);
      showStatus('error', escapeHtml(e.message));
    } finally {
      $submit.disabled = false;
    }
  }

  // ── Results rendering ───────────────────────────────────────────
  function avatarHtml(username, avatarUrl) {
    const initial = (username || '?').slice(0, 1).toUpperCase();
    if (avatarUrl && /^https?:\/\//.test(avatarUrl)) {
      return `<div class="wm-avatar"><img src="${escapeHtml(avatarUrl)}" alt="" onerror="this.parentElement.textContent='${escapeHtml(initial)}'"></div>`;
    }
    return `<div class="wm-avatar">${escapeHtml(initial)}</div>`;
  }

  function renderSummary() {
    const { user, wealth, avatarUrl } = current;
    $summary.innerHTML =
      avatarHtml(user.username, avatarUrl) +
      `<span class="wm-name"><a href="${GAME_BASE}/user/${user._id}" target="_blank" rel="noopener">${escapeHtml(user.username)}</a></span>` +
      `<span class="wm-total">${fmtK(wealth.total)}<small>total wealth</small></span>`;
  }

  // The clear monitor CTA at the bottom. Re-rendered whenever the
  // monitored state flips so the label always matches reality.
  function renderMonitorCard() {
    const on = monitored.some(e => e.userId === current.user._id);
    const name = escapeHtml(current.user.username);
    if (on) {
      $monitorText.innerHTML = `✅ <strong>${name}</strong> is being monitored — wealth is snapshotted every 2 hours. Stopping keeps the history already collected.`;
      $monitorCard.querySelector('#wm-mon').outerHTML = `<button id="wm-mon" class="wm-stop-btn">Stop monitoring</button>`;
    } else {
      $monitorText.innerHTML = `<strong>${name}</strong> isn't monitored yet. Add them to the watch list and their wealth will be snapshotted every 2 hours — the chart builds up over the following day or so.`;
      $monitorCard.querySelector('#wm-mon').outerHTML = `<button id="wm-mon" class="btn-primary wm-mon-btn">➕ Start monitoring ${name}</button>`;
    }
    document.getElementById('wm-mon').addEventListener('click', onMonClick);
  }

  function renderResults() {
    renderSummary();
    $breakdown.innerHTML = COMPONENTS.map(c =>
      `<span title="${c.label}"><span class="wm-dot" style="background:${c.color}"></span>${c.label}: <b>${fmtK(current.wealth[c.key])}</b></span>`
    ).join('');
    $statsCard.classList.remove('hidden');
    $monitorCard.classList.remove('hidden');
    document.getElementById('wm-mon-status').textContent = '';
    renderMonitorCard();
    updateChartVisibility();
  }

  // The chart only makes sense once a player is monitored — otherwise
  // there's no history and never will be. Hide the whole section until then.
  function updateChartVisibility() {
    const on = monitored.some(e => e.userId === current.user._id);
    $chartCard.classList.toggle('hidden', !on);
    if (on) renderChart();
  }

  async function onMonClick() {
    const add = !monitored.some(e => e.userId === current.user._id);
    const { user } = current;
    const $btn = document.getElementById('wm-mon');
    const $st = document.getElementById('wm-mon-status');
    $btn.disabled = true;
    $st.innerHTML = `<span class="bf-spinner"></span>${add ? 'Adding' : 'Removing'}…`;
    try {
      await dispatchUpdate(add ? 'add' : 'remove', user._id, user.username);
    } catch (e) {
      $st.textContent = `Failed: ${e.message}`;
      $btn.disabled = false;
      return;
    }
    if (add) {
      if (!monitored.some(e => e.userId === user._id)) monitored.push({ userId: user._id, username: user.username });
    } else {
      monitored = monitored.filter(e => e.userId !== user._id);
    }
    setCount();
    renderMonitorCard();                   // flips the button to its new state
    document.getElementById('wm-mon-status').textContent = add
      ? 'Added! It takes about a minute to land on the list, then a snapshot is taken every 2 hours — so the chart will only start showing a trend after a day or so. Check back tomorrow.'
      : 'Removed · existing history is kept; no new snapshots will be collected.';
    updateChartVisibility();
    setTimeout(refreshMonitored, 60000);
  }

  // ── Bucketing ───────────────────────────────────────────────────
  function bucketKey(iso, bucket) {
    const d = new Date(iso);
    if (isNaN(d)) return null;
    if (bucket === 'month') return iso.slice(0, 7);
    if (bucket === 'day')   return iso.slice(0, 10);
    const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const dow = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() - (dow - 1));
    return t.toISOString().slice(0, 10);
  }

  function bucketedValues(snapshots, key, bucket) {
    const byBucket = new Map();   // bucketKey -> { t, value }
    for (const s of snapshots || []) {
      const bk = bucketKey(s.t, bucket);
      if (!bk) continue;
      const v = s[key];
      if (typeof v !== 'number') continue;
      const prev = byBucket.get(bk);
      if (!prev || s.t > prev.t) byBucket.set(bk, { t: s.t, value: v });
    }
    const out = new Map();
    for (const [bk, o] of byBucket) out.set(bk, o.value);
    return out;
  }

  // Complete, gap-inclusive sequence of bucket keys from first..last. This
  // is what gives gaps their REAL WIDTH — every missing day/week/month gets
  // an x-slot even though no series has a value there.
  function allBuckets(firstISO, lastISO, bucket) {
    const start = new Date(firstISO), end = new Date(lastISO);
    if (isNaN(start) || isNaN(end)) return [];
    const keys = [];
    if (bucket === 'month') {
      let y = start.getUTCFullYear(), m = start.getUTCMonth();
      const ey = end.getUTCFullYear(), em = end.getUTCMonth();
      while (y < ey || (y === ey && m <= em)) {
        keys.push(`${y}-${String(m + 1).padStart(2, '0')}`);
        if (++m > 11) { m = 0; y++; }
      }
      return keys;
    }
    const stepDays = bucket === 'week' ? 7 : 1;
    const norm = (dt) => {
      const c = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()));
      if (bucket === 'week') { const dow = c.getUTCDay() || 7; c.setUTCDate(c.getUTCDate() - (dow - 1)); }
      return c;
    };
    let cur = norm(start); const last = norm(end);
    let guard = 0;
    while (cur <= last && guard++ < 5000) {
      keys.push(cur.toISOString().slice(0, 10));
      cur.setUTCDate(cur.getUTCDate() + stepDays);
    }
    return keys;
  }

  function buildSeries() {
    const snaps = (history.users[chart.user]?.snapshots || []).slice();
    // Append the live "now" reading so the chart's right edge matches the
    // game. Stored snapshots lag by up to the cron interval, so without this
    // the last point can sit hours behind the in-game figure. `current` is
    // the resolved player and chart.user is always their id.
    if (current && current.user._id === chart.user && current.wealth) {
      const w = current.wealth;
      snaps.push({
        t: new Date().toISOString(),
        companies: w.companies, items: w.items, money: w.money,
        equipments: w.equipments, weapons: w.weapons, total: w.total,
      });
    }
    if (!snaps.length) return { labels: [], series: [], dataCount: 0 };
    const times = snaps.map(s => s.t).filter(Boolean).sort();
    const labels = allBuckets(times[0], times[times.length - 1], chart.bucket);

    // Breakdown is now multi-line (one line per category) rather than a
    // stacked area, so Companies no longer swamps the smaller categories.
    const series = (chart.metric === 'breakdown')
      ? COMPONENTS.map(c => ({
          key: c.key, label: c.label, color: c.color,
          values: bucketedValues(snaps, c.key, chart.bucket),
        }))
      : [{ key: 'total', label: 'Total', color: TOTAL_COLOR, values: bucketedValues(snaps, 'total', chart.bucket) }];

    const dataCount = series.reduce((m, s) => Math.max(m, s.values.size), 0);
    return { labels, series, dataCount };
  }

  // ── SVG chart ───────────────────────────────────────────────────
  const W = 900, H = 360, M = { top: 16, right: 16, bottom: 30, left: 52 };
  const PW = W - M.left - M.right, PH = H - M.top - M.bottom;

  function renderChart() {
    const { labels, series, dataCount } = buildSeries();
    const monitoredNow = monitored.some(e => e.userId === chart.user);

    if (dataCount === 0) {
      $chartBox.innerHTML = `<div class="wm-chart-empty">${monitoredNow
        ? 'Monitoring has started, but no snapshots have landed yet. A snapshot is taken every 2 hours, so the chart will start filling in over the next day or so — check back tomorrow.'
        : 'No history for this player. Start monitoring them below and the chart will build up over the following day or so.'}</div>`;
      $legend.innerHTML = '';
      return;
    }
    if (dataCount === 1) {
      $chartBox.innerHTML = `<div class="wm-chart-empty">Only one snapshot so far. Lines appear once there are at least two data points in this bucket.</div>`;
      $legend.innerHTML = '';
      return;
    }

    // Breakdown: a grid of per-category mini-charts, each on its OWN scale,
    // so a big category (Companies) can't flatten the small ones.
    if (chart.metric === 'breakdown') {
      $legend.innerHTML = '';
      renderSmallMultiples(labels, series);
      return;
    }

    // Total: one large single-series chart.
    renderLegend(series);
    const s = series[0];
    const n = labels.length;
    const x = i => M.left + (n === 1 ? PW / 2 : (i / (n - 1)) * PW);
    // Data-driven y-range (not pinned to zero) so small moves are visible.
    const { min: yMin, max: yMax, step } = yDomain(series);
    const y = v => M.top + PH - ((v - yMin) / (yMax - yMin || 1)) * PH;

    let svg = '';
    const ticks = Math.max(1, Math.round((yMax - yMin) / step));
    for (let i = 0; i <= ticks; i++) {
      const val = yMin + step * i, yy = y(val);
      svg += `<line class="wm-grid-line" x1="${M.left}" y1="${yy.toFixed(1)}" x2="${M.left + PW}" y2="${yy.toFixed(1)}"/>`;
      svg += `<text class="wm-axis-text" x="${M.left - 8}" y="${(yy + 3).toFixed(1)}" text-anchor="end">${fmtTick(val, step)}</text>`;
    }
    const xstep = Math.max(1, Math.ceil(n / 8));
    for (let i = 0; i < n; i += xstep) {
      svg += `<text class="wm-axis-text" x="${x(i).toFixed(1)}" y="${H - 10}" text-anchor="middle">${escapeHtml(shortLabel(labels[i]))}</text>`;
    }
    svg += linePath(s, labels, x, y, n);
    svg += `<line id="wm-hover-line" class="wm-hover-line" x1="0" y1="${M.top}" x2="0" y2="${M.top + PH}" style="display:none"/>`;
    $chartBox.innerHTML =
      `<svg class="wm-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">${svg}</svg>` +
      `<div class="wm-tooltip" id="wm-tooltip"></div>`;
    wireHover(labels, series, x, n);
  }

  // The <path> + dots for one series, gap-aware (missing buckets break it).
  function linePath(s, labels, x, y, n, dotR = 2.6) {
    let d = '', pen = false, dots = '';
    for (let i = 0; i < n; i++) {
      if (s.values.has(labels[i])) {
        const px = x(i).toFixed(1), py = y(s.values.get(labels[i])).toFixed(1);
        d += `${pen ? 'L' : 'M'}${px} ${py}`;
        pen = true;
        dots += `<circle class="wm-series-dot" cx="${px}" cy="${py}" r="${dotR}" fill="${s.color}"/>`;
      } else pen = false;
    }
    return `<path class="wm-series-line" d="${d}" stroke="${s.color}"/>${dots}`;
  }

  function renderLegend(series) {
    $legend.innerHTML = series.map(s =>
      `<span class="wm-legend-item"><span class="wm-dot" style="background:${s.color}"></span>${escapeHtml(s.label)}</span>`
    ).join('');
  }

  // Axis tick label with enough precision that adjacent ticks differ. fmtK at
  // 1dp collapses e.g. 12,015 and 11,990 both to "12.0K"; this picks decimals
  // from the tick step so the real range is legible.
  function fmtTick(v, step) {
    const a = Math.abs(v);
    if (a >= 1000 || (a === 0 && step >= 1000)) {
      const dp = Math.min(3, Math.max(0, Math.ceil(-Math.log10(step / 1000))));
      return (v / 1000).toFixed(dp) + 'K';
    }
    const dp = Math.min(2, Math.max(0, Math.ceil(-Math.log10(step || 1))));
    return v.toFixed(dp);
  }

  // ── Small multiples (breakdown) ─────────────────────────────────
  const MINI = { W: 320, H: 150, m: { top: 12, right: 12, bottom: 22, left: 48 } };

  function lastValue(values, labels) {
    for (let i = labels.length - 1; i >= 0; i--) if (values.has(labels[i])) return values.get(labels[i]);
    return null;
  }

  function renderSmallMultiples(labels, series) {
    $chartBox.innerHTML = `<div class="wm-mini-grid">${series.map((s, idx) => {
      const last = lastValue(s.values, labels);
      return `<div class="wm-mini">
        <div class="wm-mini-head">
          <span class="wm-dot" style="background:${s.color}"></span>${escapeHtml(s.label)}
          <span class="wm-mini-val" data-mini-val="${idx}">${last == null ? '–' : fmtK(last)}</span>
        </div>
        ${miniSvg(s, labels, idx)}
      </div>`;
    }).join('')}</div>`;
    series.forEach((s, idx) => wireMiniHover(idx, labels, s));
  }

  function miniSvg(s, labels, idx) {
    const { W, H, m } = MINI;
    const pw = W - m.left - m.right, ph = H - m.top - m.bottom;
    const n = labels.length;
    const x = i => m.left + (n === 1 ? pw / 2 : (i / (n - 1)) * pw);
    const dom = yDomain([s]);
    const y = v => m.top + ph - ((v - dom.min) / (dom.max - dom.min || 1)) * ph;

    let svg = '';
    for (const val of [dom.max, dom.min]) {            // just the bounds
      const yy = y(val);
      svg += `<line class="wm-grid-line" x1="${m.left}" y1="${yy.toFixed(1)}" x2="${m.left + pw}" y2="${yy.toFixed(1)}"/>`;
      svg += `<text class="wm-axis-text" x="${m.left - 6}" y="${(yy + 3).toFixed(1)}" text-anchor="end">${fmtTick(val, (dom.max - dom.min) || 1)}</text>`;
    }
    svg += `<text class="wm-axis-text" x="${x(0).toFixed(1)}" y="${H - 7}" text-anchor="start">${escapeHtml(shortLabel(labels[0]))}</text>`;
    svg += `<text class="wm-axis-text" x="${x(n - 1).toFixed(1)}" y="${H - 7}" text-anchor="end">${escapeHtml(shortLabel(labels[n - 1]))}</text>`;
    svg += linePath(s, labels, x, y, n, 2);
    svg += `<line id="wm-mhl-${idx}" class="wm-hover-line" x1="0" y1="${m.top}" x2="0" y2="${m.top + ph}" style="display:none"/>`;
    return `<svg class="wm-mini-chart" id="wm-msvg-${idx}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">${svg}</svg>`;
  }

  function wireMiniHover(idx, labels, s) {
    const svg = document.getElementById(`wm-msvg-${idx}`);
    const hl = document.getElementById(`wm-mhl-${idx}`);
    const valEl = $chartBox.querySelector(`[data-mini-val="${idx}"]`);
    if (!svg || !hl || !valEl) return;
    const { W, m } = MINI;
    const pw = W - m.left - m.right, n = labels.length;
    const x = i => m.left + (n === 1 ? pw / 2 : (i / (n - 1)) * pw);
    const last = lastValue(s.values, labels);
    const resetText = last == null ? '–' : fmtK(last);

    svg.addEventListener('mousemove', e => {
      const r = svg.getBoundingClientRect();
      const sx = (e.clientX - r.left) / r.width * W;
      let best = 0, bd = Infinity;
      for (let i = 0; i < n; i++) { const d = Math.abs(x(i) - sx); if (d < bd) { bd = d; best = i; } }
      const lab = labels[best];
      hl.setAttribute('x1', x(best)); hl.setAttribute('x2', x(best)); hl.style.display = '';
      valEl.textContent = (s.values.has(lab) ? fmtK(s.values.get(lab)) : '–') + ' · ' + shortLabel(lab);
    });
    svg.addEventListener('mouseleave', () => { hl.style.display = 'none'; valEl.textContent = resetText; });
  }

  function niceNum(range, round) {
    if (range <= 0 || !isFinite(range)) return 1;
    const exp = Math.floor(Math.log10(range));
    const f = range / Math.pow(10, exp);
    const nf = round
      ? (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10)
      : (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10);
    return nf * Math.pow(10, exp);
  }

  // Bracket the visible data with ~8% padding and round to nice ticks. The
  // floor is clamped at 0 (wealth can't be negative) but is otherwise NOT
  // pinned to zero, which is what makes small movements legible.
  function yDomain(visible) {
    let min = Infinity, max = -Infinity;
    for (const s of visible) for (const v of s.values.values()) { if (v < min) min = v; if (v > max) max = v; }
    if (!isFinite(min)) return { min: 0, max: 1, step: 1 };
    if (max === min) { const p = Math.abs(max) * 0.1 || 1; min -= p; max += p; }
    else { const p = (max - min) * 0.08; min -= p; max += p; }
    min = Math.max(0, min);
    const step = niceNum((max - min) / 4, true);
    const niceMin = Math.floor(min / step) * step;
    let niceMax = Math.ceil(max / step) * step;
    if (niceMax <= niceMin) niceMax = niceMin + step;
    return { min: niceMin, max: niceMax, step };
  }

  function shortLabel(label) {
    const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    if (/^\d{4}-\d{2}-\d{2}$/.test(label)) { const [, m, d] = label.split('-'); return `${+d} ${mon[+m - 1]}`; }
    if (/^\d{4}-\d{2}$/.test(label)) { const [yr, m] = label.split('-'); return `${mon[+m - 1]} ${yr.slice(2)}`; }
    return label;
  }

  function wireHover(labels, series, x, n) {
    const svg = $chartBox.querySelector('svg');
    const $tt = document.getElementById('wm-tooltip');
    const $hl = document.getElementById('wm-hover-line');
    if (!svg || !$tt || !$hl) return;

    function locate(clientX) {
      const r = svg.getBoundingClientRect();
      const sx = (clientX - r.left) / r.width * W;
      let best = 0, bestD = Infinity;
      for (let i = 0; i < n; i++) { const d = Math.abs(x(i) - sx); if (d < bestD) { bestD = d; best = i; } }
      return best;
    }
    function show(clientX) {
      const i = locate(clientX), lab = labels[i];
      $hl.setAttribute('x1', x(i)); $hl.setAttribute('x2', x(i)); $hl.style.display = '';
      let rows = '';
      for (const s of series) {
        if (!s.values.has(lab)) continue;
        const v = s.values.get(lab);
        rows += `<div class="wm-tt-row"><span class="wm-dot" style="background:${s.color}"></span>${escapeHtml(s.label)}<span class="wm-tt-val">${fmtK(v)}</span></div>`;
      }
      if (!rows) { $tt.innerHTML = `<div class="wm-tt-date">${escapeHtml(shortLabel(lab))} · no data</div>`; positionTip(i); return; }
      $tt.innerHTML = `<div class="wm-tt-date">${escapeHtml(shortLabel(lab))}</div>${rows}`;
      positionTip(i);
    }
    function positionTip(i) {
      const r = svg.getBoundingClientRect();
      const px = x(i) / W * r.width;
      const left = Math.min(Math.max(px + 12, 4), r.width - $tt.offsetWidth - 4);
      $tt.style.left = `${left}px`; $tt.style.top = `8px`; $tt.style.opacity = 1;
    }
    svg.addEventListener('mousemove', e => show(e.clientX));
    svg.addEventListener('touchmove', e => { if (e.touches[0]) show(e.touches[0].clientX); }, { passive: true });
    svg.addEventListener('mouseleave', () => { $tt.style.opacity = 0; $hl.style.display = 'none'; });
  }

  // ── Control wiring ──────────────────────────────────────────────
  $submit.addEventListener('click', handleSubmit);
  $username.addEventListener('keydown', e => { if (e.key === 'Enter') handleSubmit(); });
  $recent.addEventListener('click', e => {
    const del = e.target.closest('[data-wm-recent-del]');
    if (del) { forgetUsername(del.dataset.wmRecentDel); return; }
    const pick = e.target.closest('[data-wm-recent]');
    if (pick) { $username.value = pick.dataset.wmRecent; handleSubmit(); }
  });
  $metricSeg.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    chart.metric = b.dataset.metric;
    $metricSeg.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
    renderChart();
  });
  $bucketSeg.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    chart.bucket = b.dataset.bucket;
    $bucketSeg.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
    renderChart();
  });

  async function loadData() {
    const [mon, hist] = await Promise.all([
      fetchJson(MONITORED_URL).catch(() => null),
      fetchJson(HISTORY_URL).catch(() => null),
    ]);
    monitored = (mon?.entries || []).filter(e => e && e.userId && e.username);
    history = (hist && hist.users) ? hist : { users: {} };
    setCount();
  }

  async function refreshMonitored() {
    const data = await fetchJson(MONITORED_URL).catch(() => null);
    monitored = (data?.entries || []).filter(e => e && e.userId && e.username);
    setCount();
    if (current && !$monitorCard.classList.contains('hidden')) { renderMonitorCard(); updateChartVisibility(); }
  }

  return {
    /**
     * Router/shell entry. Driven by the shared username in the home shell
     * (activate({u})); standalone (#wealth?u=…) it reads its own params.
     * Idempotent: re-runs the lookup only when the username changes.
     * @param {URLSearchParams} [params]
     */
    async activate(params) {
      renderRecent();
      if (!dataLoaded) { dataLoaded = true; await loadData(); }

      const u = (params && params.get && params.get('u'))
             || new URLSearchParams(location.search).get('u');
      if (u && $username.value.toLowerCase() !== u.toLowerCase()) { $username.value = u; handleSubmit(); }
      else if (!u && !$username.value) $username.focus();
    },
  };
})();
