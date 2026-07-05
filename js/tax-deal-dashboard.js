/* ═══════════════════════════════════════════════════════════════════
 *  TAX DEAL DASHBOARD (#tax-deals, link-only, no nav entry)
 *
 *  Generic, config-driven counterpart to #tax-partner. Where #tax-partner
 *  is Ireland-only (one shared data/tax/current_week.json, filtered by a
 *  flat password map), any bilateral deal defined in
 *  data/tax/deal_config.json gets its own daily log at
 *  data/tax/deal_logs/<id>.json (see deal_log.py + tax_engine.py).
 *
 *  Flow: pick the home country -> pick the deal (host country) -> enter
 *  that deal's password -> fetch and render ONLY that deal's log file.
 *  The country/deal list (names only, not their logged data) is public —
 *  the password gate is a UI convenience, not encryption, same documented
 *  model as js/irish-tax-partner.js: this is fully static hosting, so the
 *  log file itself is already fetchable by anyone who knows its URL. The
 *  gate just controls what the UI shows/links to.
 *
 *  Deal creation ("Propose a deal") posts to a repository_dispatch-backed
 *  Worker route, mirroring js/buddy-finder.js's waitlist-update pattern.
 *  Submissions always land disabled — see .github/workflows/
 *  deal-config-submit.yml — a human must flip them on after review.
 * ═══════════════════════════════════════════════════════════════════ */
