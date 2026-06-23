/* ═══════════════════════════════════════════════════════════════════
 *  BUDDY FINDER
 *
 *  Public tool for Irish citizens to find a buddy-system partner, or
 *  join the hidden waiting list. Distinct from the MoECON-only Buddy
 *  System Monitor (#buddy) — that's an admin oversight dashboard;
 *  this is a self-service finder anyone can use.
 *
 *  Pipeline:
 *    1. Resolve username → user (search + verify, same anti-fuzzy
 *       pattern used everywhere else).
 *    2. Pull all Irish citizens + their lite profiles (skills).
 *    3. Pull worker rosters to detect mutual employment pairs.
 *    4. Classify each pair as balanced (off-limits) or imbalanced
 *       (their members become priority candidates).
 *    5. Three-tier rank: waitlist → imbalanced-pair → unpaired,
 *       sorted by skill closeness within each tier.
 *
 *  Waitlist storage:
 *    waitlist.json hosted on GitHub, mutated via repository_dispatch
 *    through the same warera-proxy Worker that fronts the gateway.
 *    The PAT lives server-side; client never sees it.
 *
 *  Access: restricted to Irish citizens via enforceIrishOnly from
 *  shared.js. The bypass=1 URL param lifts the restriction.
 * ═══════════════════════════════════════════════════════════════════ */
