/* Buddy System — encrypted payload source
   =======================================
   Feed THIS into encrypt-bo.html (the encryptor is payload-agnostic),
   then paste the encrypted base64 output into BUDDY_ENCRYPTED_PAYLOAD
   in tools.we-ie.com/index.html.

   At decrypt time this runs inside the umbrella page and reuses these
   globals from the umbrella's <script>:
     trpc, escapeHtml, makeSteps, makeStatus, isTransientError
   Anything else is declared locally inside the IIFE. The umbrella also
   provides two empty containers we populate:
     #buddy-content    (in the body, will hold the tool UI)
     #buddy-controls   (in the tool-header, will hold refresh + label)
*/
(function () {
  'use strict';

  /* ── Local constants ─────────────────────────────────────────── */
  const GAME_BASE  = 'https://app.warera.io';
  const PAGE_LIMIT = 100;
  const CFG = {
    IRELAND_COUNTRY_ID: '6813b6d446e731854c7ac7fe',
    ACTIVE_MS:          48 * 60 * 60 * 1000,      // 2 days  → "active" dot
    RECENT_MS:          7  * 24 * 60 * 60 * 1000, // 7 days  → recently worked/connected
    NEW_PLAYER_MS:      3  * 24 * 60 * 60 * 1000, // 3 days  → exclude from un/inactive
    CONCURRENCY:        20,
  };

  /* Empirical calibration: 10%/hour energy regen × ~7 energy per work
     action ≈ energy × 0.343 work actions/day. Universal across players. */
  const ACTIONS_PER_ENERGY  = 0.343;
  const MIN_REC_OUTPUT      = 50;   // PP/day floor for recommendations
  const MAX_RECOMMENDATIONS = 12;   // batch size for "Show more"

  const LINK_ICON = `<svg class="bs-link-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>`;

  /* ── Utilities ───────────────────────────────────────────────── */
  function fmtTimeAgo(d) {
    if (!d) return '';
    const ms = Date.now() - d.getTime();
    if (ms < 60000)    return 'just now';
    if (ms < 3600000)  return `${Math.floor(ms/60000)}m ago`;
    if (ms < 86400000) return `${Math.floor(ms/3600000)}h ago`;
    return `${Math.floor(ms / 86400000)}d ago`;
  }

  async function mapConcurrent(items, worker, onProgress) {
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
    const workers = Array(Math.min(CFG.CONCURRENCY, total)).fill(0).map(pump);
    await Promise.all(workers);
    return results;
  }

  /* ── Inject Buddy-specific CSS ───────────────────────────────── */
  /* Everything umbrella already provides (root vars, .steps, .status,
     .tool-header, base button/typography, details.howto frame) is NOT
     re-declared here. We only add what's unique to the Buddy tool. */
  const styleEl = document.createElement('style');
  styleEl.id = 'buddy-injected-styles';
  styleEl.textContent = `
.buddy-updated-label { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }

/* Orange palette for severe-imbalance pairs */
.buddy-scope {
  --orange: #fb923c;
  --orange-bg: rgba(251, 146, 60, 0.10);
  --orange-border: rgba(251, 146, 60, 0.55);
}

/* Collapsible sections (top-level) */
.buddy-scope details.section {
  margin-bottom: 10px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
}
.buddy-scope details.section > summary {
  cursor: pointer; padding: 14px 18px;
  user-select: none; list-style: none;
  display: flex; align-items: center; gap: 10px;
  flex-wrap: wrap;
  transition: background 0.15s;
}
.buddy-scope details.section > summary::-webkit-details-marker { display: none; }
.buddy-scope details.section > summary:hover { background: var(--panel-2); }
.buddy-scope details.section[open] > summary { border-bottom: 1px solid var(--border); }
.buddy-scope details.section > .section-body { padding: 16px 18px; }
.buddy-scope details.section .section-title {
  font-size: 16px; font-weight: 600; color: var(--text);
  margin: 0;
}
.buddy-scope details.section > summary .count {
  color: var(--muted); font-size: 13px; font-weight: 400;
  flex-shrink: 0; white-space: nowrap;
}
.buddy-scope .section-desc {
  color: var(--muted); font-size: 12px; line-height: 1.5;
  margin: 0 0 12px; max-width: 70ch;
}

/* Subsections inside Outside-the-buddy-system */
.buddy-scope details.subsection {
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: 6px;
  margin-bottom: 8px;
  overflow: hidden;
}
.buddy-scope details.subsection > summary {
  cursor: pointer; padding: 10px 14px;
  user-select: none; list-style: none;
  display: flex; align-items: center; gap: 10px;
  flex-wrap: wrap;
  transition: background 0.15s;
}
.buddy-scope details.subsection > summary::-webkit-details-marker { display: none; }
.buddy-scope details.subsection > summary:hover { background: var(--bg); }
.buddy-scope details.subsection[open] > summary { border-bottom: 1px solid var(--border); }
.buddy-scope details.subsection > .subsection-body {
  padding: 12px 14px; background: var(--panel);
}
.buddy-scope details.subsection .subsection-title {
  font-size: 13px; font-weight: 600; color: var(--text); margin: 0;
}
.buddy-scope details.subsection > summary .count {
  color: var(--muted); font-weight: 400; font-size: 12px;
  flex-shrink: 0; white-space: nowrap;
}
.buddy-scope .subsection-desc {
  color: var(--muted); font-size: 11.5px; line-height: 1.5;
  margin: 0 0 10px;
}

/* Chevron */
.buddy-scope .chev::before {
  content: '▸';
  color: var(--muted);
  font-size: 11px;
  display: inline-block;
  width: 12px; text-align: center;
  transition: transform 0.15s;
  flex-shrink: 0;
}
.buddy-scope details[open] > summary .chev::before { transform: rotate(90deg); }

/* Player card */
.buddy-scope .player {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 12px;
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 13px;
  min-width: 0;
}
.buddy-scope .player .avatar {
  width: 32px; height: 32px; border-radius: 4px; flex-shrink: 0;
  background: var(--bg);
  display: flex; align-items: center; justify-content: center;
  color: var(--muted); font-size: 13px; font-weight: 600;
  overflow: hidden;
}
.buddy-scope .player .avatar img { width: 100%; height: 100%; object-fit: cover; }
.buddy-scope .player .body { flex: 1; min-width: 0; }
.buddy-scope .player .name-row {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  margin-bottom: 3px;
}
.buddy-scope .player .name {
  color: var(--text); font-weight: 600;
  display: inline-flex; align-items: center; gap: 4px;
}
.buddy-scope .player .name:hover { color: var(--link); text-decoration: none; }
.buddy-scope .player .meta-row {
  display: flex; align-items: center; gap: 6px 10px; flex-wrap: wrap;
  color: var(--muted); font-size: 11.5px;
}
.buddy-scope .player .meta-row .stat { font-variant-numeric: tabular-nums; }
.buddy-scope .player .meta-row .stat strong { color: var(--text); font-weight: 600; }
.buddy-scope .player .meta-row .stat.dim { opacity: 0.55; }

.buddy-scope .bs-link-icon {
  width: 11px; height: 11px;
  opacity: 0.5; transition: opacity 0.15s;
  flex-shrink: 0;
}
.buddy-scope a:hover .bs-link-icon { opacity: 1; }

.buddy-scope .activity-dot {
  display: inline-block; width: 7px; height: 7px;
  border-radius: 50%; flex-shrink: 0;
  background: var(--border);
}
.buddy-scope .activity-dot.active { background: var(--accent); box-shadow: 0 0 4px rgba(74,222,128,0.4); }
.buddy-scope .activity-dot.stale  { background: var(--danger); opacity: 0.5; }

.buddy-scope .foreign-flag { color: var(--warn); font-size: 11px; }

/* Buddy pairs grid */
.buddy-scope .pair { margin-bottom: 10px; }
.buddy-scope .pair.severe .player { border-color: var(--orange-border); }
.buddy-scope .pair.severe .pairs-grid .arrow {
  color: var(--orange); font-size: 16px;
}
.buddy-scope .pairs-grid {
  display: grid; grid-template-columns: 1fr 32px 1fr; gap: 10px 8px;
  align-items: center;
}
.buddy-scope .pairs-grid .arrow {
  text-align: center; color: var(--muted); font-size: 14px;
  user-select: none;
}
.buddy-scope .severe-note {
  margin-top: 6px; padding: 6px 10px;
  background: var(--orange-bg);
  border: 1px solid var(--orange-border);
  border-radius: 4px;
  font-size: 12px; color: var(--orange);
  line-height: 1.5;
}
.buddy-scope .severe-note .label { font-weight: 600; margin-right: 4px; }
.buddy-scope .severe-note .val { font-variant-numeric: tabular-nums; color: var(--text); }

/* Recommendation cards */
.buddy-scope .rec-pair { margin-bottom: 14px; }
.buddy-scope .rec-info {
  margin-top: 6px; padding: 4px 10px;
  color: var(--muted);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}
.buddy-scope .rec-info .val { color: var(--text); font-weight: 600; }
.buddy-scope .rec-breakup {
  margin-top: 4px; padding: 5px 10px;
  background: rgba(251,191,36,0.08);
  border: 1px solid rgba(251,191,36,0.25);
  border-radius: 4px;
  font-size: 11.5px; color: var(--warn);
}
.buddy-scope .rec-breakup .who { color: var(--text); font-weight: 600; }

.buddy-scope .player-list {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 8px;
}

.buddy-scope .buddy-empty {
  padding: 24px 16px; text-align: center;
  color: var(--muted); font-size: 13px;
  background: var(--panel); border: 1px dashed var(--border);
  border-radius: 6px;
}

/* details.howto extensions — umbrella defines base, buddy adds h4/p/strong */
.buddy-scope details.howto h4 {
  margin: 14px 0 6px; color: var(--text); font-size: 13px; font-weight: 600;
}
.buddy-scope details.howto h4:first-child { margin-top: 0; }
.buddy-scope details.howto p { margin: 0 0 8px; }
.buddy-scope details.howto ul ul { margin-top: 4px; }
.buddy-scope details.howto strong { color: var(--text); font-weight: 600; }

/* Load-more button under recommendations */
.buddy-scope .load-more-wrap { text-align: center; margin-top: 16px; }
.buddy-scope .load-more-wrap button { font-size: 12.5px; padding: 7px 18px; }
.buddy-scope .load-more-info {
  color: var(--muted); font-size: 11.5px; margin-top: 6px;
}

@media (max-width: 720px) {
  .buddy-scope .pair, .buddy-scope .rec-pair {
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px 10px 8px;
    margin-bottom: 12px;
  }
  .buddy-scope .pair .player, .buddy-scope .rec-pair .player {
    background: var(--bg);
  }
  .buddy-scope .pair.severe {
    border-color: var(--orange-border);
    background: rgba(251, 146, 60, 0.06);
  }
  .buddy-scope .pair.severe .player { border-color: var(--border); }

  .buddy-scope .pairs-grid {
    grid-template-columns: 1fr;
    gap: 4px;
  }
  .buddy-scope .pairs-grid .arrow {
    transform: none; padding: 0;
    font-size: 12px; opacity: 0.7;
  }
  .buddy-scope .player-list { grid-template-columns: 1fr; }

  .buddy-scope .rec-info { padding: 6px 4px 2px; font-size: 11.5px; }
  .buddy-scope .severe-note { font-size: 11.5px; }
}
`;
  document.head.appendChild(styleEl);

  /* ── Inject HTML into #buddy-content ─────────────────────────── */
  /* Everything Buddy-rendered lives inside .buddy-scope so the CSS
     above stays scoped and can't bleed into the rest of the umbrella. */
  document.getElementById('buddy-content').innerHTML = `
    <div class="buddy-scope">
      <div id="buddy-steps" class="steps hidden">
        <div class="step" data-state="pending" data-step="1">
          <div class="step-icon"></div>
          <div class="step-body">
            <div class="step-title">Loading Irish citizens</div>
            <div class="step-sub"></div>
          </div>
          <div class="step-count"></div>
        </div>
        <div class="step" data-state="pending" data-step="2">
          <div class="step-icon"></div>
          <div class="step-body">
            <div class="step-title">Fetching each player's profile</div>
            <div class="step-sub"></div>
          </div>
          <div class="step-count"></div>
        </div>
        <div class="step" data-state="pending" data-step="3">
          <div class="step-icon"></div>
          <div class="step-body">
            <div class="step-title">Mapping employer ↔ worker links</div>
            <div class="step-sub"></div>
          </div>
          <div class="step-count"></div>
        </div>
      </div>

      <div id="buddy-status" class="status hidden"></div>

      <div id="buddy-main-content" style="display:none">

        <details class="section">
          <summary>
            <span class="chev"></span>
            <span class="section-title">🤝 Buddy pairs</span>
            <span class="count" id="buddy-pairs-count"></span>
          </summary>
          <div class="section-body">
            <p class="section-desc">Mutual employment between Irish citizens. Pairs flagged in orange when wage or daily output is significantly imbalanced.</p>
            <div id="buddy-pairs-list"></div>
          </div>
        </details>

        <details class="section">
          <summary>
            <span class="chev"></span>
            <span class="section-title">🚪 Outside the buddy system</span>
            <span class="count" id="buddy-outside-count"></span>
          </summary>
          <div class="section-body">
            <p class="section-desc">Irish citizens not in a mutual pair. Asymmetric workers are being shortchanged, foreign-company workers and the unemployed are recruitment opportunities.</p>
            <div id="buddy-outside-list"></div>
          </div>
        </details>

        <details class="section">
          <summary>
            <span class="chev"></span>
            <span class="section-title">💡 Recommendations</span>
            <span class="count" id="buddy-recommendations-count"></span>
          </summary>
          <div class="section-body">
            <p class="section-desc">Suggested pairings, sorted by tier (who's already in the scheme) and combined daily output. Click "Show more" at the bottom to load the next batch.</p>
            <div id="buddy-recommendations-list"></div>
          </div>
        </details>

        <details class="howto">
          <summary>How the buddy system works · what each section shows</summary>
          <div class="howto-body">
            <h4>The idea</h4>
            <p>Two Irish citizens form a <strong>buddy pair</strong> by hiring each other at minimum wage. Alice owns a company. Bob works in it at minimum wage. Bob owns a company. Alice works in it at minimum wage.</p>
            <p>Net wages roughly cancel, but both companies get a worker, so production goes up on both sides without anyone paying out a real wage bill. The setup only works if it stays balanced. One-way arrangements quietly drain whoever owns the company without a reciprocating job.</p>

            <h4>🤝 Buddy pairs</h4>
            <p>Each row is one mutual pair, with both buddies side by side. Each card shows the player's name, wage, and output stats: <span style="color:var(--text)">↗ production</span> (points per work click) and <span style="color:var(--text)">⚡ energy</span> (work clicks available per day).</p>
            <p>A pair is highlighted <span style="color:var(--orange)">orange</span> and a 🔥 warning shows when either:</p>
            <ul>
              <li><strong>Wage gap.</strong> One side pays 2× or more what they receive. Example: A pays B 0.300 and B pays A 0.092 is a 3.3× gap.</li>
              <li><strong>Output gap.</strong> Max daily PP output (production × energy × ~0.343 actions per energy point) differs by 20% or more AND at least 50 PP/day absolute. Catches both big single-stat gaps and modest gaps in both stats that compound. For example, 25↗ 80⚡ (686 PP/day) vs 22↗ 70⚡ (528 PP/day) is a 30% gap. The 0.343 multiplier is empirically calibrated (10%/hour energy regen × ~7 energy per work action).</li>
            </ul>

            <h4>🚪 Outside the buddy system</h4>
            <p>Three sub-buckets:</p>
            <ul>
              <li><strong>Working for an Irish company (asymmetric).</strong> They work at an Irish-owned company but the employer doesn't reciprocate. A player can also appear in buddy pairs if they have a buddy AND a separate one-way job for someone else.</li>
              <li><strong>Working for a non-Irish company.</strong> Worked in the last 7 days but not in any Irish payroll. Inferred from activity, since the API doesn't directly expose who employs them.</li>
              <li><strong>Unemployed.</strong> No current employer. Detected as "hasn't worked in 7d but is still logging in". A player who has an employer but doesn't click work would falsely land here, but if they're not working they're not contributing to anyone anyway, so the bucket is still useful. New accounts (less than 3 days old) and players who haven't logged in for 7+ days are excluded.</li>
            </ul>

            <h4>💡 Recommendations</h4>
            <p>Suggested pairings shown in batches. Click "Show more" at the bottom to load the next batch. Each suggestion carries a coloured tag for its tier:</p>
            <ul>
              <li><strong style="color:#4ade80">Both already in scheme</strong>: both players are currently in an imbalanced pair. They've bought in; they just got matched poorly. One suggestion here fixes two broken pairs at once, so these come first.</li>
              <li><strong style="color:#60a5fa">One already in scheme</strong>: a bought-in player matched with someone unpaired. The bought-in side already understands the system; the new side needs onboarding.</li>
              <li><strong style="color:#8b94a3">Neither in scheme</strong>: two players who haven't joined the buddy system yet (regardless of how long they've been playing the game). Most outreach to set up, but the largest pool of unused production.</li>
            </ul>
            <p>Within each tier, suggestions are ordered by combined daily output, biggest impact first. Players are matched by closest output to keep pairs balanced. Players under 50 PP/day are skipped. Suggestions that would require breaking up an existing pair are clearly marked.</p>
            <p>This is a suggestion list, not an instruction. The MoECON still needs to talk to people and arrange things.</p>
          </div>
        </details>
      </div>
    </div>
  `;

  /* ── Inject controls (refresh + label) into the header ──────── */
  document.getElementById('buddy-controls').innerHTML = `
    <span class="buddy-updated-label" id="buddy-updated-label">Loading…</span>
    <button id="buddy-refresh-btn">↻ Refresh</button>
  `;

  /* ── DOM refs ────────────────────────────────────────────────── */
  const $content   = document.getElementById('buddy-main-content');
  const $updated   = document.getElementById('buddy-updated-label');
  const $refresh   = document.getElementById('buddy-refresh-btn');
  const steps      = makeSteps(document.getElementById('buddy-steps'));
  const setStatus  = makeStatus(document.getElementById('buddy-status'));

  /* ── Player data extraction ──────────────────────────────────── */
  let debugLogged = false;
  function logFirstUser(user) {
    if (debugLogged || !user?.username) return;
    debugLogged = true;
    console.log('[buddy-system] First user object:', user);
    window.__buddyDebug = { user };
  }

  /* Each skill is { level, value, total, … }. We want displayed total. */
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
  function getMaxDailyOutput(user) {
    return Math.round(getProduction(user) * getEnergy(user) * ACTIONS_PER_ENERGY);
  }

  function getLastWorkTs(user) {
    const ts = user?.dates?.lastWorkAt || user?.lastWorkAt;
    if (!ts) return null;
    const d = new Date(ts);
    return isNaN(d) ? null : d;
  }
  function getLastConnectionTs(user) {
    const ts = user?.dates?.lastConnectionAt || user?.lastConnectionAt;
    if (!ts) return null;
    const d = new Date(ts);
    return isNaN(d) ? null : d;
  }
  function getActivityTs(user) {
    return getLastConnectionTs(user) || getLastWorkTs(user);
  }
  function getCreatedAt(user) {
    for (const k of ['createdAt', 'creationDate', 'registeredAt', 'created', 'joinedAt']) {
      const v = user?.[k];
      if (v) {
        const d = new Date(v);
        if (!isNaN(d)) return d;
      }
    }
    return null;
  }
  function isNewPlayer(user) {
    const d = getCreatedAt(user);
    if (!d) return false;
    return (Date.now() - d.getTime()) < CFG.NEW_PLAYER_MS;
  }
  function isActive(user) {
    const d = getActivityTs(user);
    if (!d) return null;
    return (Date.now() - d.getTime()) <= CFG.ACTIVE_MS;
  }
  function getCountry(user) { return user?.country ?? user?.countryId ?? null; }

  /* ── State ───────────────────────────────────────────────────── */
  const state = {
    irishIds:        new Set(),
    users:           new Map(),
    ownerCompanies:  new Map(),
    worksAt:         new Map(),
    pairs:           [],
    asymmetric:      [],
    foreignCompany:  [],
    unemployed:      [],
  };
  let lastUpdatedAt = null;

  /* ── Loaders ─────────────────────────────────────────────────── */
  async function loadIrishCitizens(onProgress) {
    const ids = new Set();
    let cursor; let safety = 0;
    while (safety++ < 200) {
      const input = { countryId: CFG.IRELAND_COUNTRY_ID, limit: PAGE_LIMIT };
      if (cursor) input.cursor = cursor;
      const page = await trpc('user.getUsersByCountry', input, { retry: true, timeoutMs: 20000 });
      const items = page?.items ?? page?.data ?? (Array.isArray(page) ? page : []);
      for (const u of items) {
        if (u?._id) {
          ids.add(u._id);
          state.users.set(u._id, { ...(state.users.get(u._id) || {}), ...u });
        }
      }
      onProgress?.(ids.size);
      const next = page?.nextCursor ?? page?.cursor ?? null;
      if (!next || items.length === 0) break;
      cursor = next;
    }
    return ids;
  }

  async function loadUserLite(ids, onProgress) {
    await mapConcurrent([...ids], async (id) => {
      try {
        const u = await trpc('user.getUserLite', { userId: id }, { timeoutMs: 20000 });
        if (u) {
          const prev = state.users.get(id) || {};
          state.users.set(id, { ...prev, ...u, _id: id });
          logFirstUser(state.users.get(id));
        }
      } catch (e) { /* leave what we have */ }
    }, (done, total) => onProgress?.(done, total));
  }

  async function loadWorkerData(ids, onProgress) {
    await mapConcurrent([...ids], async (id) => {
      try {
        const res = await trpc('worker.getWorkers', { userId: id }, { timeoutMs: 20000 });
        const wpc = res?.workersPerCompany || [];
        if (wpc.length > 0) {
          state.ownerCompanies.set(id, wpc);
          for (const { company, workers } of wpc) {
            for (const w of (workers || [])) {
              if (!state.worksAt.has(w.user)) state.worksAt.set(w.user, new Map());
              state.worksAt.get(w.user).set(id, {
                wage: w.wage,
                companyId: company._id,
              });
            }
          }
        }
      } catch (e) { /* swallow */ }
    }, (done, total) => onProgress?.(done, total));
  }

  /* ── Relations ───────────────────────────────────────────────── */
  function computeRelations() {
    state.pairs = [];
    state.asymmetric = [];
    state.foreignCompany = [];
    state.unemployed = [];

    // 1. Buddy pairs: mutual edges between Irish citizens.
    const seenPair = new Set();
    for (const [ownerId, wpc] of state.ownerCompanies.entries()) {
      for (const { workers } of wpc) {
        for (const w of (workers || [])) {
          if (!state.irishIds.has(w.user)) continue;
          const reverseEdge = state.worksAt.get(ownerId)?.get(w.user);
          if (reverseEdge) {
            const key = [ownerId, w.user].sort().join('|');
            if (!seenPair.has(key)) {
              seenPair.add(key);
              state.pairs.push({
                a: ownerId, b: w.user,
                aWage: reverseEdge.wage, bWage: w.wage,
              });
            }
          }
        }
      }
    }

    // 2. Asymmetric: edges that aren't part of a mutual pair.
    const mutualEdges = new Set();
    for (const p of state.pairs) {
      mutualEdges.add(`${p.a}|${p.b}`);
      mutualEdges.add(`${p.b}|${p.a}`);
    }
    const seenAsym = new Set();
    for (const [ownerId, wpc] of state.ownerCompanies.entries()) {
      for (const { company, workers } of wpc) {
        for (const w of (workers || [])) {
          if (!state.irishIds.has(w.user)) continue;
          if (mutualEdges.has(`${w.user}|${ownerId}`)) continue;
          const key = `${w.user}|${ownerId}|${company._id}`;
          if (seenAsym.has(key)) continue;
          seenAsym.add(key);
          state.asymmetric.push({
            workerId: w.user, employerId: ownerId,
            wage: w.wage,
          });
        }
      }
    }

    // 3. Remaining: foreign-company (recent work, no Irish payroll) or
    //    unemployed (no recent work but still logging in).
    const buddiedIds = new Set();
    for (const p of state.pairs) { buddiedIds.add(p.a); buddiedIds.add(p.b); }
    const accountedFor = new Set([...buddiedIds]);
    for (const a of state.asymmetric) accountedFor.add(a.workerId);

    for (const id of state.irishIds) {
      if (accountedFor.has(id)) continue;
      const u = state.users.get(id);
      const workTs = getLastWorkTs(u);
      const connTs = getLastConnectionTs(u);
      const now = Date.now();

      const workedRecently    = workTs && (now - workTs.getTime()) <= CFG.RECENT_MS;
      const connectedRecently = connTs && (now - connTs.getTime()) <= CFG.RECENT_MS;

      if (workedRecently) {
        state.foreignCompany.push(id);
      } else if (isNewPlayer(u)) {
        continue;
      } else if (connectedRecently) {
        state.unemployed.push(id);
      }
      // Else: not active, silently dropped — MoECON can't act on ghosts.
    }
  }

  /* ── Imbalance flag for pairs ────────────────────────────────── */
  function pairImbalance(pair) {
    const issues = [];
    const ua = state.users.get(pair.a);
    const ub = state.users.get(pair.b);

    // Wage: flag at 2x or more.
    if (pair.aWage != null && pair.bWage != null) {
      const max = Math.max(pair.aWage, pair.bWage);
      const min = Math.min(pair.aWage, pair.bWage);
      if (min > 0 && max / min >= 2.0) {
        issues.push({ kind: 'wage', a: pair.aWage, b: pair.bWage, ratio: max / min });
      } else if (max > 0 && min === 0) {
        issues.push({ kind: 'wage', a: pair.aWage, b: pair.bWage, ratio: Infinity });
      }
    }

    // Output: differs by 20%+ AND at least 50 PP/day absolute.
    const totalA = getMaxDailyOutput(ua);
    const totalB = getMaxDailyOutput(ub);
    if (totalA > 0 || totalB > 0) {
      const max = Math.max(totalA, totalB);
      const min = Math.min(totalA, totalB);
      if (max - min >= 50 && (min === 0 || max / min >= 1.2)) {
        issues.push({
          kind: 'output',
          totalA, totalB,
          ratio: min === 0 ? Infinity : max / min,
        });
      }
    }

    return issues;
  }

  function imbalanceNoteHtml(issues) {
    if (!issues.length) return '';
    const parts = issues.map(i => {
      if (i.kind === 'wage') {
        const ratioStr = Number.isFinite(i.ratio) ? `${i.ratio.toFixed(1)}x` : 'one-sided';
        return `<span><span class="label">Wage gap:</span><span class="val">${i.a.toFixed(3)}</span> vs <span class="val">${i.b.toFixed(3)}</span> (${ratioStr})</span>`;
      }
      if (i.kind === 'output') {
        const pctStr = Number.isFinite(i.ratio) ? `${Math.round((i.ratio - 1) * 100)}%` : 'one-sided';
        return `<span><span class="label">Output gap:</span><span class="val">${i.totalA}</span> vs <span class="val">${i.totalB}</span> PP/day (${pctStr})</span>`;
      }
      return '';
    });
    return `<div class="severe-note">🔥 ${parts.join(' &nbsp;·&nbsp; ')}</div>`;
  }

  /* ── Pairing recommendations ─────────────────────────────────── */
  function suggestPairings() {
    /* Tiered matching:
       T1 — both in a currently imbalanced pair (bought-in but mis-matched).
       T2 — one bought-in, one new recruit.
       T3 — both new recruits.
       Within each tier, sorted by combined daily output (biggest impact). */

    const imbalancedPartner = new Map();  // userId → partner userId
    const boughtInIds       = new Set();  // members of imbalanced pairs
    const balancedMembers   = new Set();  // members of balanced pairs (off-limits)
    for (const p of state.pairs) {
      if (pairImbalance(p).length > 0) {
        imbalancedPartner.set(p.a, p.b);
        imbalancedPartner.set(p.b, p.a);
        boughtInIds.add(p.a);
        boughtInIds.add(p.b);
      } else {
        balancedMembers.add(p.a);
        balancedMembers.add(p.b);
      }
    }

    // Exclude balanced-pair members — re-pairing them would break a good pair.
    const newRecruitIds = new Set();
    const addIfFree = id => { if (!balancedMembers.has(id)) newRecruitIds.add(id); };
    for (const a of state.asymmetric)      addIfFree(a.workerId);
    for (const id of state.foreignCompany) addIfFree(id);
    for (const id of state.unemployed)     addIfFree(id);

    const toEntry      = id => ({ id, output: getMaxDailyOutput(state.users.get(id)) });
    const meaningful   = e  => e.output >= MIN_REC_OUTPUT;
    const byOutputDesc = (x, y) => y.output - x.output;

    const boughtIn    = [...boughtInIds   ].map(toEntry).filter(meaningful).sort(byOutputDesc);
    const newRecruits = [...newRecruitIds ].map(toEntry).filter(meaningful).sort(byOutputDesc);

    const existingKeys = new Set(state.pairs.map(p => [p.a, p.b].sort().join('|')));

    function pairWithin(entries) {
      const used = new Set();
      const matches = [];
      for (let i = 0; i < entries.length; i++) {
        if (used.has(entries[i].id)) continue;
        for (let j = i + 1; j < entries.length; j++) {
          if (used.has(entries[j].id)) continue;
          const key = [entries[i].id, entries[j].id].sort().join('|');
          if (existingKeys.has(key)) continue;
          matches.push({
            a: entries[i].id, b: entries[j].id,
            outputA: entries[i].output, outputB: entries[j].output,
          });
          used.add(entries[i].id);
          used.add(entries[j].id);
          break;
        }
      }
      return { matches, leftover: entries.filter(e => !used.has(e.id)) };
    }

    function pairAcross(arrA, arrB) {
      const usedA = new Set(), usedB = new Set();
      const matches = [];
      for (const ea of arrA) {
        if (usedA.has(ea.id)) continue;
        let best = -1, bestDelta = Infinity;
        for (let j = 0; j < arrB.length; j++) {
          const eb = arrB[j];
          if (usedB.has(eb.id) || eb.id === ea.id) continue;
          const key = [ea.id, eb.id].sort().join('|');
          if (existingKeys.has(key)) continue;
          const delta = Math.abs(ea.output - eb.output);
          if (delta < bestDelta) { bestDelta = delta; best = j; }
        }
        if (best >= 0) {
          const eb = arrB[best];
          matches.push({ a: ea.id, b: eb.id, outputA: ea.output, outputB: eb.output });
          usedA.add(ea.id);
          usedB.add(eb.id);
        }
      }
      return {
        matches,
        leftoverA: arrA.filter(e => !usedA.has(e.id)),
        leftoverB: arrB.filter(e => !usedB.has(e.id)),
      };
    }

    const decorate = (matches, tier, tierLabel) =>
      matches.map(m => ({
        ...m, tier, tierLabel,
        breakupA: imbalancedPartner.get(m.a) || null,
        breakupB: imbalancedPartner.get(m.b) || null,
      }));

    const t1 = pairWithin(boughtIn);
    const t2 = pairAcross(t1.leftover, newRecruits);
    const t3 = pairWithin(t2.leftoverB);

    const all = [
      ...decorate(t1.matches, 1, 'Both already in scheme'),
      ...decorate(t2.matches, 2, 'One already in scheme'),
      ...decorate(t3.matches, 3, 'Neither in scheme'),
    ];

    all.sort((x, y) => {
      if (x.tier !== y.tier) return x.tier - y.tier;
      return (y.outputA + y.outputB) - (x.outputA + x.outputB);
    });

    return all;
  }

  /* ── Rendering ───────────────────────────────────────────────── */
  const userProfileUrl = id => `${GAME_BASE}/user/${id}`;

  function avatarHtml(user) {
    const src = user?.avatarUrl;
    const initial = (user?.username || '?').slice(0, 1).toUpperCase();
    if (src && /^https?:\/\//.test(src)) {
      return `<div class="avatar"><img src="${escapeHtml(src)}" alt="" onerror="this.parentElement.textContent='${escapeHtml(initial)}'"></div>`;
    }
    return `<div class="avatar">${escapeHtml(initial)}</div>`;
  }

  function activityDotHtml(user) {
    const a = isActive(user);
    let cls = '', title = 'No activity data';
    if (a === true)  { cls = 'active'; title = `Active. Last seen ${fmtTimeAgo(getActivityTs(user))}`; }
    if (a === false) { cls = 'stale';  title = `Inactive. Last seen ${fmtTimeAgo(getActivityTs(user))}`; }
    return `<span class="activity-dot ${cls}" title="${escapeHtml(title)}"></span>`;
  }

  function renderPlayer(userId, opts = {}) {
    const u = state.users.get(userId) || { _id: userId, username: '(unknown)' };
    const country = getCountry(u);
    const isIrish = country === CFG.IRELAND_COUNTRY_ID;

    const foreignFlag = (country && !isIrish)
      ? `<span class="foreign-flag" title="Currently a citizen of another country">🌍 abroad</span>`
      : '';

    const meta = [];
    if (opts.wage != null) {
      meta.push(`<span class="stat"><strong>${(+opts.wage).toFixed(3)}</strong> wage</span>`);
    }
    if (opts.showOutput) {
      const prod = getProduction(u);
      const energy = getEnergy(u);
      if (prod > 0 || energy > 0) {
        meta.push(`<span class="stat" title="↗ production points per work · ⚡ energy capacity">↗ <strong>${prod}</strong> &nbsp;⚡ <strong>${energy}</strong></span>`);
      } else {
        meta.push(`<span class="stat dim">no stats data</span>`);
      }
    }
    if (opts.showLastWorked) {
      const workTs = getLastWorkTs(u);
      const connTs = getLastConnectionTs(u);
      const parts = [];
      if (workTs) parts.push(`worked ${fmtTimeAgo(workTs)}`);
      if (connTs && (!workTs || (connTs.getTime() - workTs.getTime()) > 60 * 60 * 1000)) {
        parts.push(`seen ${fmtTimeAgo(connTs)}`);
      }
      if (parts.length === 0) parts.push('never worked');
      meta.push(`<span class="stat" title="Last work · last connection">${parts.join(' · ')}</span>`);
    }
    if (opts.employerNote) meta.push(opts.employerNote);

    return `
      <div class="player">
        ${avatarHtml(u)}
        <div class="body">
          <div class="name-row">
            ${activityDotHtml(u)}
            <a class="name" href="${userProfileUrl(userId)}" target="_blank" rel="noopener" title="Open profile in War Era">${escapeHtml(u.username || userId)} ${LINK_ICON}</a>
            ${foreignFlag}
          </div>
          ${meta.length ? `<div class="meta-row">${meta.join(' · ')}</div>` : ''}
        </div>
      </div>
    `;
  }

  function renderPairs() {
    const $list  = document.getElementById('buddy-pairs-list');
    const $count = document.getElementById('buddy-pairs-count');
    $count.textContent = `· ${state.pairs.length} pair${state.pairs.length === 1 ? '' : 's'}`;

    if (state.pairs.length === 0) {
      $list.innerHTML = `<div class="buddy-empty">No buddy pairs detected yet. Encourage Irish company owners to hire each other.</div>`;
      return;
    }

    // Sort: severe (orange) first, then both-active.
    const ranked = state.pairs.map(p => ({ p, issues: pairImbalance(p) }));
    ranked.sort((x, y) => {
      if ((x.issues.length > 0) !== (y.issues.length > 0)) {
        return y.issues.length - x.issues.length;
      }
      const xa = state.users.get(x.p.a), xb = state.users.get(x.p.b);
      const ya = state.users.get(y.p.a), yb = state.users.get(y.p.b);
      const sx = (isActive(xa) === true ? 1 : 0) + (isActive(xb) === true ? 1 : 0);
      const sy = (isActive(ya) === true ? 1 : 0) + (isActive(yb) === true ? 1 : 0);
      return sy - sx;
    });

    $list.innerHTML = ranked.map(({ p, issues }) => `
      <div class="pair ${issues.length ? 'severe' : ''}">
        <div class="pairs-grid">
          ${renderPlayer(p.a, { wage: p.aWage, showOutput: true })}
          <div class="arrow" title="${issues.length ? 'Massive imbalance' : 'Mutual employment'}">${issues.length ? '🔥' : '⇄'}</div>
          ${renderPlayer(p.b, { wage: p.bWage, showOutput: true })}
        </div>
        ${imbalanceNoteHtml(issues)}
      </div>
    `).join('');
  }

  function renderOutside() {
    const $list  = document.getElementById('buddy-outside-list');
    const $count = document.getElementById('buddy-outside-count');
    const total = state.asymmetric.length + state.foreignCompany.length + state.unemployed.length;
    $count.textContent = `· ${total} player${total === 1 ? '' : 's'}`;

    if (total === 0) {
      $list.innerHTML = `<div class="buddy-empty">Everyone's accounted for. 🎉</div>`;
      return;
    }

    const sortByActivityThenName = (a, b) => {
      const ua = state.users.get(a), ub = state.users.get(b);
      const aA = isActive(ua) === true ? 1 : 0;
      const bA = isActive(ub) === true ? 1 : 0;
      if (aA !== bA) return bA - aA;
      return (ua?.username || '').localeCompare(ub?.username || '');
    };

    const asymBody = state.asymmetric.length === 0
      ? `<div class="buddy-empty" style="font-size:12.5px;padding:14px">None.</div>`
      : `<div class="player-list">${
          state.asymmetric.map(a => {
            const employer = state.users.get(a.employerId);
            const employerName = employer?.username || a.employerId;
            return renderPlayer(a.workerId, {
              wage: a.wage,
              showOutput: true,
              employerNote: `<span class="stat" title="Employer not reciprocating">→ <a href="${userProfileUrl(a.employerId)}" target="_blank" rel="noopener">${escapeHtml(employerName)}</a></span>`,
            });
          }).join('')
        }</div>`;

    const foreignBody = state.foreignCompany.length === 0
      ? `<div class="buddy-empty" style="font-size:12.5px;padding:14px">None.</div>`
      : `<div class="player-list">${
          [...state.foreignCompany].sort(sortByActivityThenName).map(id => renderPlayer(id, { showOutput: true, showLastWorked: true })).join('')
        }</div>`;

    const unemplBody = state.unemployed.length === 0
      ? `<div class="buddy-empty" style="font-size:12.5px;padding:14px">None.</div>`
      : `<div class="player-list">${
          [...state.unemployed].sort(sortByActivityThenName).map(id => renderPlayer(id, { showOutput: true, showLastWorked: true })).join('')
        }</div>`;

    $list.innerHTML = `
      <details class="subsection">
        <summary>
          <span class="chev"></span>
          <span class="subsection-title">Working for an Irish company (asymmetric)</span>
          <span class="count">· ${state.asymmetric.length}</span>
        </summary>
        <div class="subsection-body">
          <p class="subsection-desc">In an Irish-owned company, but the employer isn't reciprocating.</p>
          ${asymBody}
        </div>
      </details>

      <details class="subsection">
        <summary>
          <span class="chev"></span>
          <span class="subsection-title">Working for a non-Irish company</span>
          <span class="count">· ${state.foreignCompany.length}</span>
        </summary>
        <div class="subsection-body">
          <p class="subsection-desc">Worked in the last 7 days but not in any Irish payroll — presumed to be at a non-Irish company.</p>
          ${foreignBody}
        </div>
      </details>

      <details class="subsection">
        <summary>
          <span class="chev"></span>
          <span class="subsection-title">Unemployed</span>
          <span class="count">· ${state.unemployed.length}</span>
        </summary>
        <div class="subsection-body">
          <p class="subsection-desc">No current employer. Detected as "logged in within the last 7 days but didn't click work" — a proxy, since the API doesn't expose a current-employer field. New accounts (under 3 days) and players away for 7+ days are excluded.</p>
          ${unemplBody}
        </div>
      </details>
    `;
  }

  /* Module-level — survives Refresh. If the MoECON has loaded extra
     batches they probably want to stay there rather than be yanked
     back to the first 12. */
  let recsToShow = MAX_RECOMMENDATIONS;

  function renderRecommendations() {
    const $list  = document.getElementById('buddy-recommendations-list');
    const $count = document.getElementById('buddy-recommendations-count');

    const all = suggestPairings();
    $count.textContent = `· ${all.length} suggestion${all.length === 1 ? '' : 's'}`;

    if (all.length === 0) {
      $list.innerHTML = `<div class="buddy-empty">No pairings to suggest. Either everyone's well-matched or the available pool is too small.</div>`;
      return;
    }

    const visible = all.slice(0, recsToShow);

    const TIER_STYLE = {
      1: 'color:#4ade80;background:rgba(74,222,128,0.13);border:1px solid rgba(74,222,128,0.4)',
      2: 'color:#60a5fa;background:rgba(96,165,250,0.12);border:1px solid rgba(96,165,250,0.35)',
      3: 'color:#8b94a3;background:rgba(139,148,163,0.12);border:1px solid rgba(139,148,163,0.3)',
    };
    const BADGE_BASE = 'display:inline-block;padding:1px 7px;border-radius:3px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;vertical-align:middle';

    const cardsHtml = visible.map(s => {
      const max = Math.max(s.outputA, s.outputB);
      const min = Math.min(s.outputA, s.outputB);
      const pctStr = min > 0 ? `${Math.round((max / min - 1) * 100)}%` : 'one-sided';

      const tierBadge = `<span style="${BADGE_BASE};${TIER_STYLE[s.tier] || TIER_STYLE[3]}">${escapeHtml(s.tierLabel)}</span>`;

      const breakupNotes = [];
      if (s.breakupA) {
        const partner = state.users.get(s.breakupA);
        const name = partner?.username || s.breakupA;
        breakupNotes.push(`would break up <span class="who"><a href="${userProfileUrl(s.a)}" target="_blank" rel="noopener">${escapeHtml(state.users.get(s.a)?.username || s.a)}</a></span>'s current pair with <span class="who"><a href="${userProfileUrl(s.breakupA)}" target="_blank" rel="noopener">${escapeHtml(name)}</a></span>`);
      }
      if (s.breakupB) {
        const partner = state.users.get(s.breakupB);
        const name = partner?.username || s.breakupB;
        breakupNotes.push(`would break up <span class="who"><a href="${userProfileUrl(s.b)}" target="_blank" rel="noopener">${escapeHtml(state.users.get(s.b)?.username || s.b)}</a></span>'s current pair with <span class="who"><a href="${userProfileUrl(s.breakupB)}" target="_blank" rel="noopener">${escapeHtml(name)}</a></span>`);
      }
      const breakupHtml = breakupNotes.length
        ? `<div class="rec-breakup">⚠️ ${breakupNotes.join(' &nbsp;·&nbsp; ')}</div>`
        : '';

      return `
        <div class="rec-pair">
          <div class="pairs-grid">
            ${renderPlayer(s.a, { showOutput: true })}
            <div class="arrow" title="Suggested pairing">⇄</div>
            ${renderPlayer(s.b, { showOutput: true })}
          </div>
          <div class="rec-info">${tierBadge} &nbsp;·&nbsp; ≈ <span class="val">${s.outputA}</span> vs <span class="val">${s.outputB}</span> PP/day (${pctStr} gap)</div>
          ${breakupHtml}
        </div>
      `;
    }).join('');

    let loadMoreHtml = '';
    if (all.length > visible.length) {
      const remaining = all.length - visible.length;
      const nextBatch = Math.min(remaining, MAX_RECOMMENDATIONS);
      loadMoreHtml = `
        <div class="load-more-wrap">
          <button id="buddy-load-more-recs">↓ Show ${nextBatch} more</button>
          <div class="load-more-info">${remaining} more suggestion${remaining === 1 ? '' : 's'} available</div>
        </div>
      `;
    }

    $list.innerHTML = cardsHtml + loadMoreHtml;

    const $btn = document.getElementById('buddy-load-more-recs');
    if ($btn) {
      $btn.addEventListener('click', () => {
        recsToShow += MAX_RECOMMENDATIONS;
        renderRecommendations();
      });
    }
  }

  function render() {
    renderPairs();
    renderOutside();
    renderRecommendations();
    $updated.textContent = lastUpdatedAt ? `Updated ${fmtTimeAgo(lastUpdatedAt)}` : 'Loaded';
  }

  /* ── Main load ───────────────────────────────────────────────── */
  async function fullLoad() {
    $refresh.disabled = true;
    steps.reset();
    setStatus('');
    $content.style.display = 'none';
    $updated.textContent = 'Loading…';

    state.irishIds = new Set();
    state.users = new Map();
    state.ownerCompanies = new Map();
    state.worksAt = new Map();
    state.pairs = [];
    state.asymmetric = [];
    state.foreignCompany = [];
    state.unemployed = [];
    debugLogged = false;

    try {
      steps.setStep(1, 'active', { sub: 'Paginating user.getUsersByCountry…' });
      state.irishIds = await loadIrishCitizens(n =>
        steps.setStep(1, 'active', { sub: `${n} citizens found so far…` })
      );
      steps.setStep(1, 'done', { count: `${state.irishIds.size} citizens` });

      steps.setStep(2, 'active', { sub: `0 / ${state.irishIds.size} loaded…` });
      await loadUserLite(state.irishIds, (done, total) =>
        steps.setStep(2, 'active', { sub: `${done} / ${total} loaded…`, count: `${done}/${total}` })
      );
      steps.setStep(2, 'done', { count: `${state.users.size} profiles` });

      steps.setStep(3, 'active', { sub: `0 / ${state.irishIds.size} queried…` });
      await loadWorkerData(state.irishIds, (done, total) =>
        steps.setStep(3, 'active', { sub: `${done} / ${total} queried…`, count: `${done}/${total}` })
      );
      computeRelations();
      steps.setStep(3, 'done', {
        count: `${state.pairs.length} pair${state.pairs.length === 1 ? '' : 's'}, ${state.asymmetric.length} asym, ${state.foreignCompany.length} foreign, ${state.unemployed.length} unemployed`
      });

      lastUpdatedAt = new Date();
      render();
      $content.style.display = '';

      steps.fadeOut();
    } catch (e) {
      console.error(e);
      steps.markActiveAsError(e.message || 'Error');
      const friendly = isTransientError(e)
        ? `Server hiccup (${e.message}). Hit refresh to try again.`
        : `Error: ${e.message}`;
      setStatus(friendly, true);
    } finally {
      $refresh.disabled = false;
    }
  }

  $refresh.addEventListener('click', fullLoad);

  // Tick the "Updated Xm ago" label every 30s, like BO does.
  setInterval(() => {
    if (lastUpdatedAt) $updated.textContent = `Updated ${fmtTimeAgo(lastUpdatedAt)}`;
  }, 30000);

  /* ── Kick off ────────────────────────────────────────────────── */
  fullLoad();
})();