const TaxDealDashboardTool = (() => {
  const money = (v) => (v == null || !isFinite(v)) ? '–' : v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  const flagOf = (code) => (code && code.length === 2) ? flag(code) : '🏳️';

  // Worker route that fires repository_dispatch (type: deal-config-submit)
  // with the GitHub PAT attached server-side. This route does not exist yet
  // on the warera-proxy Worker — it needs to be added there (mirroring the
  // existing /waitlist-update route) before "Propose a deal" will work.
  const DEAL_SUBMIT_URL = 'https://warera-proxy.r00ted82.workers.dev/deal-config-submit';

  const $gate       = document.getElementById('taxdeals-gate');
  const $gateForm   = document.getElementById('taxdeals-gate-form');
  const $homeSelect = document.getElementById('taxdeals-home-select');
  const $dealSelect = document.getElementById('taxdeals-deal-select');
  const $gatePw     = document.getElementById('taxdeals-gate-pw');
  const $gateError  = document.getElementById('taxdeals-gate-error');
  const $gateBtn    = document.getElementById('taxdeals-gate-submit');
  const $content    = document.getElementById('taxdeals-content');

  const $proposeToggle  = document.getElementById('taxdeals-propose-toggle');
  const $proposeForm    = document.getElementById('taxdeals-propose-form');
  const $proposeStatus  = document.getElementById('taxdeals-propose-status');
  const $proposeSubmit  = document.getElementById('taxdeals-propose-submit');

  let dealConfig = null;   // { version, deals: [...] } — fetched once
  let unlockedDeal = null; // the deal entry (with password) once unlocked

  /* ── One-time CSS (selects/number/date inputs inside .bo-gate-form don't
     get the input[type=password] styling, so match it explicitly) ──── */
  if (!document.getElementById('taxdeals-injected-styles')) {
    const styleEl = document.createElement('style');
    styleEl.id = 'taxdeals-injected-styles';
    styleEl.textContent = `
.bo-gate-form select,
.bo-gate-form input[type="text"],
.bo-gate-form input[type="number"],
.bo-gate-form input[type="date"] {
  width: 100%; text-align: center; font-size: 14px; padding: 10px 12px;
  background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px;
  color: var(--text); font-family: inherit;
}
.bo-gate-form select:disabled { opacity: 0.5; }
.taxdeals-propose { max-width: 420px; margin: 8px auto 24px; text-align: center; }
#taxdeals-propose-form.hidden { display: none; }
.taxdeals-report { background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
  padding: 14px 16px; margin-top: 14px; }
.taxdeals-report pre { font-family: inherit; font-size: 12.5px; white-space: pre-wrap;
  color: var(--text); margin: 0 0 10px; line-height: 1.6; }
.taxdeals-split { display: flex; gap: 10px; }
.taxdeals-split > div { flex: 1; }
`;
    document.head.appendChild(styleEl);
  }

  async function fetchJson(url) {
    try {
      const res = await fetch(`${url}?t=${Math.floor(Date.now() / 30000)}`, { cache: 'no-cache' });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  /* ── Populate the two selects from deal_config.json ─────────────── */
  async function loadDealConfig() {
    if (dealConfig) return dealConfig;
    dealConfig = await fetchJson('data/tax/deal_config.json');
    return dealConfig;
  }

  function enabledDeals() {
    return (dealConfig?.deals || []).filter(d => d.enabled);
  }

  function populateHomeSelect() {
    const homes = new Map(); // code -> name
    for (const d of enabledDeals()) homes.set(d.homeCountry.code, d.homeCountry.name);
    $homeSelect.innerHTML = `<option value="" disabled selected>Home country…</option>` +
      [...homes.entries()]
        .sort((a, b) => a[1].localeCompare(b[1]))
        .map(([code, name]) => `<option value="${escapeHtml(code)}">${flagOf(code)} ${escapeHtml(name)}</option>`)
        .join('');
  }

  function populateDealSelect(homeCode) {
    const deals = enabledDeals().filter(d => d.homeCountry.code === homeCode);
    $dealSelect.disabled = deals.length === 0;
    $dealSelect.innerHTML = `<option value="" disabled selected>Deal…</option>` +
      deals.map(d => `<option value="${escapeHtml(d.id)}">${flagOf(d.hostCountry.code)} ${escapeHtml(d.name)}</option>`).join('');
  }

  $homeSelect.addEventListener('change', () => populateDealSelect($homeSelect.value));

  /* ── Settlement report text (copy-button target) ─────────────────── */
  function periodLabel(weekStart) {
    const start = new Date(`${weekStart}T00:00:00Z`);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 6);
    const fmt = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
    return `${fmt(start)} – ${fmt(end)}`;
  }

  function buildReport(dealLog) {
    const totals = dealLog.current_week?.totals || {};
    const home = dealLog.home_country.name;
    const host = dealLog.host_country.name;
    return [
      `${host} → ${home} Tax Rebate Settlement`,
      `Period: ${periodLabel(dealLog.current_week.week_start)}`,
      '',
      `Gross tax generated: ₿${money(totals.gross_tax)}`,
      `Manual rebate owed to ${home}: ₿${money(totals.manual_rebate_due)}`,
      `Automatic citizenship tax already handled by game: ₿${money(totals.auto_remit_tax)}`,
      `${host} retained: ₿${money(totals.host_retained)}`,
      '',
      `Please transfer: ₿${money(totals.manual_rebate_due)}`,
    ].join('\n');
  }

  /* ── Render ───────────────────────────────────────────────────────── */
  function renderDeal(dealLog) {
    const days = dealLog.current_week?.days || [];
    const today = days.length ? days[days.length - 1].row : null;
    const weekTotals = dealLog.current_week?.totals || {};
    const prevTotals = dealLog.previous_week?.totals || null;
    const report = buildReport(dealLog);

    $content.innerHTML = `
      <div class="tax-src">📅 <span>Showing <strong>${escapeHtml(dealLog.host_country.name)}</strong> → <strong>${escapeHtml(dealLog.home_country.name)}</strong> under deal v${dealLog.deal_version}. Nothing about any other deal is shown here.</span></div>

      <div class="tax-cards">
        <div class="tax-card ok">
          <div class="tax-card-v">₿${money(today?.manual_rebate_due)}</div>
          <div class="tax-card-l">Today's rebate due<span>${days.length ? escapeHtml(days[days.length - 1].date) : 'no data yet'}</span></div>
        </div>
        <div class="tax-card">
          <div class="tax-card-v">₿${money(weekTotals.manual_rebate_due)}</div>
          <div class="tax-card-l">This week's rebate due<span>since ${escapeHtml(dealLog.current_week.week_start)}</span></div>
        </div>
        <div class="tax-card">
          <div class="tax-card-v">${prevTotals ? '₿' + money(prevTotals.manual_rebate_due) : '—'}</div>
          <div class="tax-card-l">Previous week's rebate due<span>${dealLog.previous_week ? escapeHtml(dealLog.previous_week.week_start) : 'no prior week logged'}</span></div>
        </div>
        <div class="tax-card">
          <div class="tax-card-v">₿${money(weekTotals.gross_tax)}</div>
          <div class="tax-card-l">Gross tax generated<span>this week</span></div>
        </div>
        <div class="tax-card">
          <div class="tax-card-v">${today?.workers ?? 0}</div>
          <div class="tax-card-l">Workers<span>${escapeHtml(dealLog.host_country.name)} factories, today</span></div>
        </div>
      </div>

      <div class="taxdeals-split">
        <div class="tax-audit-cat">
          <div class="tax-audit-h">${flagOf(dealLog.home_country.code)} ${escapeHtml(dealLog.home_country.name)} citizens <span class="tax-audit-rate">rebate ${(dealLog.home_citizen_rebate * 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%</span></div>
          <div class="tax-audit-row"><span>Workers</span><b>${today?.home_workers ?? 0}</b></div>
          <div class="tax-audit-row"><span>Gross tax</span><b>₿${money(today?.home_worker_tax)}</b></div>
        </div>
        <div class="tax-audit-cat">
          <div class="tax-audit-h">🌍 Non-${escapeHtml(dealLog.home_country.name)} citizens <span class="tax-audit-rate">rebate ${(dealLog.non_home_citizen_rebate * 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%</span></div>
          <div class="tax-audit-row"><span>Workers</span><b>${today?.partner_workers ?? 0}</b></div>
          <div class="tax-audit-row"><span>Gross tax</span><b>₿${money(today?.partner_worker_tax)}</b></div>
        </div>
      </div>

      <div class="taxdeals-report">
        <pre id="taxdeals-report-text">${escapeHtml(report)}</pre>
        <button id="taxdeals-report-copy" class="btn-primary">Copy settlement report</button>
        <span id="taxdeals-report-copied" class="tax-dim" style="margin-left:8px;"></span>
      </div>`;

    const $copyBtn = document.getElementById('taxdeals-report-copy');
    const $copied = document.getElementById('taxdeals-report-copied');
    $copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(report);
        $copied.textContent = 'Copied!';
      } catch {
        $copied.textContent = 'Copy failed — select the text above manually.';
      }
      setTimeout(() => { $copied.textContent = ''; }, 3000);
    });
  }

  async function renderUnlockedDeal() {
    $content.innerHTML = `<div class="status">Loading…</div>`;
    const dealLog = await fetchJson(`data/tax/deal_logs/${encodeURIComponent(unlockedDeal.id)}.json`);
    if (!dealLog) {
      $content.innerHTML = `<div class="status">No settlement data logged yet for this deal.</div>`;
      return;
    }
    renderDeal(dealLog);
  }

  /* ── Gate ─────────────────────────────────────────────────────────── */
  async function tryUnlock() {
    $gateBtn.disabled = true;
    $gateError.textContent = '';
    const dealId = $dealSelect.value;
    const pw = $gatePw.value;
    const deal = enabledDeals().find(d => d.id === dealId);
    if (!deal || !pw || deal.password !== pw) {
      $gateError.textContent = 'Incorrect selection or password.';
      $gatePw.select();
      $gateBtn.disabled = false;
      return;
    }
    unlockedDeal = deal;
    $gate.style.display = 'none';
    $gateBtn.disabled = false;
    await renderUnlockedDeal();
  }

  $gateForm.addEventListener('submit', (e) => {
    e.preventDefault();
    tryUnlock();
  });

  /* ── Propose a deal ───────────────────────────────────────────────── */
  $proposeToggle.addEventListener('click', () => {
    $proposeForm.classList.toggle('hidden');
  });

  $proposeForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    $proposeSubmit.disabled = true;
    $proposeStatus.textContent = 'Submitting…';
    $proposeStatus.style.color = '';

    const payload = {
      name: document.getElementById('taxdeals-propose-name').value.trim(),
      homeCountryCode: document.getElementById('taxdeals-propose-home').value.trim().toUpperCase(),
      hostCountryCode: document.getElementById('taxdeals-propose-host').value.trim().toUpperCase(),
      homeCitizenRebatePct: Number(document.getElementById('taxdeals-propose-home-rebate').value),
      nonHomeCitizenRebatePct: Number(document.getElementById('taxdeals-propose-non-rebate').value),
      startDate: document.getElementById('taxdeals-propose-start').value,
      password: document.getElementById('taxdeals-propose-password').value,
    };

    try {
      // Flat payload — same convention as js/buddy-finder.js's
      // dispatchWaitlistUpdate(). The Worker wraps this into GitHub's
      // { event_type, client_payload } shape server-side before firing the
      // repository_dispatch; the client never touches that envelope.
      const res = await fetch(DEAL_SUBMIT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      $proposeStatus.style.color = 'var(--accent)';
      $proposeStatus.textContent = 'Submitted — pending manual review before it starts logging.';
      $proposeForm.reset();
    } catch (err) {
      $proposeStatus.textContent = `Could not submit (${err.message}). Try again later.`;
    } finally {
      $proposeSubmit.disabled = false;
    }
  });

  return {
    async activate() {
      await loadDealConfig();
      populateHomeSelect();
      if (unlockedDeal) { renderUnlockedDeal(); return; } // DOM persists across nav; just refresh.
      $gate.style.display = '';
      $dealSelect.innerHTML = `<option value="" disabled selected>Deal…</option>`;
      $dealSelect.disabled = true;
      $gatePw.value = '';
      $gateError.textContent = '';
    },
  };
})();