const BuddyFinderTool = (() => {
  const ACTIONS_PER_ENERGY = 0.343;

  // Closeness threshold for ranking matches AND for surfacing
  // waitlist-internal pairs. Same rule both places so the UX is
  // consistent: if A and B would be shown as a pair in the waitlist
  // box, A would also rank as a close match for B in the finder.
  // The threshold is computed against the *smaller* of two daily
  // outputs to be symmetric (matters for low-skill pairs).
  const closenessThreshold = (daily) => Math.max(50, daily * 0.15);

  // GitHub repo backing the waitlist.
  // Using the contents API endpoint rather than jsDelivr or raw, because
  // jsDelivr caches @main for ~12h and ignores query strings on the raw
  // endpoint — updates wouldn't surface for hours. The API endpoint
  // refreshes within seconds of a commit.
  const WAITLIST_READ_URL =
    'https://api.github.com/repos/R00ted-82/warera-tools-ireland/contents/waitlist.json?ref=main';
  // Worker route that fires repository_dispatch with the PAT attached
  // server-side. Same Worker handles the tRPC proxy.
  const WAITLIST_UPDATE_URL =
    'https://warera-proxy.r00ted82.workers.dev/waitlist-update';

  // DOM
  const $wlInput   = document.getElementById('bf-waitlist-username');
  const $wlBtn     = document.getElementById('bf-waitlist-submit');
  const $wlStatus  = document.getElementById('bf-waitlist-status');
  const $wlStats   = document.getElementById('bf-waitlist-stats');
  const $wlPairs   = document.getElementById('bf-waitlist-pairs');

  const $mInput    = document.getElementById('bf-match-username');
  const $mBtn      = document.getElementById('bf-match-submit');
  const $mStatus   = document.getElementById('bf-match-status');
  const $mResults  = document.getElementById('bf-match-results');

  const steps      = makeSteps(document.getElementById('bf-match-steps'));

  let waitlistStatsLoaded = false;
  let matchStore = null;   // { closeMatches, otherMatches, me } for "see more"

  // tRPC wrapper using the shared client (retries on transient 5xx).
  const bf_trpc = (endpoint, input) => trpc(endpoint, input, { retry: true });

  /* ── Player data extraction ─────────────────────────────── */
  function getSkillTotal(user, name) {
    const sk = user?.skills?.[name];
    if (!sk || typeof sk !== 'object') return 0;
    for (const k of ['total', 'value', 'level']) {
      const n = sk[k];
      if (typeof n === 'number' && Number.isFinite(n)) return n;
    }
    return 0;
  }
  const getProduction = u => getSkillTotal(u, 'production');
  const getEnergy     = u => getSkillTotal(u, 'energy');
  const getMaxDailyOutput = u =>
    Math.round(getProduction(u) * getEnergy(u) * ACTIONS_PER_ENERGY);
  const getCountry = u => u?.country ?? u?.countryId ?? null;

  /* ── Concurrency helper ─────────────────────────────────── */
  async function mapConcurrent(items, worker, concurrency = 20, onProgress) {
    const total = items.length;
    let done = 0;
    const results = new Array(total);
    let i = 0;
    async function pump() {
      while (i < total) {
        const idx = i++;
        try { results[idx] = await worker(items[idx]); }
        catch (e) { results[idx] = { error: e }; }
        done++;
        onProgress?.(done, total);
      }
    }
    const pumps = Array(Math.min(concurrency, total)).fill(0).map(pump);
    await Promise.all(pumps);
    return results;
  }

  /* ── Username resolution ────────────────────────────────── */
  // Same exact-match pattern as advisor/clockin: search returns fuzzy
  // matches, we verify by exact username (case-insensitive) against
  // the lite profile. Never silently fall back to the top result.
  async function resolveUsername(username) {
    const needle = username.trim().toLowerCase();
    if (!needle) return null;

    const searchRes = await bf_trpc('search.searchAnything', { searchText: username });
    const candidateIds = (searchRes?.userIds || []).slice(0, 10);
    if (candidateIds.length === 0) return null;

    const candidates = await mapConcurrent(candidateIds, async (id) => {
      try { return await bf_trpc('user.getUserLite', { userId: id }); }
      catch { return null; }
    }, 10);

    return candidates.find(u =>
      u && typeof u.username === 'string' && u.username.toLowerCase() === needle
    ) || null;
  }

  /* ── Bulk fetchers ──────────────────────────────────────── */
  async function fetchAllIrishCitizens(onPage) {
    const PAGE_LIMIT = 100;
    const items = [];
    let cursor;
    let safety = 0;
    while (safety++ < 200) {
      const input = { countryId: IRELAND_COUNTRY_ID, limit: PAGE_LIMIT };
      if (cursor) input.cursor = cursor;
      const page = await bf_trpc('user.getUsersByCountry', input);
      const arr = page?.items ?? page?.data ?? (Array.isArray(page) ? page : []);
      items.push(...arr);
      onPage?.(items.length);
      const next = page?.nextCursor ?? page?.cursor ?? null;
      if (!next || arr.length === 0) break;
      cursor = next;
    }
    return items;
  }
  const fetchUserLite = (userId) => bf_trpc('user.getUserLite', { userId });
  const fetchWorkers  = (userId) => bf_trpc('worker.getWorkers', { userId });

  /* ── Pair imbalance detection ───────────────────────────── */
  // Mirrors the umbrella Buddy System Monitor's thresholds so the
  // two tools agree on what counts as "balanced".
  function pairIsImbalanced(pair, users) {
    const ua = users.get(pair.a);
    const ub = users.get(pair.b);

    if (pair.aWage != null && pair.bWage != null) {
      const mx = Math.max(pair.aWage, pair.bWage);
      const mn = Math.min(pair.aWage, pair.bWage);
      if (mn > 0 && mx / mn >= 2.0) return true;
      if (mx > 0 && mn === 0) return true;
    }

    const ta = getMaxDailyOutput(ua);
    const tb = getMaxDailyOutput(ub);
    const mx = Math.max(ta, tb);
    const mn = Math.min(ta, tb);
    if (mx - mn >= 50 && (mn === 0 || mx / mn >= 1.2)) return true;

    return false;
  }

  /* ── Waitlist API ───────────────────────────────────────── */
  async function fetchWaitlist() {
    try {
      const url = `${WAITLIST_READ_URL}&t=${Math.floor(Date.now() / 60000)}`;
      const res = await fetch(url, {
        cache: 'no-cache',
        headers: { 'Accept': 'application/vnd.github.raw+json' },
      });
      if (!res.ok) {
        if (res.status === 404) return { entries: [] };
        throw new Error(`HTTP ${res.status}`);
      }
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); }
      catch { throw new Error('Waitlist JSON unparseable'); }
      if (typeof data?.content === 'string' && data.encoding === 'base64') {
        const decoded = atob(data.content.replace(/\s/g, ''));
        data = JSON.parse(decoded);
      }
      if (!data.entries) return { entries: [] };
      return data;
    } catch (e) {
      console.warn('[buddy-finder] waitlist fetch failed:', e);
      return { entries: [] };
    }
  }

  async function dispatchWaitlistUpdate(action, userId, username) {
    const res = await fetch(WAITLIST_UPDATE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, userId, username })
    });
    if (!res.ok) {
      let detail = '';
      try {
        const body = await res.json();
        detail = body?.error ? `: ${body.error}` : '';
      } catch {
        const txt = await res.text().catch(() => '');
        if (txt) detail = `: ${txt.slice(0, 200)}`;
      }
      throw new Error(`Update failed (HTTP ${res.status})${detail}`);
    }
    return true;
  }

  /* ── Inline status helper (small notices under each card) ─ */
  function showStatus($el, level, html) {
    $el.className = `bf-inline-status ${level}`;
    $el.innerHTML = html;
    $el.classList.remove('hidden');
  }
  function hideStatus($el) {
    $el.classList.add('hidden');
    $el.innerHTML = '';
  }

  /* ── Player card rendering ──────────────────────────────── */
  const LINK_ICON = `<svg class="bf-link-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>`;

  function renderPlayer(user, opts = {}) {
    const id = user._id;
    const initial = (user.username || '?').slice(0, 1).toUpperCase();
    const avatarSrc = user.avatarUrl;
    const avatarHtml = (avatarSrc && /^https?:\/\//.test(avatarSrc))
      ? `<div class="bf-avatar"><img src="${escapeHtml(avatarSrc)}" alt="" onerror="this.parentElement.textContent='${escapeHtml(initial)}'"></div>`
      : `<div class="bf-avatar">${escapeHtml(initial)}</div>`;

    const prod = getProduction(user);
    const energy = getEnergy(user);
    const daily = getMaxDailyOutput(user);

    let badgeHtml = '';
    if (opts.priority === 'waitlist') {
      badgeHtml = `<span class="bf-priority-badge" title="On the buddy waiting list, looking for a match">on waitlist</span>`;
    } else if (opts.priority === 'imbalanced') {
      badgeHtml = `<span class="bf-priority-badge imbalanced" title="Already in a buddy pair, but the skill gap with their current partner is large enough that they'd benefit from a better match">mismatched</span>`;
    }

    const meta = [
      `<span class="bf-stat" title="↗ production points per work · ⚡ energy capacity">↗ <strong>${prod}</strong> &nbsp;⚡ <strong>${energy}</strong></span>`,
      `<span class="bf-stat" title="Estimated max production points per day">≈ <strong>${daily}</strong> PP/day</span>`,
    ];

    return `
      <div class="bf-player">
        ${avatarHtml}
        <div class="bf-player-body">
          <div class="bf-name-row">
            <a class="bf-name" href="${GAME_BASE}/user/${id}" target="_blank" rel="noopener">${escapeHtml(user.username || id)} ${LINK_ICON}</a>
            ${badgeHtml}
          </div>
          <div class="bf-meta-row">${meta.join(' · ')}</div>
        </div>
      </div>
    `;
  }

  /* ── Match list rendering ───────────────────────────────── */
  function renderMatchList(closeMatches, otherMatches, shown) {
    const all = [...closeMatches, ...otherMatches];
    if (all.length === 0) {
      return `<div class="bf-empty-state">No good matches found. Try joining the waiting list, so you'll be flagged to others searching.</div>`;
    }

    const visible = all.slice(0, shown);
    const remaining = all.length - shown;

    let html = `<h3 class="bf-results-head">🎯 Closest matches <span class="bf-count">· sorted by skill closeness, waitlist members first</span></h3>`;
    html += visible.map(c => renderPlayer(c.user, {
      priority: c.onWaitlist ? 'waitlist' : (c.inImbalanced ? 'imbalanced' : null)
    })).join('');

    if (remaining > 0) {
      const nextBatch = Math.min(8, remaining);
      html += `
        <div class="bf-see-more-row">
          <button id="bf-see-more-btn" data-shown="${shown}">↓ Show ${nextBatch} more</button>
          <div class="bf-see-more-note">
            ${remaining} more candidate${remaining === 1 ? '' : 's'} available, further from your skill level
          </div>
        </div>
      `;
    }

    // Next-steps panel — only when there's at least one match to act on.
    const dmTemplate =
`Hey! I found you on the buddy finder at tools.we-ie.com. Want to set up a buddy arrangement? The idea is we both hire each other at minimum wage so our companies get a worker without paying real wages. Our stats look like a good match. Let me know if you're up for it!`;

    html += `
      <div class="bf-next-steps">
        <h3>✅ What to do next</h3>
        <ol>
          <li>Pick a candidate above. The top ones are closest to your skill level.</li>
          <li>Click their name to open their War Era profile.</li>
          <li>Use the in-game <strong>message</strong> button to DM them. Below is a starter message you can copy.</li>
          <li>If they agree, you each post a job offer at <strong>minimum wage</strong> and hire each other.</li>
          <li>That's it, you will be automatically removed when you start working for eachother.</li>
        </ol>
        <div class="bf-dm-template" id="bf-dm-template">${escapeHtml(dmTemplate)}</div>
        <div class="bf-dm-actions">
          <button class="bf-copy-btn" id="bf-copy-dm-btn">📋 Copy message</button>
          <span class="bf-copy-status" id="bf-copy-dm-status"></span>
        </div>
      </div>
    `;
    return html;
  }

  function wireUpInteractiveControls() {
    const $seeMore = document.getElementById('bf-see-more-btn');
    if ($seeMore) {
      $seeMore.addEventListener('click', () => {
        const currentShown = parseInt($seeMore.dataset.shown, 10) || 8;
        const newShown = currentShown + 8;
        if (!matchStore) return;
        const { closeMatches, otherMatches } = matchStore;

        // Preserve the "You: …" header (first h3), replace everything after.
        const firstH3 = $mResults.querySelector('h3');
        const headerHtml = firstH3 ? firstH3.outerHTML : '';
        $mResults.innerHTML = headerHtml + renderMatchList(closeMatches, otherMatches, newShown);
        wireUpInteractiveControls();
      });
    }

    const $copyBtn = document.getElementById('bf-copy-dm-btn');
    if ($copyBtn) {
      $copyBtn.addEventListener('click', async () => {
        const text = document.getElementById('bf-dm-template').textContent;
        const $status = document.getElementById('bf-copy-dm-status');
        try {
          await navigator.clipboard.writeText(text);
          $status.textContent = 'Copied. Paste it into War Era after picking a buddy.';
          $status.classList.add('shown');
          setTimeout(() => {
            $status.textContent = '';
            $status.classList.remove('shown');
          }, 4000);
        } catch {
          $status.textContent = 'Copy failed. Select the text above and copy manually.';
          $status.classList.add('shown');
        }
      });
    }
  }

  /* ── Match finder pipeline ──────────────────────────────── */
  async function handleMatchSubmit() {
    const raw = $mInput.value.trim();
    if (!raw) {
      showStatus($mStatus, 'warn', 'Please enter your in-game username.');
      $mInput.focus();
      return;
    }

    // Clear everything from any previous run — results, status, match
    // store. Without this, a failed lookup after a previous success
    // would leave stale matches and the "You: …" header on screen.
    $mBtn.disabled = true;
    $mResults.innerHTML = '';
    matchStore = null;
    hideStatus($mStatus);
    steps.reset();

    try {
      // Step 1: resolve username. We MUST exit here if the lookup
      // fails — there's no point loading the citizen pool, building
      // worker maps, etc. just to discard them at render time.
      // The inner try/catch separates "search itself errored" from
      // "search returned nothing" so each gets a clearer message.
      steps.setStep(1, 'active', { sub: `Searching for "${raw}"` });
      let me;
      try {
        me = await resolveUsername(raw);
      } catch (e) {
        steps.markActiveAsError('Lookup failed');
        throw new Error(
          isTransientError(e)
            ? `The data server is having a moment (${e.message}). Wait a few seconds and try again.`
            : `Username lookup failed: ${e.message}`
        );
      }
      if (!me) {
        steps.markActiveAsError('No user found with that name');
        throw new Error(`No War Era user found with username "${raw}". Check the spelling and try again.`);
      }
      steps.setStep(1, 'done', { count: `→ ${me.username}` });

      // Citizenship gate (honours ?bypass=1 from shared.js)
      enforceIrishOnly(getCountry(me), me.username);

      // Persist canonical username in URL for shareable links.
      const existingQuery = location.hash.split('?')[1] || '';
      const params = new URLSearchParams(existingQuery);
      params.set('u', me.username);
      const newHash = `#buddy-finder?${params.toString()}`;
      if (location.hash !== newHash) {
        history.replaceState(null, '', newHash + location.search);
      }
      // Keep the waitlist input in sync so the user doesn't have to retype.
      if (!$wlInput.value) $wlInput.value = me.username;

      const myDaily = getMaxDailyOutput(me);

      // Step 2: load Irish citizens
      steps.setStep(2, 'active', { sub: 'Paginating user list' });
      const citizens = await fetchAllIrishCitizens(n => {
        steps.setStep(2, 'active', { count: `${n} loaded` });
      });
      steps.setStep(2, 'done', { count: `${citizens.length} citizens` });

      const users = new Map();
      for (const c of citizens) users.set(c._id, c);
      users.set(me._id, me);

      // Step 3: lite profiles for skills
      steps.setStep(3, 'active', { sub: 'Loading skills', count: `0/${citizens.length}` });
      await mapConcurrent(citizens, async (c) => {
        try {
          const lite = await fetchUserLite(c._id);
          if (lite) users.set(c._id, { ...users.get(c._id), ...lite });
        } catch {}
      }, 20, (done, total) => {
        steps.setStep(3, 'active', { count: `${done}/${total}` });
      });
      steps.setStep(3, 'done', { count: `${citizens.length} loaded` });

      // Step 4: worker rosters → mutual pairs
      steps.setStep(4, 'active', { sub: 'Checking who is already paired', count: `0/${citizens.length}` });
      const ownerCompanies = new Map();
      const worksAt = new Map();
      await mapConcurrent(citizens, async (c) => {
        try {
          const res = await fetchWorkers(c._id);
          const wpc = res?.workersPerCompany || [];
          if (wpc.length > 0) {
            ownerCompanies.set(c._id, wpc);
            for (const { workers } of wpc) {
              for (const w of (workers || [])) {
                if (!worksAt.has(w.user)) worksAt.set(w.user, new Map());
                worksAt.get(w.user).set(c._id, { wage: w.wage });
              }
            }
          }
        } catch {}
      }, 20, (done, total) => {
        steps.setStep(4, 'active', { count: `${done}/${total}` });
      });

      // Compute mutual pairs
      const pairs = [];
      const seenPair = new Set();
      for (const [ownerId, wpc] of ownerCompanies.entries()) {
        for (const { workers } of wpc) {
          for (const w of (workers || [])) {
            if (!users.has(w.user)) continue;
            const reverseEdge = worksAt.get(ownerId)?.get(w.user);
            if (reverseEdge) {
              const key = [ownerId, w.user].sort().join('|');
              if (!seenPair.has(key)) {
                seenPair.add(key);
                pairs.push({
                  a: ownerId, b: w.user,
                  aWage: reverseEdge.wage, bWage: w.wage,
                });
              }
            }
          }
        }
      }

      // Bucket: balanced (off-limits) vs imbalanced (priority)
      const balancedMembers = new Set();
      const imbalancedMembers = new Set();
      for (const p of pairs) {
        if (pairIsImbalanced(p, users)) {
          imbalancedMembers.add(p.a);
          imbalancedMembers.add(p.b);
        } else {
          balancedMembers.add(p.a);
          balancedMembers.add(p.b);
        }
      }
      // A user could appear in both buckets if they're in two pairs (one
      // balanced, one imbalanced). Imbalanced wins, since they're already
      // shortchanged in at least one pairing.
      for (const id of imbalancedMembers) balancedMembers.delete(id);

      steps.setStep(4, 'done', {
        count: `${pairs.length} pair${pairs.length === 1 ? '' : 's'} · ${imbalancedMembers.size} mismatched`
      });

      // Waitlist
      const wl = await fetchWaitlist();
      const waitlistIds = new Set(wl.entries.map(e => e.userId));

      // Build candidate pool
      const candidates = [];
      for (const [id, u] of users.entries()) {
        if (id === me._id) continue;
        if (balancedMembers.has(id)) continue;
        if (!u.username) continue;
        candidates.push({
          user: u,
          daily: getMaxDailyOutput(u),
          onWaitlist: waitlistIds.has(id),
          inImbalanced: imbalancedMembers.has(id),
        });
      }
      const usable = candidates.filter(c => c.daily > 0);

      steps.fadeOut(400);

      if (usable.length === 0) {
        $mResults.innerHTML = `<div class="bf-empty-state">No available candidates found. The buddy pool may be small right now. Try joining the waiting list and check back later.</div>`;
        return;
      }

      // Score by closeness in daily output, three-tier sort.
      for (const c of usable) c.delta = Math.abs(c.daily - myDaily);
      function tier(c) {
        if (c.onWaitlist)   return 0;
        if (c.inImbalanced) return 1;
        return 2;
      }
      usable.sort((x, y) => {
        const tx = tier(x), ty = tier(y);
        if (tx !== ty) return tx - ty;
        return x.delta - y.delta;
      });

      // Tight threshold: candidates within 15% of your daily output are
      // "close matches". Anything outside is shown only on demand.
      const closeMatches = usable.filter(c => c.delta <= closenessThreshold(myDaily));
      const otherMatches = usable.filter(c => c.delta >  closenessThreshold(myDaily));

      matchStore = { closeMatches, otherMatches, me };

      let html = `
        <h3 class="bf-results-head">You: <strong>${escapeHtml(me.username)}</strong>
          <span class="bf-count">· ↗ ${getProduction(me)} ⚡ ${getEnergy(me)} ≈ ${myDaily} PP/day</span>
        </h3>
      `;
      html += renderMatchList(closeMatches, otherMatches, 8);
      $mResults.innerHTML = html;
      wireUpInteractiveControls();
    } catch (e) {
      // Step 1 throws already mark the active step as errored; later
      // failures get marked here. The status pane shows the message
      // we constructed above (already friendly), so just escape and
      // surface it. No extra "data server" wrapping — that's already
      // applied at the point each error is thrown where appropriate.
      steps.markActiveAsError(e.message);
      showStatus($mStatus, 'error', escapeHtml(e.message));
    } finally {
      $mBtn.disabled = false;
    }
  }

  /* ── Dynamic button label ───────────────────────────────── */
  // The button toggles: it adds you if you're not on the waitlist,
  // removes you if you are. Re-label to match the action so the user
  // doesn't have to read the help text.
  const WL_BTN_LABEL_DEFAULT = 'Submit';
  const WL_BTN_LABEL_REMOVE  = 'Leave waitlist';
  const WL_BTN_LABEL_ADD     = 'Join waitlist';

  // 30s cache so debounced keystrokes don't hammer the GitHub API.
  let waitlistCache = { entries: null, ts: 0 };
  async function getWaitlistCached() {
    const now = Date.now();
    if (waitlistCache.entries && (now - waitlistCache.ts) < 30000) {
      return waitlistCache.entries;
    }
    const wl = await fetchWaitlist();
    waitlistCache = { entries: wl.entries || [], ts: now };
    return waitlistCache.entries;
  }
  // Invalidate the cache after a successful add/remove, so the next
  // keystroke reflects reality instead of the pre-action snapshot.
  function invalidateWaitlistCache() {
    waitlistCache = { entries: null, ts: 0 };
  }

  async function updateWaitlistButtonLabel() {
    const raw = $wlInput.value.trim();
    if (!raw) {
      $wlBtn.textContent = WL_BTN_LABEL_DEFAULT;
      return;
    }
    try {
      const user = await resolveUsername(raw);
      if (!user) {
        $wlBtn.textContent = WL_BTN_LABEL_DEFAULT;
        return;
      }
      const entries = await getWaitlistCached();
      const onList = entries.some(e => e.userId === user._id);
      $wlBtn.textContent = onList ? WL_BTN_LABEL_REMOVE : WL_BTN_LABEL_ADD;
    } catch {
      // Silently fall back to the default — the submit handler still
      // works correctly without the label being right.
      $wlBtn.textContent = WL_BTN_LABEL_DEFAULT;
    }
  }

  // Debounce so we don't fire a lookup on every keystroke.
  let labelDebounceTimer = null;
  function scheduleLabelUpdate() {
    clearTimeout(labelDebounceTimer);
    labelDebounceTimer = setTimeout(updateWaitlistButtonLabel, 400);
  }

  /* ── Waitlist UI ────────────────────────────────────────── */

  /**
   * Pair up waitlist members whose skill levels are close enough
   * (same 15% rule the finder uses). Iterates the waitlist in its
   * stored order — oldest entries first — and greedily pairs each
   * unpaired entry with the next unpaired entry within threshold.
   *
   * Each member can only appear in one pair. Members without a
   * pair within threshold are dropped (their names stay hidden).
   * Returns [{ a: user, b: user }, …].
   */
  function pairWaitlistMembers(profiles) {
    const ordered = profiles
      .filter(p => p && p.daily > 0)
      // Keep original waitlist order (oldest first). The waitlist.json
      // file appends new entries at the end, so the array order is
      // already chronological.
      .slice();

    const pairs = [];
    const taken = new Set();
    for (let i = 0; i < ordered.length; i++) {
      if (taken.has(i)) continue;
      const a = ordered[i];
      // Find the first later entry within closeness threshold of `a`.
      // Threshold uses the smaller daily so it's symmetric.
      for (let j = i + 1; j < ordered.length; j++) {
        if (taken.has(j)) continue;
        const b = ordered[j];
        const smaller = Math.min(a.daily, b.daily);
        const delta = Math.abs(a.daily - b.daily);
        if (delta <= closenessThreshold(smaller)) {
          pairs.push({ a, b });
          taken.add(i);
          taken.add(j);
          break;
        }
      }
    }
    return pairs;
  }

  function renderWaitlistPairs(pairs) {
    if (!pairs.length) {
      $wlPairs.innerHTML = '';
      $wlPairs.classList.add('hidden');
      return;
    }
    const blocks = pairs.map(({ a, b }) => `
      <div class="bf-wl-pair">
        <div class="bf-wl-pair-players">
          ${renderPlayer(a.user)}
          ${renderPlayer(b.user)}
        </div>
        <div class="bf-wl-pair-hint">
          💬 Message each other in-game, then both post a <strong>minimum-wage</strong> job offer and hire each other.
        </div>
      </div>
    `).join('');
    $wlPairs.innerHTML = `
      <h4 class="bf-wl-pairs-head">🎯 Suggested pairs from the waiting list
        <span class="bf-count">· ${pairs.length} match${pairs.length === 1 ? '' : 'es'} found</span>
      </h4>
      ${blocks}
    `;
    $wlPairs.classList.remove('hidden');
  }

  async function updateWaitlistStats() {
    const wl = await fetchWaitlist();
    const n = wl.entries.length;
    $wlStats.innerHTML = `<strong>${n}</strong> player${n === 1 ? '' : 's'} currently on the waiting list.`;

    // Try to surface paired matches among waitlist members. If fewer
    // than two entries, skip the lite-profile fetch entirely.
    if (n >= 2) {
      const profiles = await mapConcurrent(wl.entries, async (entry) => {
        try {
          const u = await fetchUserLite(entry.userId);
          if (!u) return null;
          return { user: u, daily: getMaxDailyOutput(u) };
        } catch { return null; }
      }, 10);
      const pairs = pairWaitlistMembers(profiles);
      renderWaitlistPairs(pairs);
    } else {
      renderWaitlistPairs([]);
    }

    waitlistStatsLoaded = true;
  }

  async function handleWaitlistSubmit() {
    const raw = $wlInput.value.trim();
    if (!raw) {
      showStatus($wlStatus, 'warn', 'Please enter your in-game username.');
      $wlInput.focus();
      return;
    }
    if (raw.length > 40) {
      showStatus($wlStatus, 'warn', 'Username looks too long. Please double-check.');
      return;
    }

    $wlBtn.disabled = true;
    showStatus($wlStatus, 'info', `<span class="bf-spinner"></span>Looking up <strong>${escapeHtml(raw)}</strong>…`);

    let user;
    try {
      user = await resolveUsername(raw);
    } catch (e) {
      showStatus($wlStatus, 'error', `Couldn't reach the War Era Gateway. ${escapeHtml(e.message)}`);
      $wlBtn.disabled = false;
      return;
    }
    if (!user) {
      showStatus($wlStatus, 'error', `No War Era user found with username <strong>${escapeHtml(raw)}</strong>. Check the spelling and try again.`);
      $wlBtn.disabled = false;
      return;
    }

    // Citizenship gate. enforceIrishOnly throws, so catch and surface
    // it as a normal inline error rather than letting it bubble.
    try {
      enforceIrishOnly(getCountry(user), user.username);
    } catch (e) {
      showStatus($wlStatus, 'error', escapeHtml(e.message));
      $wlBtn.disabled = false;
      return;
    }

    // Decide add vs remove based on current waitlist state.
    const wl = await fetchWaitlist();
    const alreadyOn = wl.entries.some(e => e.userId === user._id);
    const action = alreadyOn ? 'remove' : 'add';

    showStatus($wlStatus, 'info', `<span class="bf-spinner"></span>Submitting…`);
    try {
      await dispatchWaitlistUpdate(action, user._id, user.username);
    } catch (e) {
      showStatus($wlStatus, 'error', `Submission failed: ${escapeHtml(e.message)}`);
      $wlBtn.disabled = false;
      return;
    }

    if (action === 'add') {
      showStatus($wlStatus, 'success',
        `✅ <strong>${escapeHtml(user.username)}</strong> added to the waitlist. Give it about a minute to actually land.`);
    } else {
      showStatus($wlStatus, 'success',
        `✅ <strong>${escapeHtml(user.username)}</strong> removed from the waitlist.`);
    }

    $wlInput.value = '';
    $wlBtn.disabled = false;
    $wlBtn.textContent = WL_BTN_LABEL_DEFAULT;  // reset label since input is now blank
    invalidateWaitlistCache();                  // next keystroke sees the new reality
    setTimeout(updateWaitlistStats, 60000);
  }


  /* ── Wire-up ────────────────────────────────────────────── */
  $mBtn.addEventListener('click', handleMatchSubmit);
  $mInput.addEventListener('keydown', e => { if (e.key === 'Enter') handleMatchSubmit(); });
  $wlBtn.addEventListener('click', handleWaitlistSubmit);
  $wlInput.addEventListener('keydown', e => { if (e.key === 'Enter') handleWaitlistSubmit(); });
  $wlInput.addEventListener('input', scheduleLabelUpdate);

  return {
    /**
     * Called by the router whenever this view becomes active.
     * Idempotent: lazy-loads waitlist stats once, and re-runs the
     * match search only if ?u= differs from the current input.
     */
    activate(params) {
      if (!waitlistStatsLoaded) updateWaitlistStats();

      const u = (params && params.get('u'))
             || new URLSearchParams(location.search).get('u');
      if (u && $mInput.value !== u) {
        $mInput.value = u;
        if (!$wlInput.value) $wlInput.value = u;
        handleMatchSubmit();
      } else if (!$mInput.value) {
        $mInput.focus();
      }
      // If the waitlist input has a prefilled value (from URL or auto-fill),
      // get the button label right immediately rather than waiting for typing.
      if ($wlInput.value) updateWaitlistButtonLabel();
    }
  };
})();