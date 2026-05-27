/* ═══════════════════════════════════════════════════════════════════
 *  EMPLOYEE CLOCK-IN MONITOR
 *
 *  Pulls each of an employer's workers and reads their recent wage
 *  transactions to build a 48h timeline of clock-ins.
 *
 *  Data model: wage transactions are TRADES.
 *    {
 *      _id, createdAt, transactionType: 'wage',
 *      sellerId,  // the WORKER (sold their labour)
 *      buyerId,   // the EMPLOYER (bought the labour)
 *      quantity,  // labour quantity
 *      money,     // wage paid
 *    }
 *
 *  Querying transaction.getPaginatedTransactions with userId=W returns
 *  wages where W is on either side. A clock-in for W = sellerId === W;
 *  the buy-side entries are W's own payroll if W also employs people
 *  (mutual employment is allowed) and get filtered out.
 *
 *  Payroll projection: alongside the timeline, the top of the view
 *  shows projected payroll over 3h / 6h / 10h. Per-worker formula:
 *    actions(h) = floor((currentEnergy + h × hourlyRegen) / 10)
 *    payroll(h) = Σ actions × production × (1 + fidelity/100) × wage
 *  All inputs come from calls already made — no new endpoints.
 *
 *  Access: restricted to Irish citizens (enforceIrishOnly from
 *  shared.js). The bypass=1 URL param lifts the restriction.
 * ═══════════════════════════════════════════════════════════════════ */
