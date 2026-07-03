/* ═══════════════════════════════════════════════════════════════════
 *  TAX SETTLEMENT — PARTNER VIEW (#tax-partner, link-only, no nav entry)
 *
 *  Gives each partner country its own password that unlocks ONLY its own
 *  weekly settlement summary, read straight from the already-public
 *  data/tax/current_week.json (the same log the main #tax tool reads).
 *  This is a convenience gate, not encryption — the password just picks
 *  which country's numbers get rendered, it doesn't protect data that
 *  isn't already served to the browser. See js/irish-tax.js for the real
 *  password-gated (AES-GCM) tool.
 *
 *  To add or rotate a partner password:
 *    1. Edit the plaintext map below (search ADD PARTNERS HERE), e.g.
 *         { "yemen1234": "YE", "newpass": "XX" }
 *       Values are the country's ISO 3166-1 alpha-2 code, matching the
 *       "code" field in data/tax/current_week.json's totals entries.
 *    2. Base64-encode the JSON string (e.g. `btoa(JSON.stringify(map))`
 *       in any browser console) and paste the result into
 *       PASSWORD_MAP_B64 below.
 *    No re-encryption or build step needed.
 * ═══════════════════════════════════════════════════════════════════ */
const IrishTaxPartnerTool = (() => {
  // Decoded at runtime to { password: isoCode }. Base64 is a light
  // speed-bump against casual view-source reading, not real security.
  // Source map: { "Cameltoe": "YE" }
  const PASSWORD_MAP_B64 = 'eyJDYW1lbHRvZSI6IllFIn0=';

  let passwordMap = null;
  function getPasswordMap() {
    if (passwordMap) return passwordMap;
    try {
      passwordMap = JSON.parse(atob(PASSWORD_MAP_B64));
    } catch {
      passwordMap = {};
    }
    return passwordMap;
  }

  const $gate      = document.getElementById('taxpartner-gate');
  const $gateForm  = document.getElementById('taxpartner-gate-form');
  const $gatePw    = document.getElementById('taxpartner-gate-pw');
  const $gateError = document.getElementById('taxpartner-gate-error');
  const $gateBtn   = document.getElementById('taxpartner-gate-submit');
  const $content   = document.getElementById('taxpartner-content');

  let unlockedCode = null;

  const money = (v) => (v == null || !isFinite(v)) ? '–' : v.toLocaleString(undefined, { maximumFractionDigits: 2 });

  async function fetchCurrentWeek() {
    try {
      const res = await fetch(`data/tax/current_week.json?t=${Math.floor(Date.now() / 30000)}`, { cache: 'no-cache' });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  async function renderCountry(code) {
    $content.innerHTML = `<div class="status">Loading…</div>`;
    const log = await fetchCurrentWeek();
    const totals = log && log.totals ? Object.values(log.totals) : [];
    const entry = totals.find(c => String(c.code || '').toUpperCase() === code);

    if (!entry) {
      $content.innerHTML = `<div class="status">No settlement data yet this week.</div>`;
      return;
    }

    $content.innerHTML = `
      <div class="tool-header">
        <div class="title-block">
          <h2><span>${flag(entry.code)}</span> ${escapeHtml(entry.name || code)} — Weekly Settlement</h2>
          <p>Week of ${escapeHtml(log.week_start || '–')}</p>
        </div>
      </div>
      <div class="tax-cards">
        <div class="tax-card">
          <div class="tax-card-v">${entry.factories ?? '–'}</div>
          <div class="tax-card-l">Factories</div>
        </div>
        <div class="tax-card">
          <div class="tax-card-v">${entry.workers ?? '–'}</div>
          <div class="tax-card-l">Workers<span>${entry.irish_workers ?? 0} Irish · ${entry.foreign_workers ?? 0} foreign</span></div>
        </div>
        <div class="tax-card">
          <div class="tax-card-v">₿${money(entry.wages)}</div>
          <div class="tax-card-l">Wages paid</div>
        </div>
        <div class="tax-card">
          <div class="tax-card-v">₿${money(entry.tax)}</div>
          <div class="tax-card-l">Gross tax<span>${entry.rate ?? '–'}% rate</span></div>
        </div>
        <div class="tax-card">
          <div class="tax-card-v">₿${money(entry.irish_worker_tax)}</div>
          <div class="tax-card-l">Irish-worker tax</div>
        </div>
        <div class="tax-card">
          <div class="tax-card-v">₿${money(entry.foreign_worker_tax)}</div>
          <div class="tax-card-l">Foreign-worker tax</div>
        </div>
        <div class="tax-card ok">
          <div class="tax-card-v">₿${money(entry.manual_rebate_due)}</div>
          <div class="tax-card-l">Rebate due to Ireland</div>
        </div>
        <div class="tax-card">
          <div class="tax-card-v">₿${money(entry.host_retained)}</div>
          <div class="tax-card-l">Host retained</div>
        </div>
      </div>
    `;
  }

  async function tryUnlock(password) {
    $gateBtn.disabled = true;
    $gateError.textContent = '';
    const code = getPasswordMap()[password];
    if (!code) {
      $gateError.textContent = 'Incorrect password.';
      $gatePw.select();
      $gateBtn.disabled = false;
      return;
    }
    unlockedCode = code;
    $gate.style.display = 'none';
    $gateBtn.disabled = false;
    await renderCountry(code);
  }

  $gateForm.addEventListener('submit', e => {
    e.preventDefault();
    const pw = $gatePw.value;
    if (pw) tryUnlock(pw);
  });

  return {
    activate() {
      if (unlockedCode) { renderCountry(unlockedCode); return; } // DOM persists across nav; just refresh.
      $gate.style.display = '';
      $gatePw.value = '';
      $gateError.textContent = '';
      setTimeout(() => $gatePw.focus(), 50);
    }
  };
})();
