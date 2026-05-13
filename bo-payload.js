/* Battle Orders — encrypted payload source
   ========================================
   Feed THIS into encrypt-bo.html, then paste the encrypted base64 output
   into BO_ENCRYPTED_PAYLOAD in tools.we-ie.com/index.html.

   At decrypt time this runs inside the umbrella page and reuses these
   globals from the umbrella's <script>:
     trpc, escapeHtml, flag, makeSteps, makeStatus, isTransientError
   Anything else is declared locally inside the IIFE. The umbrella also
   provides two empty containers we populate:
     #bo-content    (in the body, will hold the tool UI)
     #bo-controls   (in the tool-header, will hold refresh + label)
*/
(function () {
  'use strict';

  /* ── Local constants ───────────────────────────────────────────── */
  const GAME_BASE  = 'https://app.warera.io';
  const PAGE_LIMIT = 100;
  const CFG = {
    IRELAND_COUNTRY_ID:      '6813b6d446e731854c7ac7fe',
    DISCORD_WORKER_URL:      'https://warera-proxy.toie.workers.dev/notify-discord',
    EXTRA_ALLY_COUNTRY_IDS:  [],
    MU_COUNTRY_FIELDS:       ['countryId', 'country', 'nationalityId', 'nationality'],
    EXCLUDED_MU_IDS:         ['6955c186b1fc6d0b7b00fadc'],
    REQUIRE_IRISH_COUNTRY:   true,
    MIN_IRISH_RATIO:         0.5,
  };

  function fmtTimeAgo(d) {
    if (!d) return '';
    const ms = Date.now() - d.getTime();
    if (ms < 60000)    return 'just now';
    if (ms < 3600000)  return `${Math.floor(ms/60000)}m ago`;
    if (ms < 86400000) return `${Math.floor(ms/3600000)}h ago`;
    return d.toLocaleDateString();
  }

  /* ── Inject BO-specific CSS ────────────────────────────────────── */
  const styleEl = document.createElement('style');
  styleEl.id = 'bo-injected-styles';
  styleEl.textContent = `
.bo-updated-label { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }

.bo-pickers {
  background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
  padding: 16px 18px; margin-bottom: 20px;
}
.bo-picker-head {
  display: flex; align-items: baseline; justify-content: space-between;
  margin-bottom: 12px; flex-wrap: wrap; gap: 8px;
}
.bo-picker-head h3 { margin: 0; font-size: 14px; font-weight: 600; }
.bo-picker-hint { color: var(--muted); font-size: 12px; }

.country-pills { display: flex; flex-wrap: wrap; gap: 6px; }
.country-pill {
  display: inline-flex; align-items: center; gap: 6px;
  background: var(--bg); border: 1px solid var(--border);
  padding: 6px 12px; border-radius: 999px;
  font-size: 13px; cursor: pointer; user-select: none;
  color: var(--text);
  transition: background 0.1s, border-color 0.1s;
}
.country-pill:hover { background: var(--panel-2); border-color: #3a4350; }
.country-pill.selected {
  background: var(--accent-dim); border-color: var(--accent);
  color: var(--accent);
}
.country-pill.own { border-color: rgba(74, 222, 128, 0.55); }
.country-pill.own.selected {
  background: rgba(74, 222, 128, 0.2);
  border-color: var(--accent); color: var(--accent); font-weight: 600;
}
.country-pill.ally { border-color: rgba(74, 222, 128, 0.3); }
.country-pill.ally .ally-mark {
  font-size: 11px; line-height: 1; color: var(--accent); opacity: 0.85; margin-left: 1px;
}
.country-pill.ally:hover .ally-mark,
.country-pill.ally.selected .ally-mark { opacity: 1; }
.country-pill .order-dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--accent); box-shadow: 0 0 0 1.5px var(--bg);
  display: inline-block; flex-shrink: 0; margin-left: 2px;
}
.country-pill.selected .order-dot { box-shadow: 0 0 0 1.5px var(--accent-dim); }
.country-pill .flag { font-size: 14px; line-height: 1; }
.country-pill .battles-count {
  color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums;
}
.country-pill.selected .battles-count { color: inherit; opacity: 0.85; }

.bo-layout {
  display: grid; grid-template-columns: minmax(0, 1fr) 380px;
  gap: 20px; align-items: start;
}
@media (max-width: 1000px) { .bo-layout { grid-template-columns: 1fr; } }
.pane-title {
  display: flex; justify-content: space-between; align-items: baseline;
  margin: 0 0 12px; padding: 0 4px;
}
.pane-title h3 { margin: 0; font-size: 15px; font-weight: 600; }
.pane-title .meta { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }

.battle-list { display: flex; flex-direction: column; gap: 10px; }
.battle {
  background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
  padding: 14px 16px;
  display: flex; gap: 12px; align-items: flex-start;
  transition: border-color 0.15s, background 0.15s, box-shadow 0.15s;
}
.battle:hover { border-color: #3a4350; }
.battle.sel { border-color: var(--accent); background: rgba(74, 222, 128, 0.05); }
.battle-check {
  width: 18px; height: 18px; margin-top: 2px;
  accent-color: var(--accent); cursor: pointer; flex-shrink: 0;
}
.battle-body { flex: 1; min-width: 0; }
.battle-head {
  display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; margin-bottom: 6px;
}
.battle-head .battle-side {
  display: inline-flex; align-items: center; gap: 4px; font-weight: 600;
}
.battle-head .battle-side.atk { color: var(--atk); }
.battle-head .battle-side.def { color: var(--def); }
.battle-head .battle-side.ours::after {
  content: '★'; font-size: 10px; margin-left: 3px;
  color: var(--accent); opacity: 0.9;
}
.battle-head .vs { color: var(--muted); font-size: 12px; margin: 0 2px; }
.battle-head .region { color: var(--muted); font-size: 12px; margin-left: 6px; }
.battle-head .game-link {
  color: var(--muted); margin-left: auto; padding: 2px 4px;
  display: inline-flex; align-items: center; line-height: 0;
}
.battle-head .game-link:hover { color: var(--link); }
.battle-head .game-link svg { width: 14px; height: 14px; }
.battle-stats {
  display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 12.5px; color: var(--muted);
}
.battle-stats .stat-k {
  color: #6b7280; font-size: 11px;
  text-transform: uppercase; letter-spacing: 0.04em; margin-right: 4px;
}
.battle-stats .score { font-variant-numeric: tabular-nums; font-weight: 500; color: var(--text); }
.battle-stats .score .a { color: var(--atk); }
.battle-stats .score .d { color: var(--def); }
.battle-stats .score .sep { color: var(--muted); margin: 0 2px; }

.country-order-row {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  margin-top: 10px; padding: 6px 10px;
  border-radius: 6px;
  background: rgba(74, 222, 128, 0.08);
  border: 1px solid rgba(74, 222, 128, 0.25);
  color: var(--accent); font-size: 12px;
}
.country-order-row .label {
  font-size: 10px; font-weight: 700;
  text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.9;
}
.country-order-row .flag-big { font-size: 14px; }
.country-order-row .side-tag {
  display: inline-block; padding: 1px 5px;
  background: rgba(74, 222, 128, 0.18); color: var(--accent);
  font-size: 10px; font-weight: 600;
  letter-spacing: 0.02em; border-radius: 3px;
  text-transform: uppercase;
}

.mu-strip {
  display: flex; gap: 4px; flex-wrap: wrap;
  margin-top: 10px; padding-top: 10px;
  border-top: 1px dashed var(--border);
}
.mu-strip-item {
  position: relative;
  width: 24px; height: 24px; border-radius: 50%; overflow: hidden;
  display: inline-flex; flex-shrink: 0;
  border: 1.5px solid var(--border); background: var(--panel-2);
  transition: opacity 0.15s, filter 0.15s, border-color 0.15s, transform 0.1s;
  cursor: help;
}
.mu-strip-item:hover { transform: scale(1.15); z-index: 1; }
.mu-strip-item .initial {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  font-size: 10px; font-weight: 700; color: var(--muted);
}
.mu-strip-item img {
  position: relative; z-index: 1;
  width: 100%; height: 100%; object-fit: cover;
}
.mu-strip-item.has {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px rgba(74, 222, 128, 0.25);
  opacity: 1;
}
.mu-strip-item.has .initial { color: var(--accent); }
.mu-strip-item.none {
  border-color: var(--danger);
  box-shadow: 0 0 0 1px rgba(248, 113, 113, 0.2);
  opacity: 0.35; filter: grayscale(100%);
}
.mu-strip-item.none:hover { opacity: 0.95; }
.mu-strip-item.none .initial { color: var(--danger); }

.bo-empty {
  padding: 40px 16px; text-align: center; color: var(--muted);
  background: var(--panel); border: 1px dashed var(--border); border-radius: 10px;
}

.compliance {
  background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
  padding: 14px 16px;
  position: sticky; top: 12px;
  max-height: calc(100vh - 24px); overflow-y: auto;
}
@media (max-width: 1000px) { .compliance { position: static; max-height: none; } }
.compliance-summary {
  font-size: 12px; color: var(--muted); margin-bottom: 10px;
  padding-bottom: 10px; border-bottom: 1px solid var(--border); line-height: 1.5;
}
.compliance-summary strong { color: var(--text); }
.mu-row { padding: 8px 0; border-top: 1px solid var(--border); font-size: 13px; }
.mu-row:first-of-type { border-top: none; }
.mu-row.missing { background: rgba(248, 113, 113, 0.04); }
.mu-row-head { display: flex; align-items: center; gap: 6px; font-weight: 500; }
.mu-row .status-icon { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
.mu-row.has .status-icon { background: var(--accent); }
.mu-row.missing .status-icon { background: var(--danger); }
.mu-row .mu-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mu-row .game-link { color: var(--muted); padding: 2px; display: inline-flex; align-items: center; line-height: 0; }
.mu-row .game-link:hover { color: var(--link); }
.mu-row .game-link svg { width: 12px; height: 12px; }
.mu-row .orders-list {
  margin: 4px 0 0 14px; font-size: 12px; color: var(--muted);
  display: flex; flex-direction: column; gap: 2px;
}
.mu-row .orders-list a { color: var(--muted); }
.mu-row .orders-list a:hover { color: var(--link); }
.mu-row .orders-list .side-tag {
  display: inline-block; padding: 0 5px;
  border-radius: 3px; font-size: 10px;
  font-weight: 600; letter-spacing: 0.02em;
  text-transform: uppercase; margin-right: 4px;
}
.mu-row .side-tag.atk { background: rgba(244, 164, 143, 0.15); color: var(--atk); }
.mu-row .side-tag.def { background: rgba(155, 193, 238, 0.15); color: var(--def); }
.mu-row .no-orders { color: var(--danger); font-style: italic; }

/* details.howto extensions (umbrella defines the base, BO needs h4/p/ol/strong/marker-demo) */
details.howto h4 {
  margin: 14px 0 6px; color: var(--text); font-size: 13px; font-weight: 600;
}
details.howto h4:first-child { margin-top: 0; }
details.howto p { margin: 0 0 8px; }
details.howto ol { margin: 0 0 8px; padding-left: 22px; }
details.howto ol li { margin-bottom: 4px; }
details.howto strong { color: var(--text); font-weight: 600; }
details.howto .marker-demo {
  display: inline-block;
  width: 10px; height: 10px; border-radius: 50%;
  border: 1.5px solid; vertical-align: middle; margin-right: 3px;
}
details.howto .marker-demo.green { border-color: var(--accent); background: rgba(74,222,128,0.15); }
details.howto .marker-demo.red   { border-color: var(--danger); background: rgba(248,113,113,0.15); }

textarea#bo-msg {
  background: var(--bg); color: var(--text); border: 1px solid var(--border);
  padding: 10px 12px; border-radius: 6px; font-size: 13px;
  font-family: ui-monospace, SFMono-Regular, monospace;
  width: 100%; resize: vertical; line-height: 1.5;
  min-height: 280px;
}
textarea#bo-msg:focus { outline: none; border-color: #3a4350; }

/* Action bar: sits inside the BO view, so display:none on view hides it. */
.action-bar {
  position: fixed; bottom: 0; left: 0; right: 0;
  background: var(--panel); border-top: 1px solid var(--border);
  padding: 12px 32px; z-index: 5;
}
.action-bar-inner {
  max-width: 1500px; margin: 0 auto;
  display: flex; gap: 12px; align-items: center;
}
.action-bar .count { color: var(--muted); font-size: 13px; flex: 1; }
.action-bar .count strong { color: var(--text); }
/* Give the body bottom padding when BO is active so the bar doesn't cover content. */
body:has(.view[data-view="battle-orders"].active) main { padding-bottom: 80px; }

.bo-modal {
  position: fixed; inset: 0; background: rgba(0,0,0,0.75);
  display: none; align-items: center; justify-content: center;
  padding: 16px; z-index: 20;
}
.bo-modal.show { display: flex; }
.bo-modal-card {
  background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
  max-width: 640px; width: 100%; max-height: 85vh; overflow-y: auto;
  padding: 18px 20px;
}
.bo-modal-card h3 { margin: 0 0 4px; font-size: 16px; font-weight: 600; }
.bo-modal-card .desc { color: var(--muted); font-size: 13px; margin-bottom: 12px; line-height: 1.5; }
.bo-modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px; flex-wrap: wrap; }

@media (max-width: 720px) {
  .action-bar { padding: 10px 20px; }
  .action-bar-inner { flex-wrap: wrap; }
  .action-bar .count { width: 100%; }
}
`;
  document.head.appendChild(styleEl);

  /* ── Inject HTML into #bo-content ──────────────────────────────── */
  document.getElementById('bo-content').innerHTML = `
    <div id="bo-steps" class="steps hidden">
      <div class="step" data-state="pending" data-step="1">
        <div class="step-icon"></div>
        <div class="step-body">
          <div class="step-title">Loading battles &amp; reference data</div>
          <div class="step-sub"></div>
        </div>
        <div class="step-count"></div>
      </div>
      <div class="step" data-state="pending" data-step="2">
        <div class="step-icon"></div>
        <div class="step-body">
          <div class="step-title">Finding Irish citizens</div>
          <div class="step-sub"></div>
        </div>
        <div class="step-count"></div>
      </div>
      <div class="step" data-state="pending" data-step="3">
        <div class="step-icon"></div>
        <div class="step-body">
          <div class="step-title">Filtering Irish MUs</div>
          <div class="step-sub"></div>
        </div>
        <div class="step-count"></div>
      </div>
    </div>
    <div id="bo-status" class="status hidden"></div>

    <div id="bo-main-content" style="display:none">
      <div class="bo-pickers" id="bo-picker-panel">
        <div class="bo-picker-head">
          <h3>Countries currently at war</h3>
          <span class="bo-picker-hint">Click pills to choose which countries' battles to see</span>
        </div>
        <div id="bo-country-pills" class="country-pills"></div>
      </div>

      <div class="bo-layout">
        <section>
          <div class="pane-title">
            <h3>Battles <span style="color:var(--muted);font-weight:400">(filtered)</span></h3>
            <span class="meta" id="bo-battles-meta"></span>
          </div>
          <div id="bo-battle-list" class="battle-list"></div>
        </section>
        <aside class="compliance" id="bo-compliance">
          <div class="pane-title">
            <h3>Current Irish MU battle orders</h3>
            <span class="meta" id="bo-compliance-meta"></span>
          </div>
          <div class="compliance-summary" id="bo-compliance-summary"></div>
          <div id="bo-compliance-list"></div>
        </aside>
      </div>

      <details class="howto">
        <summary>How this works · what the markers mean</summary>
        <div class="howto-body">
          <h4>What this tool is for</h4>
          <p>A live tracker for active War Era battles, built for the Irish Minister of Defense. Pick which countries' battles to view, scan who's already set orders, then ping the MU commanders who haven't via Discord.</p>

          <h4>Country picker</h4>
          <ul>
            <li>Lists every country currently involved in an active battle. Click pills to toggle which countries' battles you want to see.</li>
            <li><strong>🇮🇪 Ireland</strong> appears with a green-tinted pill.</li>
            <li><strong>★ Allies</strong> are countries Ireland has an active alliance with, pulled from the in-game data. They're marked with a star.</li>
            <li>A small green dot on a country pill means Ireland has set a country-level order on a battle involving that country.</li>
          </ul>

          <h4>Battle cards</h4>
          <ul>
            <li><strong>Country order row:</strong> a green-bordered row inside a card means Ireland's government has set a country-level battle order on this battle. The President has officially marked it as a national priority, and Irish MUs should be there.</li>
            <li><strong>Score</strong> is rounds won, best of N. <strong>Round</strong> is the current round number.</li>
            <li><strong>Irish MU strip</strong> sits below the stats: every Irish MU as a small circle, alphabetically ordered so the same MU sits in the same column across every card.
              <ul>
                <li><span class="marker-demo green"></span> <strong>Green circle:</strong> this MU has orders on this battle.</li>
                <li><span class="marker-demo red"></span> <strong>Red circle:</strong> no orders on this battle.</li>
                <li>Hover any circle for the MU name and status.</li>
              </ul>
            </li>
          </ul>

          <h4>Compliance panel (right side)</h4>
          <p>Every Irish MU listed with the battles they currently have orders on. MUs with no active orders anywhere are listed first and red-dotted: that's the "people to chase" list.</p>

          <h4>Pushing orders to Discord</h4>
          <ol>
            <li>Pick countries from the picker above.</li>
            <li>Tick the checkboxes on battles you want orders set on.</li>
            <li>Click <strong>Compose orders request</strong> at the bottom of the page. A Discord message preview opens.</li>
            <li><strong>Copy</strong> and paste into Discord, or click <strong>Send to Discord</strong> to post it directly.</li>
          </ol>

          <h4>Refresh</h4>
          <p>Data doesn't auto-refresh. Hit <strong>↻ Refresh</strong> to re-pull battles, citizens, and the MU roster.</p>
        </div>
      </details>
    </div>

    <div class="action-bar">
      <div class="action-bar-inner">
        <div class="count" id="bo-count"><strong>0</strong> battles selected</div>
        <button id="bo-clear-btn">Clear</button>
        <button id="bo-compose-btn" class="btn-primary" disabled>Compose orders request</button>
      </div>
    </div>

    <div id="bo-modal" class="bo-modal">
      <div class="bo-modal-card">
        <h3>Battle orders request</h3>
        <p class="desc">Preview the Discord message. Edit if needed, then copy or send.</p>
        <textarea id="bo-msg" spellcheck="false"></textarea>
        <div class="bo-modal-actions">
          <button id="bo-cancel-btn">Cancel</button>
          <button id="bo-copy-btn">Copy</button>
          <button id="bo-send-btn" class="btn-primary" disabled title="Configure DISCORD_WORKER_URL">Send to Discord</button>
        </div>
      </div>
    </div>
  `;

  /* ── Inject controls (refresh + updated label) into the header ── */
  document.getElementById('bo-controls').innerHTML = `
    <span class="bo-updated-label" id="bo-updated-label">Loading…</span>
    <button id="bo-refresh-btn">↻ Refresh</button>
  `;

  /* ── BattleTool ───────────────────────────────────────────────── */
  const $mainContent    = document.getElementById('bo-main-content');
  const $pills          = document.getElementById('bo-country-pills');
  const $list           = document.getElementById('bo-battle-list');
  const $complianceList = document.getElementById('bo-compliance-list');
  const $complianceMeta = document.getElementById('bo-compliance-meta');
  const $complianceSum  = document.getElementById('bo-compliance-summary');
  const $battlesMeta    = document.getElementById('bo-battles-meta');
  const $count          = document.getElementById('bo-count');
  const $composeBtn     = document.getElementById('bo-compose-btn');
  const $clearBtn       = document.getElementById('bo-clear-btn');
  const $refreshBtn     = document.getElementById('bo-refresh-btn');
  const $updatedLabel   = document.getElementById('bo-updated-label');
  const $modal          = document.getElementById('bo-modal');
  const $msg            = document.getElementById('bo-msg');
  const $cancelBtn      = document.getElementById('bo-cancel-btn');
  const $copyBtn        = document.getElementById('bo-copy-btn');
  const $sendBtn        = document.getElementById('bo-send-btn');
  const steps     = makeSteps(document.getElementById('bo-steps'));
  const setStatus = makeStatus(document.getElementById('bo-status'));

  // State
  let battles = [];
  let countriesById = {};
  let regionsById = {};
  let irishMUs = [];
  let irishCitizens = new Set();
  let officialAllies = new Set();
  let lastUpdatedAt = null;
  let selectedCountries = new Set();
  let selectedBattles = new Set();
  let refreshInFlight = false;

  // MU accessors
  const muIdOf       = m => m?._id ?? null;
  const muNameOf     = m => m?.name ?? '(no name)';
  const muOwnerOf    = m => m?.user ?? null;
  const muMembersOf  = m => Array.isArray(m?.members) ? m.members : null;
  const muMemberIdOf = u => typeof u === 'string' ? u : (u?._id ?? null);
  function muCountryOf(mu) {
    for (const f of CFG.MU_COUNTRY_FIELDS) {
      if (mu?.[f] != null) return mu[f];
    }
    return null;
  }
  function countIrishMembers(mu) {
    const members = muMembersOf(mu) || [];
    return members.filter(u => irishCitizens.has(muMemberIdOf(u))).length;
  }

  function ourCountryIds() {
    const ids = new Set([CFG.IRELAND_COUNTRY_ID]);
    for (const id of officialAllies) ids.add(id);
    for (const id of CFG.EXTRA_ALLY_COUNTRY_IDS) ids.add(id);
    return ids;
  }
  function ourSidesOf(b) {
    const ours = ourCountryIds();
    const sides = [];
    if (ours.has(b.attacker?.country)) sides.push('attacker');
    if (ours.has(b.defender?.country)) sides.push('defender');
    return sides;
  }
  function irelandCountryOrderSides(b) {
    const sides = [];
    if ((b.attacker?.countryOrders || []).includes(CFG.IRELAND_COUNTRY_ID)) sides.push('attacker');
    if ((b.defender?.countryOrders || []).includes(CFG.IRELAND_COUNTRY_ID)) sides.push('defender');
    return sides;
  }

  // Loaders
  async function loadBattlesAndRefs() {
    const [battlesRes, countriesRes, regionsRes] = await Promise.all([
      trpc('battle.getBattles', { isActive: true, limit: PAGE_LIMIT }, { retry: true, timeoutMs: 20000 }),
      trpc('country.getAllCountries', {}, { retry: true, timeoutMs: 20000 }),
      trpc('region.getRegionsObject', {}, { retry: true, timeoutMs: 20000 }),
    ]);
    battles = battlesRes?.items ?? (Array.isArray(battlesRes) ? battlesRes : []);
    const countryArr = Array.isArray(countriesRes) ? countriesRes : (countriesRes?.items ?? []);
    countriesById = {};
    for (const c of countryArr) if (c?._id) countriesById[c._id] = c;
    regionsById = (regionsRes && typeof regionsRes === 'object' && !Array.isArray(regionsRes))
      ? regionsRes : {};
    const ireland = countriesById[CFG.IRELAND_COUNTRY_ID];
    officialAllies = new Set(Array.isArray(ireland?.allies) ? ireland.allies : []);
    lastUpdatedAt = new Date();
  }

  async function loadAllMUs(onProgress) {
    const out = []; const seen = new Set();
    let cursor; let safety = 0;
    while (safety++ < 200) {
      const input = { limit: PAGE_LIMIT };
      if (cursor) input.cursor = cursor;
      const page = await trpc('mu.getManyPaginated', input, { retry: true, timeoutMs: 20000 });
      const items = page?.items ?? page?.data ?? (Array.isArray(page) ? page : []);
      let added = 0;
      for (const item of items) {
        const id = muIdOf(item);
        if (id && !seen.has(id)) { seen.add(id); out.push(item); added++; }
      }
      const next = page?.nextCursor ?? page?.cursor ?? null;
      if (!next || items.length === 0 || added === 0) break;
      cursor = next;
      onProgress?.(out.length);
    }
    return out;
  }

  async function loadIrishCitizens(onProgress) {
    const ids = new Set();
    let cursor; let safety = 0;
    while (safety++ < 200) {
      const input = { countryId: CFG.IRELAND_COUNTRY_ID, limit: PAGE_LIMIT };
      if (cursor) input.cursor = cursor;
      const page = await trpc('user.getUsersByCountry', input, { retry: true, timeoutMs: 20000 });
      const items = page?.items ?? page?.data ?? (Array.isArray(page) ? page : []);
      for (const u of items) if (u?._id) ids.add(u._id);
      onProgress?.(ids.size);
      const next = page?.nextCursor ?? page?.cursor ?? null;
      if (!next || items.length === 0) break;
      cursor = next;
    }
    return ids;
  }

  function computeIrishMUs(allMUs) {
    let dropC = 0, dropM = 0, dropX = 0;
    const ownerIrish = allMUs.filter(mu => irishCitizens.has(muOwnerOf(mu)));
    const kept = ownerIrish.filter(mu => {
      if (CFG.EXCLUDED_MU_IDS.includes(muIdOf(mu))) { dropX++; return false; }
      if (CFG.REQUIRE_IRISH_COUNTRY) {
        const c = muCountryOf(mu);
        if (c != null && c !== CFG.IRELAND_COUNTRY_ID) { dropC++; return false; }
      }
      const members = muMembersOf(mu) || [];
      if (members.length > 0) {
        const ratio = countIrishMembers(mu) / members.length;
        if (ratio < CFG.MIN_IRISH_RATIO) { dropM++; return false; }
      }
      return true;
    });
    console.log(`[bo-filter] ${allMUs.length} total, ${ownerIrish.length} Irish-owned, ${kept.length} kept (dropped ${dropC} foreign, ${dropM} non-Irish member majority, ${dropX} blacklisted)`);
    return kept;
  }

  async function reloadRoster() {
    const newCitizens = await loadIrishCitizens();
    const allMUs = await loadAllMUs();
    irishCitizens = newCitizens;
    irishMUs = computeIrishMUs(allMUs);
    irishMUs.sort((a, b) => muNameOf(a).localeCompare(muNameOf(b)));
  }

  function involvedCountryIdsWithCounts() {
    const counts = new Map();
    for (const b of battles) {
      for (const id of [b.attacker?.country, b.defender?.country]) {
        if (!id) continue;
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
    return counts;
  }

  function filteredBattles() {
    if (selectedCountries.size === 0) return [];
    return battles.filter(b =>
      selectedCountries.has(b.attacker?.country) ||
      selectedCountries.has(b.defender?.country)
    );
  }

  function ordersByMU() {
    const map = new Map();
    for (const mu of irishMUs) {
      const muId = muIdOf(mu);
      const matches = [];
      for (const b of battles) {
        if (b.attacker?.muOrders?.includes(muId)) matches.push({ battle: b, side: 'attacker' });
        if (b.defender?.muOrders?.includes(muId)) matches.push({ battle: b, side: 'defender' });
      }
      map.set(muId, matches);
    }
    return map;
  }

  // Render helpers
  function countryName(id) {
    if (!id) return '???';
    const c = countriesById[id];
    return c?.name ?? c?.code ?? id.slice(-6);
  }
  function countryCode(id) { return countriesById[id]?.code; }
  function regionName(id) {
    if (!id) return null;
    return regionsById[id]?.name ?? null;
  }

  const EXT_LINK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>`;

  function renderPills() {
    const counts = involvedCountryIdsWithCounts();
    const ids = [...counts.keys()];
    const own = CFG.IRELAND_COUNTRY_ID;
    const ours = ourCountryIds();
    ids.sort((a, b) => {
      if (a === own) return -1;
      if (b === own) return 1;
      const aA = ours.has(a), bA = ours.has(b);
      if (aA && !bA) return -1;
      if (!aA && bA) return 1;
      return countryName(a).localeCompare(countryName(b));
    });
    if (!ids.length) {
      $pills.innerHTML = '<span style="color:var(--muted);font-size:13px">No active battles right now.</span>';
      return;
    }
    $pills.innerHTML = ids.map(id => {
      const sel = selectedCountries.has(id);
      const isOwn = id === own;
      const isAlly = !isOwn && officialAllies.has(id);
      // Dot only on the country whose side Ireland is officially backing.
      const hasIreOrder = battles.some(b => {
        const irl = CFG.IRELAND_COUNTRY_ID;
        return (b.attacker?.country === id && (b.attacker?.countryOrders || []).includes(irl))
            || (b.defender?.country === id && (b.defender?.countryOrders || []).includes(irl));
      });
      return `<span class="country-pill ${sel ? 'selected' : ''} ${isOwn ? 'own' : ''} ${isAlly ? 'ally' : ''}" data-id="${id}">
        <span class="flag">${flag(countryCode(id))}</span>
        <span>${escapeHtml(countryName(id))}</span>
        ${isAlly ? '<span class="ally-mark" title="Official ally of Ireland. Click to include their battles.">★</span>' : ''}
        <span class="battles-count">${counts.get(id)}</span>
        ${hasIreOrder ? '<span class="order-dot" title="Ireland has a country-level order on a battle here"></span>' : ''}
      </span>`;
    }).join('');
    $pills.querySelectorAll('.country-pill').forEach(p => {
      p.onclick = () => {
        const id = p.dataset.id;
        if (selectedCountries.has(id)) selectedCountries.delete(id);
        else selectedCountries.add(id);
        renderPills(); renderBattles();
      };
    });
  }

  function renderBattle(b) {
    const id = b._id;
    const a = b.attacker || {};
    const d = b.defender || {};
    const aName = countryName(a.country);
    const dName = countryName(d.country);
    const aCode = countryCode(a.country);
    const dCode = countryCode(d.country);
    const ours = ourSidesOf(b);
    const aOurs = ours.includes('attacker') ? 'ours' : '';
    const dOurs = ours.includes('defender') ? 'ours' : '';
    const region = regionName(d.region);
    const sel = selectedBattles.has(id);
    const aScore = a.wonRoundsCount ?? 0;
    const dScore = d.wonRoundsCount ?? 0;
    const toWin = b.roundsToWin ?? '?';
    const totalRoundsSoFar = Array.isArray(b.rounds) ? b.rounds.length : null;

    const irelandSides = irelandCountryOrderSides(b);
    const hasCountryOrder = irelandSides.length > 0;
    const countryOrderRow = hasCountryOrder
      ? `<div class="country-order-row" title="Ireland's government has set a country-level order on this battle.">
          <span class="flag-big">🇮🇪</span>
          <span class="label">Country order</span>
          <span>Ireland is officially backing this battle</span>
          ${irelandSides.map(s => `<span class="side-tag">${s === 'attacker' ? 'attacker side' : 'defender side'}</span>`).join('')}
        </div>`
      : '';

    return `<label class="battle ${sel ? 'sel' : ''}">
      <input type="checkbox" class="battle-check" data-id="${id}" ${sel ? 'checked' : ''}>
      <div class="battle-body">
        <div class="battle-head">
          <span class="battle-side atk ${aOurs}"><span class="flag">${flag(aCode)}</span>${escapeHtml(aName)}</span>
          <span class="vs">vs</span>
          <span class="battle-side def ${dOurs}"><span class="flag">${flag(dCode)}</span>${escapeHtml(dName)}</span>
          ${region ? `<span class="region">${escapeHtml(region)}</span>` : ''}
          <a class="game-link" href="${GAME_BASE}/battle/${id}" target="_blank" rel="noopener" title="Open in War Era" onclick="event.stopPropagation()">${EXT_LINK}</a>
        </div>
        <div class="battle-stats">
          <span><span class="stat-k">Score</span><span class="score"><span class="a">${aScore}</span><span class="sep">·</span><span class="d">${dScore}</span></span> <span style="color:var(--muted);font-size:11px">(best of ${(toWin * 2) - 1})</span></span>
          ${totalRoundsSoFar != null ? `<span><span class="stat-k">Round</span>${totalRoundsSoFar}</span>` : ''}
          ${b.type ? `<span><span class="stat-k">Type</span>${escapeHtml(b.type)}</span>` : ''}
        </div>
        ${countryOrderRow}
        ${renderMUStrip(b)}
      </div>
    </label>`;
  }

  function renderMUStrip(b) {
    if (irishMUs.length === 0) return '';
    const orderedIds = new Set([
      ...(b.attacker?.muOrders || []),
      ...(b.defender?.muOrders || []),
    ]);
    return `<div class="mu-strip">${irishMUs.map(mu => {
      const muId = muIdOf(mu);
      const muName = muNameOf(mu);
      const has = orderedIds.has(muId);
      const avatar = mu.avatarUrl;
      const initial = escapeHtml((muName.slice(0,1) || '?').toUpperCase());
      const tooltip = `${muName}: ${has ? '✓ orders set' : 'no orders'}`;
      const img = avatar && /^https?:\/\//.test(avatar)
        ? `<img src="${escapeHtml(avatar)}" alt="" loading="lazy" onerror="this.remove()">`
        : '';
      return `<span class="mu-strip-item ${has ? 'has' : 'none'}" title="${escapeHtml(tooltip)}"><span class="initial">${initial}</span>${img}</span>`;
    }).join('')}</div>`;
  }

  function renderBattles() {
    const list = filteredBattles();
    if (selectedCountries.size === 0) {
      $list.innerHTML = `<div class="bo-empty">Pick at least one country above to see battles.</div>`;
      $battlesMeta.textContent = `${battles.length} active total`;
      return;
    }
    if (list.length === 0) {
      $list.innerHTML = `<div class="bo-empty">No active battles for the selected countries.</div>`;
      $battlesMeta.textContent = `0 of ${battles.length}`;
      return;
    }
    // Ireland-priority first, then "ours" battles, then by MU order count.
    list.sort((a, b) => {
      const aCo = irelandCountryOrderSides(a).length > 0 ? 1 : 0;
      const bCo = irelandCountryOrderSides(b).length > 0 ? 1 : 0;
      if (aCo !== bCo) return bCo - aCo;
      const aOurs = ourSidesOf(a).length > 0 ? 1 : 0;
      const bOurs = ourSidesOf(b).length > 0 ? 1 : 0;
      if (aOurs !== bOurs) return bOurs - aOurs;
      const aMu = (a.attacker?.muOrders?.length || 0) + (a.defender?.muOrders?.length || 0);
      const bMu = (b.attacker?.muOrders?.length || 0) + (b.defender?.muOrders?.length || 0);
      return bMu - aMu;
    });
    $list.innerHTML = list.map(renderBattle).join('');
    $battlesMeta.textContent = `${list.length} of ${battles.length}`;
    $list.querySelectorAll('.battle-check').forEach(cb => {
      cb.onchange = () => {
        const id = cb.dataset.id;
        if (cb.checked) selectedBattles.add(id); else selectedBattles.delete(id);
        cb.closest('.battle').classList.toggle('sel', cb.checked);
        renderBar();
      };
      cb.onclick = e => e.stopPropagation();
    });
  }

  function renderCompliance() {
    if (!irishMUs.length) {
      $complianceMeta.textContent = '';
      $complianceSum.innerHTML = '';
      $complianceList.innerHTML = '<div class="bo-empty" style="padding:24px 12px;font-size:12px">No Irish MUs found.</div>';
      return;
    }
    const orders = ordersByMU();
    const withOrders = irishMUs.filter(m => (orders.get(muIdOf(m)) || []).length > 0);
    const without    = irishMUs.filter(m => (orders.get(muIdOf(m)) || []).length === 0);
    $complianceMeta.textContent = `${withOrders.length} / ${irishMUs.length}`;
    $complianceSum.innerHTML = `<strong>${withOrders.length}</strong> of <strong>${irishMUs.length}</strong> Irish MUs have orders set on at least one active battle.`;

    const rows = [...without, ...withOrders];
    $complianceList.innerHTML = rows.map(mu => {
      const muId = muIdOf(mu);
      const muName = muNameOf(mu);
      const muUrl = `${GAME_BASE}/mu/${muId}`;
      const matches = orders.get(muId) || [];
      const hasOrders = matches.length > 0;
      const bodyHtml = hasOrders
        ? `<div class="orders-list">${matches.map(({ battle, side }) => {
            const aN = countryName(battle.attacker?.country);
            const dN = countryName(battle.defender?.country);
            const reg = regionName(battle.defender?.region);
            const title = `${aN} vs ${dN}${reg ? `, ${reg}` : ''}`;
            return `<a href="${GAME_BASE}/battle/${battle._id}" target="_blank" rel="noopener" title="${escapeHtml(title)}">
              <span class="side-tag ${side === 'attacker' ? 'atk' : 'def'}">${side === 'attacker' ? 'ATK' : 'DEF'}</span>
              ${escapeHtml(side === 'attacker' ? dN : aN)}${reg ? ` <span style="opacity:0.7">· ${escapeHtml(reg)}</span>` : ''}
            </a>`;
          }).join('')}</div>`
        : `<div class="orders-list"><span class="no-orders">No orders set on any active battle</span></div>`;
      return `<div class="mu-row ${hasOrders ? 'has' : 'missing'}">
        <div class="mu-row-head">
          <span class="status-icon"></span>
          <span class="mu-name">${escapeHtml(muName)}</span>
          <a class="game-link" href="${muUrl}" target="_blank" rel="noopener" title="Open MU">${EXT_LINK}</a>
        </div>
        ${bodyHtml}
      </div>`;
    }).join('');
  }

  function renderBar() {
    const n = selectedBattles.size;
    $count.innerHTML = `<strong>${n}</strong> battle${n === 1 ? '' : 's'} selected`;
    $composeBtn.disabled = n === 0;
  }
  function renderAll() {
    renderPills(); renderBattles(); renderCompliance(); renderBar();
    if (lastUpdatedAt) $updatedLabel.textContent = `Updated ${fmtTimeAgo(lastUpdatedAt)}`;
  }

  function composeMessage() {
    const sections = ['⚔️ **🇮🇪 Battle orders requested. Commanders please post orders in-game:**'];
    for (const id of selectedBattles) {
      const b = battles.find(x => x._id === id);
      if (!b) continue;
      const aN  = countryName(b.attacker?.country);
      const dN  = countryName(b.defender?.country);
      const reg = regionName(b.defender?.region);
      const aS  = b.attacker?.wonRoundsCount ?? 0;
      const dS  = b.defender?.wonRoundsCount ?? 0;
      const round = Array.isArray(b.rounds) ? `R${b.rounds.length} ` : '';
      const irlSides = irelandCountryOrderSides(b);
      const tag = irlSides.length > 0 ? ' · 🇮🇪 country order' : '';
      const url = `${GAME_BASE}/battle/${b._id}`;
      const title = `${aN} vs ${dN}${reg ? ` · ${reg}` : ''}`;
      sections.push(
        `⚔️ **[${title}](${url})**\n` +
        `${round}${aS}-${dS}${tag}`
      );
    }
    // \u200b survives Discord's whitespace trim.
    return sections.join('\n\n') + '\n\u200b';
  }

  async function fullLoad() {
    steps.reset();
    setStatus('');
    $refreshBtn.disabled = true;

    try {
      steps.setStep(1, 'active', { sub: 'Fetching active battles, countries, regions' });
      await loadBattlesAndRefs();
      steps.setStep(1, 'done', { count: `${battles.length} battles` });

      steps.setStep(2, 'active', { sub: 'Paginating Irish citizens' });
      irishCitizens = await loadIrishCitizens(n =>
        steps.setStep(2, 'active', { sub: `${n} citizens so far…` })
      );
      steps.setStep(2, 'done', { count: `${irishCitizens.size} citizens` });

      steps.setStep(3, 'active', { sub: 'Loading MU roster' });
      const allMUs = await loadAllMUs(n =>
        steps.setStep(3, 'active', { sub: `${n} MUs loaded…` })
      );
      irishMUs = computeIrishMUs(allMUs);
      irishMUs.sort((a, b) => muNameOf(a).localeCompare(muNameOf(b)));
      steps.setStep(3, 'done', { count: `${irishMUs.length} Irish MUs` });

      renderAll();
      $mainContent.style.display = '';
      steps.fadeOut();
    } catch (e) {
      console.error(e);
      const friendly = isTransientError(e)
        ? `Server hiccup (${e.message}). Hit refresh to try again.`
        : `Error: ${e.message}`;
      setStatus(friendly, true);
    } finally {
      $refreshBtn.disabled = false;
    }
  }

  // Manual refresh: battles + roster. No auto-refresh.
  async function manualRefresh() {
    if (refreshInFlight) return;
    refreshInFlight = true;
    $refreshBtn.disabled = true;
    try {
      await loadBattlesAndRefs();
      renderAll();
      await reloadRoster();
      renderAll();
    } catch (e) {
      console.warn('refresh failed:', e);
    } finally {
      refreshInFlight = false;
      $refreshBtn.disabled = false;
    }
  }

  /* ── Wiring ───────────────────────────────────────────────────── */
  $refreshBtn.onclick = manualRefresh;
  $clearBtn.onclick = () => {
    selectedBattles = new Set();
    $list.querySelectorAll('.battle-check').forEach(cb => {
      cb.checked = false;
      cb.closest('.battle').classList.remove('sel');
    });
    renderBar();
  };
  $composeBtn.onclick = () => {
    $msg.value = composeMessage();
    $modal.classList.add('show');
    if (CFG.DISCORD_WORKER_URL) {
      $sendBtn.disabled = false;
      $sendBtn.removeAttribute('title');
    } else {
      $sendBtn.disabled = true;
      $sendBtn.title = 'Configure DISCORD_WORKER_URL';
    }
  };
  $cancelBtn.onclick = () => $modal.classList.remove('show');
  $copyBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText($msg.value);
      const old = $copyBtn.textContent;
      $copyBtn.textContent = 'Copied ✓';
      setTimeout(() => $copyBtn.textContent = old, 1500);
    } catch {
      $msg.select(); document.execCommand('copy');
    }
  };
  $sendBtn.onclick = async () => {
    if (!CFG.DISCORD_WORKER_URL) { alert('DISCORD_WORKER_URL not set in payload.'); return; }
    const old = $sendBtn.textContent;
    $sendBtn.disabled = true; $sendBtn.textContent = 'Sending…';
    try {
      const r = await fetch(CFG.DISCORD_WORKER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: $msg.value }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      $sendBtn.textContent = 'Sent ✓';
      setTimeout(() => { $modal.classList.remove('show'); $sendBtn.textContent = old; }, 800);
    } catch (e) {
      alert('Send failed: ' + e.message);
      $sendBtn.textContent = old; $sendBtn.disabled = false;
    }
  };
  $modal.addEventListener('click', e => {
    if (e.target === $modal) $modal.classList.remove('show');
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') $modal.classList.remove('show');
  });

  // Tick the "Updated Xm ago" label every 30s.
  setInterval(() => {
    if (lastUpdatedAt) $updatedLabel.textContent = `Updated ${fmtTimeAgo(lastUpdatedAt)}`;
  }, 30000);

  /* ── Kick off ─────────────────────────────────────────────────── */
  fullLoad();
})();