const ClockInTool = (() => {
  /* ── Config ─────────────────────────────────────────────── */
  const WINDOW_HOURS          = 48;
  const WINDOW_MS             = WINDOW_HOURS * 3600 * 1000;
  const ACTIVE_THRESHOLD_MS   = 24 * 3600 * 1000;
  const TX_PAGE_LIMIT         = 100;
  const MAX_TX_PAGES          = 6;          // safety cap per worker
  const GROUP_WINDOW_MS       = 4 * 60_000; // cycles within 4 min → one episode
  const INITIAL_EPISODE_LIMIT = 5;

  // Payroll projection. Simple model:
  //  • 3h and 6h windows: take the worker's actual ₿ paid over the
  //    last 24h, divide by 24 to get an hourly rate, multiply by the
  //    window. Sums across all workers.
  //  • 10h window: theoretical ceiling — every worker burns through
  //    their full energy bar in 10h (one full refill from empty,
  //    since regen is 10% of max per hour).
  const ACTION_ENERGY_COST = 10;
  const PROJECTION_WINDOWS = [
    { hours: 3,  mode: 'pace' },
    { hours: 6,  mode: 'pace' },
    { hours: 10, mode: 'max'  },
  ];

  /* ── DOM ────────────────────────────────────────────────── */
  const $username    = document.getElementById('clockin-username');
  const $run         = document.getElementById('clockin-go');
  const $hint        = document.getElementById('clockin-hint');
  const $summary     = document.getElementById('clockin-summary');
  const $sumWorkers  = document.getElementById('clockin-sum-workers');
  const $projection  = document.getElementById('clockin-projection');
  const $workers     = document.getElementById('clockin-workers');
  const $filterIdle  = document.getElementById('clockin-filter-idle');
  const $sortRecent  = document.getElementById('clockin-sort-recent');
  const $sortIdle    = document.getElementById('clockin-sort-idle');
  const steps        = makeSteps(document.getElementById('clockin-steps'));
  const setStatus    = makeStatus(document.getElementById('clockin-status'));

  /* ── State ──────────────────────────────────────────────── */
  let state = null; // { ownerUsername, workers: [...], generatedAt }
  let running = false;

  const ci_trpc = (endpoint, input) => trpc(endpoint, input, { retry: true, timeoutMs: 20000 });

  /* ── Formatting helpers (tool-specific) ─────────────────── */
  function fmtAgo(ms) {
    if (ms == null || !isFinite(ms)) return null;
    if (ms < 60_000) return 'just now';
    if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
    if (ms < 86_400_000) {
      const h = Math.floor(ms / 3_600_000);
      const m = Math.floor((ms % 3_600_000) / 60_000);
      return m > 0 ? `${h}h ${m}m ago` : `${h}h ago`;
    }
    const d = Math.floor(ms / 86_400_000);
    return `${d}d ago`;
  }
  function fmtTime(d) {
    if (!d) return '';
    return d.toLocaleString(undefined, {
      weekday: 'short', hour: '2-digit', minute: '2-digit',
    });
  }
  function fmtGap(ms) {
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
    if (ms < 86_400_000) {
      const h = Math.floor(ms / 3_600_000);
      const m = Math.round((ms % 3_600_000) / 60_000);
      return m > 0 ? `${h}h ${m}m` : `${h}h`;
    }
    const d = Math.floor(ms / 86_400_000);
    const h = Math.round((ms % 86_400_000) / 3_600_000);
    return h > 0 ? `${d}d ${h}h` : `${d}d`;
  }
  const userUrl    = id => `${GAME_BASE}/user/${id}`;
  const companyUrl = id => `${GAME_BASE}/company/${id}`;

  // Small integer formatter for the skill chips. Production can be
  // fractional (e.g. 22.5) so we keep at most one decimal and strip
  // trailing zeros.
  function fmtSkill(n) {
    if (n == null || !isFinite(n)) return '–';
    if (n >= 100) return Math.round(n).toString();
    const rounded = Math.round(n * 10) / 10;
    return Number.isInteger(rounded) ? rounded.toString() : rounded.toFixed(1);
  }

  /* ── Username resolution ─────────────────────────────────
   *  Same exact-match pattern as the advisor. We can't share its
   *  helper because the advisor's version uses its own setStep panel
   *  and has its own endpoint-discovery; this is the simpler form.
   *  Returns the resolved user's `country` alongside id/username so
   *  the Irish-only gate has it without an extra call.
   *
   *  Error wording is careful to distinguish three failure modes:
   *    1. Search returned no IDs → could be "user really doesn't
   *       exist" OR "API blip returning empty". We hedge with
   *       "couldn't find — does the username exist?" rather than
   *       flatly claiming non-existence, since the API is known to
   *       blip and "user does not exist" sends people on goose-
   *       chases when the real issue is upstream.
   *    2. Search returned IDs but every getUserLite failed → the
   *       upstream user endpoint is down. Surface this explicitly
   *       instead of silently falling back to an unverified id.
   *    3. Search returned profiles but none matched the typed name
   *       → show what we got back, like before.
   */
  async function resolveUserId(username) {
    const search = await ci_trpc('search.searchAnything', { searchText: username });
    const candidateIds = search?.userIds || [];
    if (!candidateIds.length) {
      throw new Error(
        `Couldn't find a user called "${username}". ` +
        `Double-check the spelling, or try again in a moment — the search API sometimes returns nothing on a hiccup.`
      );
    }
    steps.setStep(1, 'active', {
      sub: `Verifying among ${candidateIds.length} match${candidateIds.length === 1 ? '' : 'es'}`,
      count: `0/${Math.min(candidateIds.length, 10)}`,
    });

    const top = candidateIds.slice(0, 10);
    let checked = 0;
    const profiles = await Promise.all(top.map(async id => {
      try {
        const u = await ci_trpc('user.getUserLite', { userId: id });
        checked++;
        steps.setStep(1, 'active', { count: `${checked}/${top.length}` });
        return u;
      } catch {
        checked++;
        steps.setStep(1, 'active', { count: `${checked}/${top.length}` });
        return null;
      }
    }));
    const known = profiles.filter(Boolean);
    const normalise = s => (s || '').toLowerCase().trim();
    const target = normalise(username);
    const exact = known.find(u => normalise(u.username) === target);
    if (exact) return { userId: exact._id, username: exact.username, country: exact.country, exact: true };

    // Search succeeded but every profile lookup failed — almost
    // certainly the user endpoint is having a moment. Don't fall
    // back to an unverified candidate (we used to, and it caused
    // misleading "wrong user" results during outages).
    if (!known.length) {
      throw new Error(
        `Found possible matches for "${username}" but couldn't load any of their profiles. ` +
        `The data server may be having issues — wait a few seconds and try again.`
      );
    }
    const found = known.map(u => u.username).filter(Boolean);
    throw new Error(
      `No exact match for "${username}". Search returned: ` +
      `${found.slice(0, 5).join(', ')}${found.length > 5 ? '…' : ''}`
    );
  }

  /* ── Wage transaction loader ────────────────────────────── */
  async function loadWagesForWorker(workerId, employerId) {
    const cutoff = Date.now() - WINDOW_MS;
    const punches = [];
    let cursor = null;
    let pages = 0;
    let seenOlder = false;
    let filteredOut = 0;

    while (pages < MAX_TX_PAGES && !seenOlder) {
      const input = {
        userId: workerId,
        transactionType: 'wage',
        limit: TX_PAGE_LIMIT,
      };
      if (cursor) input.cursor = cursor;

      let page;
      try {
        page = await ci_trpc('transaction.getPaginatedTransactions', input);
      } catch (e) {
        console.warn(`[clockin] worker ${workerId} page ${pages} failed:`, e.message);
        break;
      }
      pages++;

      const items = page?.items || [];
      if (!items.length) break;

      for (const tx of items) {
        const t = new Date(tx.createdAt).getTime();
        if (!isFinite(t)) continue;
        if (t < cutoff) { seenOlder = true; break; }

        // Two filters here, both required:
        //   1. Worker must be the seller (they did the work). Filters
        //      out the worker's own outgoing payroll if they employ
        //      people too.
        //   2. Employer must be the buyer (you paid for the work). If
        //      a worker holds multiple contracts (which the game now
        //      allows in practice — e.g. M0JTA8A working for several
        //      employers), this keeps only the wages YOU paid them.
        //      Without this, the projection inflates with other
        //      employers' payroll.
        if (tx.sellerId !== workerId) { filteredOut++; continue; }
        if (employerId && tx.buyerId !== employerId) { filteredOut++; continue; }

        punches.push({
          at: t,
          amount: tx.money,
          quantity: tx.quantity,
          buyerId: tx.buyerId,
        });
      }

      cursor = page?.nextCursor ?? null;
      if (!cursor) break;
    }

    if (filteredOut > 0) {
      console.log(`[clockin] ${workerId}: filtered ${filteredOut} non-matching wages`);
    }
    punches.sort((a, b) => b.at - a.at);
    return punches;
  }

  /* ── Main pipeline ──────────────────────────────────────── */
  async function analyse(username) {
    steps.setStep(1, 'active', { sub: `Searching for "${username}"` });
    const resolved = await resolveUserId(username);
    steps.setStep(1, 'done', {
      count: resolved.exact ? `→ ${resolved.username}` : `→ ${resolved.username} (unverified)`,
    });

    // Irish-citizens-only gate. The bypass=1 URL param lifts this
    // for admin/debugging. Non-Irish users get a hard block here,
    // before any of the expensive worker/transaction loading runs.
    enforceIrishOnly(resolved.country, resolved.username);

    steps.setStep(2, 'active', { sub: 'Fetching companies and worker roster' });
    const [companyList, workersData] = await Promise.all([
      ci_trpc('company.getCompanies', { userId: resolved.userId, perPage: 100 }),
      ci_trpc('worker.getWorkers',    { userId: resolved.userId }),
    ]);

    const companyIds = (companyList?.items || [])
      .map(c => typeof c === 'string' ? c : c?._id).filter(Boolean);
    if (!companyIds.length) {
      throw new Error(`"${resolved.username}" owns no companies`);
    }

    // Worker map: userId -> { id, name, wage, fidelity, ... }
    // wage/fidelity come straight off the worker.getWorkers response;
    // they're needed for the payroll projection. A worker only holds
    // one contract, so the first values we see are authoritative.
    //
    // We also stash the COMPANY they work for, captured from the
    // `entry.company` object that workersPerCompany hands us. This is
    // already in memory — no extra API call — and lets the card show
    // "@ Cement Plant" without resolving anything else. `entry.company`
    // can be either an object or a bare id depending on the endpoint
    // response shape, so we handle both.
    const workerMap = new Map();
    for (const entry of (workersData?.workersPerCompany || [])) {
      const companyObj = (entry && typeof entry.company === 'object') ? entry.company : null;
      const companyId  = companyObj?._id || (typeof entry?.company === 'string' ? entry.company : null);
      const company    = companyId ? {
        id:       companyId,
        name:     companyObj?.name || null,
        itemCode: companyObj?.itemCode || null,
      } : null;

      for (const w of (entry.workers || [])) {
        const uid = typeof w === 'string' ? w : (w.user || w._id || w.userId);
        if (!uid) continue;
        if (!workerMap.has(uid)) {
          const wage     = (w && typeof w === 'object' && typeof w.wage === 'number')     ? w.wage     : null;
          const fidelity = (w && typeof w === 'object' && typeof w.fidelity === 'number') ? w.fidelity : 0;
          workerMap.set(uid, { id: uid, name: null, wage, fidelity, company });
        }
      }
    }

    if (workerMap.size === 0) {
      steps.setStep(2, 'done', { count: `${companyIds.length} companies · 0 workers` });
      steps.setStep(3, 'done', { sub: 'No workers to resolve' });
      steps.setStep(4, 'done', { sub: 'No transactions to pull' });
      state = { ownerUsername: resolved.username, workers: [], generatedAt: Date.now() };
      render();
      steps.fadeOut(400);
      return;
    }

    steps.setStep(2, 'done', { count: `${companyIds.length} companies · ${workerMap.size} workers` });

    // Step 3: resolve worker usernames + capture stats for projection
    const workerIds = [...workerMap.keys()];
    steps.setStep(3, 'active', { sub: 'Resolving worker profiles', count: `0/${workerIds.length}` });
    const concurrency = 10;
    let done = 0;
    for (let i = 0; i < workerIds.length; i += concurrency) {
      const batch = workerIds.slice(i, i + concurrency);
      await Promise.all(batch.map(async uid => {
        try {
          const u = await ci_trpc('user.getUserLite', { userId: uid });
          const w = workerMap.get(uid);
          if (u?.username) w.name = u.username;
          // Stats needed for payroll projection + the on-card skill
          // chips. All live under skills.{stat}.value:
          //   energy.value     → max energy (used for full-bar action count)
          //   production.value → PP generated per work action
          //   strength.value   → optional, shown if present
          //   damage.value     → optional, shown if present
          if (u?.skills) {
            w.energyMax  = u.skills.energy?.value     ?? null;
            w.production = u.skills.production?.value ?? null;
            w.strength   = u.skills.strength?.value   ?? null;
            w.damage     = u.skills.damage?.value     ?? null;
          }
        } catch { /* skip — projection will mark this worker as unknown */ }
        done++;
        steps.setStep(3, 'active', { count: `${done}/${workerIds.length}` });
      }));
    }
    steps.setStep(3, 'done', { count: `${workerIds.length} resolved` });

    // Step 4: pull wage transactions
    steps.setStep(4, 'active', { sub: 'Pulling wage transactions', count: `0/${workerIds.length}` });
    let txDone = 0;
    const txConcurrency = 5;
    for (let i = 0; i < workerIds.length; i += txConcurrency) {
      const batch = workerIds.slice(i, i + txConcurrency);
      await Promise.all(batch.map(async uid => {
        workerMap.get(uid).punches = await loadWagesForWorker(uid, resolved.userId);
        txDone++;
        steps.setStep(4, 'active', { count: `${txDone}/${workerIds.length}` });
      }));
    }
    steps.setStep(4, 'done', { count: `${workerIds.length} done` });

    state = {
      ownerUsername: resolved.username,
      workers: [...workerMap.values()],
      generatedAt: Date.now(),
    };
    render();
    steps.fadeOut(800);
  }

  /* ── Payroll projection ─────────────────────────────────── */

  /** Max actions a worker can perform when their bar is FULL.
   *  Used for the 10h "if maxed" ceiling, which models "if everyone
   *  was idle for 10h so their bars filled completely, then burned
   *  through everything". No regen factor — the bar is capped at max,
   *  so being idle longer than 10h doesn't add anything.
   *  Returns 0 if stats are missing. */
  function maxActionsFromFullBar(w) {
    if (w.energyMax == null) return 0;
    return Math.floor(w.energyMax / ACTION_ENERGY_COST);
  }

  /** Theoretical max payroll if every worker started at full energy
   *  and drained their bar to zero. */
  function projectMaxPayroll(workers) {
    let total = 0;
    let contributors = 0;
    let unknown = 0;
    for (const w of workers) {
      if (w.wage == null || w.production == null || w.energyMax == null) {
        unknown++;
        continue;
      }
      const actions = maxActionsFromFullBar(w);
      if (actions === 0) continue;
      const fidelityMult = 1 + ((w.fidelity || 0) / 100);
      total += actions * w.production * fidelityMult * w.wage;
      contributors++;
    }
    return { total, contributors, unknown };
  }

  /** Total ₿ paid across all workers in the last N hours.
   *  Sums wage transactions we already pulled — no extra API calls. */
  function actualPayrollInLastHours(workers, hours, now) {
    const cutoff = now - (hours * 3_600_000);
    let total = 0;
    for (const w of workers) {
      for (const p of (w.punches || [])) {
        if (p.at >= cutoff) total += (p.amount || 0);
      }
    }
    return total;
  }

  /** Pace-based projection: ₿ paid in last 24h / 24 × window hours.
   *  Treats the whole roster as one bucket — simple and stable. */
  function projectPacePayroll(workers, hours, now) {
    const last24h = actualPayrollInLastHours(workers, 24, now);
    return last24h / 24 * hours;
  }

  function renderProjection(workers, now) {
    if (!$projection) return;
    if (!workers.length) {
      $projection.style.display = 'none';
      return;
    }
    $projection.style.display = '';

    const cards = PROJECTION_WINDOWS.map(({ hours, mode }) => {
      const actualSameWindow = actualPayrollInLastHours(workers, hours, now);
      const actualLine = `<div class="clockin-proj-actual">Last ${hours}h: ₿${actualSameWindow.toLocaleString(undefined, {maximumFractionDigits: 2})} actual</div>`;

      if (mode === 'max') {
        const { total } = projectMaxPayroll(workers);
        return `
          <div class="clockin-proj-card max">
            <div class="clockin-proj-label">Next ${hours}h <span class="max-tag">if maxed</span></div>
            <div class="clockin-proj-value">₿${total.toLocaleString(undefined, {maximumFractionDigits: 2})}</div>
            ${actualLine}
          </div>
        `;
      }
      const projected = projectPacePayroll(workers, hours, now);
      return `
        <div class="clockin-proj-card">
          <div class="clockin-proj-label">Next ${hours}h</div>
          <div class="clockin-proj-value">₿${projected.toLocaleString(undefined, {maximumFractionDigits: 2})}</div>
          ${actualLine}
        </div>
      `;
    }).join('');

    $projection.innerHTML = `
      <div class="clockin-proj-head">
        <div class="clockin-proj-title">Projected payroll</div>
        <div class="clockin-proj-hint">
          What you're likely to pay over the next few hours, based on how your workers have been clocking in recently. The <strong>10h if maxed</strong> figure is the absolute worst case — if every worker burns through their full energy bar.
        </div>
      </div>
      <div class="clockin-proj-grid">${cards}</div>
    `;
  }

  /* ── Rendering ──────────────────────────────────────────── */
  function statusClass(lastMs) {
    if (lastMs == null) return 'never';
    if (lastMs < ACTIVE_THRESHOLD_MS) return '';
    if (lastMs < WINDOW_MS) return 'warn';
    return 'danger';
  }
  function statusLabel(lastMs) {
    if (lastMs == null) return 'Never (48h window)';
    if (lastMs < ACTIVE_THRESHOLD_MS) return 'Active';
    if (lastMs < WINDOW_MS) return 'Slowing';
    return 'Idle';
  }

  function groupIntoEpisodes(punches, cutoff) {
    const visible = punches.filter(p => p.at >= cutoff);
    const grouped = [];
    for (const p of visible) {
      const last = grouped[grouped.length - 1];
      if (last && Math.abs(last.at - p.at) <= GROUP_WINDOW_MS) {
        last.count += 1;
        last.totalAmount += (p.amount || 0);
        last.totalQty    += (p.quantity || 0);
        if (p.at < last.startAt) last.startAt = p.at;
      } else {
        grouped.push({
          at: p.at, startAt: p.at,
          count: 1,
          totalAmount: p.amount || 0,
          totalQty: p.quantity || 0,
        });
      }
    }
    return grouped;
  }

  function renderTimeline(episodes, now) {
    const cutoff = now - WINDOW_MS;
    const ticks = episodes.map(g => {
      const pct = ((g.at - cutoff) / WINDOW_MS) * 100;
      const d = new Date(g.at);
      const qStr      = g.totalQty > 0    ? ` · ${g.totalQty} production points` : '';
      const amountStr = g.totalAmount > 0 ? ` · ₿${g.totalAmount.toLocaleString(undefined, {maximumFractionDigits: 4})}` : '';
      const title = `${fmtTime(d)}${qStr}${amountStr}`;
      return `<div class="clockin-punch" style="left: ${pct.toFixed(2)}%" title="${escapeHtml(title)}"></div>`;
    }).join('');

    const axisTicks = [];
    for (let h = WINDOW_HOURS; h >= 0; h -= 12) {
      const pct = ((WINDOW_HOURS - h) / WINDOW_HOURS) * 100;
      const label = h === 0 ? 'now' : `-${h}h`;
      axisTicks.push(`<div class="clockin-axis-tick" style="left:${pct}%">${label}</div>`);
    }
    return `
      <div class="clockin-timeline-track">
        ${ticks}
        <div class="clockin-timeline-now" style="right: 0"></div>
      </div>
      <div class="clockin-timeline-axis">${axisTicks.join('')}</div>
    `;
  }

  function renderEpisodeList(episodes, now) {
    if (!episodes.length) return '';
    const rows = episodes.map((ep, i) => {
      const d = new Date(ep.at);
      const ago = fmtAgo(now - ep.at);
      const older = episodes[i + 1];
      let gapHtml = '';
      if (older) {
        const gapMs = ep.at - older.at;
        const longGap = gapMs > 60 * 60_000;
        gapHtml = `<div class="clockin-ep-gap ${longGap ? 'long' : ''}" title="Time between previous clock-in and this one">↓ ${fmtGap(gapMs)} rest before</div>`;
      }
      const meta = ep.totalQty > 0 ? `${ep.totalQty} production points` : '';
      return `
        <div class="clockin-ep">
          <div class="clockin-ep-time">${fmtTime(d)}</div>
          <div class="clockin-ep-ago">${escapeHtml(ago)}</div>
          <div class="clockin-ep-amount">₿${ep.totalAmount.toLocaleString(undefined, {maximumFractionDigits: 4})}</div>
          <div class="clockin-ep-meta">${escapeHtml(meta)}</div>
          ${gapHtml}
        </div>
      `;
    });

    const overflow = episodes.length > INITIAL_EPISODE_LIMIT;
    const visible  = rows.slice(0, INITIAL_EPISODE_LIMIT).join('');
    const hidden   = overflow ? `<div class="clockin-ep-hidden" style="display:none">${rows.slice(INITIAL_EPISODE_LIMIT).join('')}</div>` : '';
    const moreBtn  = overflow
      ? `<button class="clockin-show-more" onclick="(function(b){var h=b.previousElementSibling;h.style.display='flex';h.style.flexDirection='column';b.remove();})(this)">Show ${episodes.length - INITIAL_EPISODE_LIMIT} older episode${episodes.length - INITIAL_EPISODE_LIMIT === 1 ? '' : 's'}</button>`
      : '';

    return `<div class="clockin-ep-list">${visible}${hidden}${moreBtn}</div>`;
  }

  function renderWorkerTimelineSection(punches, now) {
    const cutoff = now - WINDOW_MS;
    const episodes = groupIntoEpisodes(punches, cutoff);
    if (episodes.length === 0) {
      return `
        <div class="clockin-worker-timeline">
          ${renderTimeline([], now)}
          <div class="clockin-no-punches">No clock-ins recorded in the last ${WINDOW_HOURS} hours.</div>
        </div>
      `;
    }
    const summaryLabel = episodes.length === 1
      ? 'Show detail for 1 episode'
      : `Show detail for ${episodes.length} episodes`;
    return `
      <div class="clockin-worker-timeline">
        ${renderTimeline(episodes, now)}
        <details class="clockin-ep-detail">
          <summary>${summaryLabel}</summary>
          ${renderEpisodeList(episodes, now)}
        </details>
      </div>
    `;
  }

  /** Inline SVG for skill chips. 11×11 — small enough to fit inside
   *  the existing .clockin-item rows next to the meta text without
   *  visually competing with the "Last clock-in" / status pills. */
  function skillIconSvg(kind) {
    switch (kind) {
      case 'production':
        // Pickaxe — matches the in-game production icon.
        return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4l6 6"/><path d="M3 21l11-11"/><path d="M9 3a9 9 0 0 1 12 12"/></svg>`;
      case 'energy':
        // Lightning bolt — matches the in-game energy icon.
        return `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/></svg>`;
      case 'strength':
        return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8v8"/><path d="M18 8v8"/><path d="M3 10v4"/><path d="M21 10v4"/><path d="M6 12h12"/></svg>`;
      case 'damage':
        return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 3v4"/><path d="M12 17v4"/><path d="M3 12h4"/><path d="M17 12h4"/></svg>`;
      default:
        return '';
    }
  }

  /** Skill items reuse the existing .clockin-item layout — same gap,
   *  same font size, same colours — just with a tiny SVG instead of a
   *  text label. Missing or zero values are silently omitted. */
  function renderSkillItems(w) {
    const skills = [];
    if (w.production != null) skills.push({ kind: 'production', label: 'Production',  value: fmtSkill(w.production) });
    if (w.energyMax  != null) skills.push({ kind: 'energy',     label: 'Max energy',  value: fmtSkill(w.energyMax)  });
    if (w.strength != null && w.strength > 0) skills.push({ kind: 'strength', label: 'Strength', value: fmtSkill(w.strength) });
    if (w.damage   != null && w.damage   > 0) skills.push({ kind: 'damage',   label: 'Damage',   value: fmtSkill(w.damage)   });
    if (!skills.length) return '';
    return skills.map(s => `
      <span class="clockin-item clockin-skill" title="${escapeHtml(s.label)}: ${escapeHtml(s.value)}">
        <span class="clockin-skill-icon" data-skill="${s.kind}">${skillIconSvg(s.kind)}</span>
        <strong>${escapeHtml(s.value)}</strong>
      </span>
    `).join('');
  }

  /** Company chip — sits alongside the worker name. Uses the global
   *  .icon-box class (defined for the advisor) and the shared ITEMS
   *  table + iconHtml helper so the item icon styling stays identical
   *  to the advisor cards. If we somehow don't have an itemCode, the
   *  chip just shows the company name without an icon. */
  function renderWorkerCompany(w) {
    const c = w.company;
    if (!c || !c.id) return '';
    const itemIcon = (typeof iconHtml === 'function' && c.itemCode)
      ? iconHtml(c.itemCode)
      : '';
    const nameHtml = c.name
      ? escapeHtml(c.name)
      : `Company ${escapeHtml(c.id).slice(-6)}`;
    return `
      <a class="clockin-company" href="${companyUrl(c.id)}" target="_blank" rel="noopener" title="Open ${escapeHtml(c.name || 'company')} in War Era">
        ${itemIcon}
        <span class="clockin-company-name">${nameHtml}</span>
      </a>
    `;
  }

  function render() {
    if (!state) return;
    const now = Date.now();
    const workers = state.workers.slice();

    workers.forEach(w => {
      const last = (w.punches || [])[0];
      w._lastMs = last ? (now - last.at) : null;
    });

    let shown = workers;
    if ($filterIdle.checked) {
      shown = shown.filter(w => w._lastMs == null || w._lastMs >= ACTIVE_THRESHOLD_MS);
    }
    if ($sortIdle.checked) {
      shown.sort((a, b) => (b._lastMs ?? Infinity) - (a._lastMs ?? Infinity));
    } else {
      shown.sort((a, b) => (a._lastMs ?? Infinity) - (b._lastMs ?? Infinity));
    }

    // Composite "Workers N (X active · Y idle)" — omit zero parts.
    const activeCount = workers.filter(w => w._lastMs != null && w._lastMs < ACTIVE_THRESHOLD_MS).length;
    const idleCount   = workers.filter(w => w._lastMs == null || w._lastMs >= WINDOW_MS).length;
    const subParts = [];
    if (activeCount > 0) subParts.push(`<span class="pos">${activeCount} active</span>`);
    if (idleCount > 0)   subParts.push(`<span class="neg">${idleCount} idle</span>`);
    const sub = subParts.length
      ? `<span class="sub">(${subParts.join('<span class="sep">·</span>')})</span>`
      : '';
    $sumWorkers.innerHTML = `${workers.length}${sub}`;
    $summary.style.display = '';
    $hint.classList.add('hidden');

    // Projection panel (uses unfiltered workers — the projection is
    // about your whole roster, not just the currently-shown subset).
    renderProjection(workers, now);

    if (!shown.length) {
      $workers.innerHTML = `<div class="status">No workers match the current filter.</div>`;
      return;
    }
    $workers.innerHTML = shown.map(w => {
      const cls = statusClass(w._lastMs);
      const label = statusLabel(w._lastMs);
      const ago = w._lastMs == null ? 'never' : fmtAgo(w._lastMs);
      const nameLink = w.name
        ? `<a href="${userUrl(w.id)}" target="_blank" rel="noopener">${escapeHtml(w.name)}</a>`
        : `<span style="color:var(--muted)">user ${escapeHtml(w.id).slice(-6)}</span>`;
      const externalIcon = `<a class="clockin-link-icon" href="${userUrl(w.id)}" target="_blank" rel="noopener" title="Open profile in War Era"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg></a>`;

      const companyHtml = renderWorkerCompany(w);
      const skillItems  = renderSkillItems(w);
      return `
        <div class="clockin-worker-card">
          <div class="clockin-worker-head">
            <div class="clockin-worker-name">${nameLink}${externalIcon}</div>
            ${companyHtml}
            <div class="clockin-worker-meta">
              ${skillItems}
              <span class="clockin-item"><span class="clockin-ago ${cls}">${escapeHtml(label)}</span></span>
              <span class="clockin-item">Last clock-in: <strong>${escapeHtml(ago)}</strong></span>
            </div>
          </div>
          ${renderWorkerTimelineSection(w.punches || [], now)}
        </div>
      `;
    }).join('');
  }

  /* ── Wire-up ────────────────────────────────────────────── */
  async function run() {
    if (running) return;
    const u = $username.value.trim();
    if (!u) { $username.focus(); return; }

    // Update the hash so this view is shareable. Preserve any extra
    // params (like bypass=1) the user came in with so they survive the
    // re-write — otherwise the gate can't see them after the run starts.
    const existingQuery = location.hash.split('?')[1] || '';
    const params = new URLSearchParams(existingQuery);
    params.set('u', u);
    const newHash = `#clockin?${params.toString()}`;
    if (location.hash !== newHash) {
      history.replaceState(null, '', newHash + location.search);
    }

    running = true;
    $run.disabled = true;
    $hint.classList.add('hidden');
    setStatus('');
    $workers.innerHTML = '';
    $summary.style.display = 'none';
    if ($projection) $projection.style.display = 'none';
    steps.reset();
    state = null;
    try {
      await analyse(u);
      // If the resolved name differs in case, rewrite the hash with the
      // canonical form so refresh-by-URL stays stable. Same param-preserving
      // pattern as above.
      if (state?.ownerUsername && state.ownerUsername !== u) {
        const q = new URLSearchParams(location.hash.split('?')[1] || '');
        q.set('u', state.ownerUsername);
        const fixed = `#clockin?${q.toString()}`;
        if (location.hash !== fixed) history.replaceState(null, '', fixed + location.search);
      }
    } catch (e) {
      steps.markActiveAsError(e.message);
      const friendly = isTransientError(e)
        ? `The data server is having a moment (${e.message}). Wait a few seconds and try again.`
        : `Error: ${e.message}`;
      setStatus(friendly, true);
    } finally {
      running = false;
      $run.disabled = false;
    }
  }

  $run.addEventListener('click', run);
  $username.addEventListener('keydown', e => { if (e.key === 'Enter') run(); });
  $filterIdle.addEventListener('change', () => state && render());
  $sortRecent.addEventListener('change', () => state && render());
  $sortIdle.addEventListener('change',   () => state && render());

  return {
    /**
     * Called by the router every time this view becomes active.
     * Idempotent: if ?u= differs from the current input, update the
     * field and re-run; otherwise just focus the empty field.
     * @param {URLSearchParams} [params]
     */
    activate(params) {
      const u = (params && params.get('u'))
             || new URLSearchParams(location.search).get('u');
      if (u && $username.value !== u) {
        $username.value = u;
        run();
      } else if (!$username.value) {
        $username.focus();
      }
    },
  };
})();