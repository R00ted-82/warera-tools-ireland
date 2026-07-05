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

  // Paper "Send money to country" transfer tax — 50% (paper units) to allies,
  // 100% to everyone else. Mirrors the main tool (js/irish-tax-dev.js).
  const PAPER_RATE = { ally: 0.5, other: 1.0 };
  const AUTO_REMIT = 0.30;

  const money = (v) => (v == null || !isFinite(v)) ? '–' : v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  const flagOf = (code) => (code && code.length === 2) ? flag(code) : '🏳️';
  const it_trpc = (ep, inp) => trpc(ep, inp, { retry: true, timeoutMs: 20000 });

  async function fetchJson(url) {
    try {
      const res = await fetch(`${url}?t=${Math.floor(Date.now() / 30000)}`, { cache: 'no-cache' });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  // Ireland's ally list + current paper market price, for the paper transfer
  // tax. Both are global (not per-country), so they leak nothing about other
  // partners. Best-effort: if the game API is unreachable, the paper block
  // simply shows the units required with no ₿ cost.
  async function loadPaper() {
    const [ie, ob] = await Promise.all([
      it_trpc('country.getCountryById', { countryId: IRELAND_COUNTRY_ID }).catch(() => null),
      it_trpc('tradingOrder.getTopOrders', { itemCode: 'paper' }).catch(() => null),
    ]);
    const allies = new Set(Array.isArray(ie?.allies) ? ie.allies : []);
    let ask = Infinity;
    for (const o of (ob?.sellOrders || [])) if (typeof o.price === 'number' && o.price < ask) ask = o.price;
    return { allies, paperPrice: isFinite(ask) ? ask : null };
  }

  function paperFor(countryId, amount, paper) {
    const ally = paper.allies.has(countryId);
    const rate = ally ? PAPER_RATE.ally : PAPER_RATE.other;
    const units = (amount || 0) * rate;
    const cost = paper.paperPrice != null ? units * paper.paperPrice : null;
    const net = cost != null ? (amount || 0) - cost : null;
    return { ally, rate, units, price: paper.paperPrice, cost, net };
  }

  // The expanded audit panel — identical markup/classes to the main tool's
  // auditHtml() so it renders with the same styling.
  function auditHtml(c, deal, weekRebate, paper) {
    const irishRebate = c.irishWorkerTax * deal.irishRebate;
    const foreignRebate = c.foreignWorkerTax * deal.foreignRebate;
    const pct = (x) => `${(x * 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;

    const pToday = paperFor(c.id, c.rebate, paper);
    const pWeek = weekRebate == null ? null : paperFor(c.id, weekRebate, paper);
    const paperBlock = `
      <div class="tax-audit-tot">
        <div class="tax-audit-h">📄 Paper transfer tax <span class="tax-ally ${pToday.ally ? 'yes' : ''}">${pToday.ally ? 'ally · 50%' : 'non-ally · 100%'}</span></div>
        <div class="tax-audit-row"><span>Paper price</span><b>${pToday.price != null ? '₿' + money(pToday.price) + '/unit' : '—'}</b></div>
        <div class="tax-audit-row big"><span>Net owed today (after paper)</span><b>${pToday.net != null ? '₿' + money(pToday.net) : '—'}</b></div>
        <div class="tax-audit-row"><span>Paper cost (this week)</span><b>${pWeek && pWeek.cost != null ? '−₿' + money(pWeek.cost) : '—'}</b></div>
        <div class="tax-audit-row"><span>Net this week (after paper)</span><b>${pWeek && pWeek.net != null ? '₿' + money(pWeek.net) : '—'}</b></div>
      </div>`;

    return `<div class="tax-audit">
      <div class="tax-audit-grid">
        <div class="tax-audit-cat">
          <div class="tax-audit-h">🇮🇪 Irish workers <span class="tax-audit-rate">rebate ${pct(deal.irishRebate)}</span></div>
          <div class="tax-audit-row"><span>Workers</span><b>${c.irishWorkers}</b></div>
          <div class="tax-audit-row"><span>Gross tax</span><b>₿${money(c.irishWorkerTax)}</b></div>
          <div class="tax-audit-row"><span>Manual rebate</span><b>₿${money(irishRebate)}</b></div>
        </div>
        <div class="tax-audit-cat">
          <div class="tax-audit-h">🌍 Non-Irish workers <span class="tax-audit-rate">rebate ${pct(deal.foreignRebate)}</span></div>
          <div class="tax-audit-row"><span>Workers</span><b>${c.foreignWorkers}</b></div>
          <div class="tax-audit-row"><span>Gross tax</span><b>₿${money(c.foreignWorkerTax)}</b></div>
          <div class="tax-audit-row"><span>Manual rebate</span><b>₿${money(foreignRebate)}</b></div>
        </div>
      </div>
      <div class="tax-audit-tot">
        <div class="tax-audit-row big"><span>Today's settlement owed to Ireland</span><b>₿${money(c.rebate)}</b></div>
        <div class="tax-audit-row big"><span>This week's settlement (logged)</span><b>₿${money(weekRebate)}</b></div>
      </div>
      ${paperBlock}
      <div class="tax-audit-note">Gross tax ₿${money(c.tax)}/day · income-tax rate ${c.rate}% · deals.json v${c.dealVersion}. Excludes the game's automatic 30% remittance (that returns to each worker's own country and is not part of the settlement). Host keeps ≈ ₿${money(c.hostRetained)}/day.</div>
    </div>`;
  }

  async function renderCountry(code) {
    $content.innerHTML = `<div class="status">Loading…</div>`;
    const [log, paper] = await Promise.all([
      fetchJson('data/tax/current_week.json'),
      loadPaper(),
    ]);

    // Latest daily snapshot's row for this country (matches the main table,
    // which renders from the most recent day, not the weekly totals).
    const day = log?.days?.[log.days.length - 1];
    const src = (day?.countries || []).find(c => String(c.code || '').toUpperCase() === code);
    if (!src) {
      $content.innerHTML = `<div class="status">No settlement data yet this week.</div>`;
      return;
    }

    // Rebate rates are baked into the snapshot per-country by tax_log.py, so
    // the partner view never loads the full deals.json (every country's terms).
    const deal = {
      irishRebate: Number(src.irish_rebate || 0),
      foreignRebate: Number(src.foreign_rebate || 0),
    };

    const c = {
      id: src.id, name: src.name, code: src.code, rate: src.rate,
      factories: src.factories || 0, workers: src.workers || 0,
      irishWorkers: src.irish_workers || 0, foreignWorkers: src.foreign_workers || 0,
      tax: src.tax || 0,
      irishWorkerTax: src.irish_worker_tax || 0, foreignWorkerTax: src.foreign_worker_tax || 0,
      rebate: src.manual_rebate_due || 0,
      hostRetained: src.host_retained ?? (src.tax * (1 - AUTO_REMIT) - (src.manual_rebate_due || 0)),
      dealVersion: src.deal_version ?? 0,
    };
    const weekRebate = log?.totals?.[c.id]?.manual_rebate_due;
    const pc = paperFor(c.id, c.rebate, paper);
    const paperCell = pc.cost != null ? `₿${money(pc.cost)}` : `${money(pc.units)}📄`;
    const paperBadge = `<span class="tax-ally ${pc.ally ? 'yes' : ''}">${pc.ally ? 'ally 50%' : '100%'}</span>`;

    $content.innerHTML = `
      <div class="tax-src">📅 <span>Showing the latest daily snapshot (<strong>${escapeHtml(day.date || '—')}</strong>) from the settlement log. Click your country's row for the full audit.</span></div>
      <div class="tax-table-wrap"><table class="tax-tbl">
        <thead><tr>
          <th class="l">Country</th>
          <th>Factories</th>
          <th>Workers</th>
          <th title="Total wage tax generated today by your country's Irish-owned factories">Gross Tax / Day</th>
          <th title="Manual rebate owed to Ireland today under the agreement — excludes the game's automatic 30% remittance">Rebate Today</th>
          <th title="Paper transfer tax on paying today's rebate: 50% (ally) or 100% of the amount, priced at the current market rate">Paper Tax</th>
          <th title="Rebate Today minus the paper transfer cost">Net Owed</th>
          <th title="Settlement accrued so far this week. Resets each Monday.">Settlement This Week</th>
        </tr></thead>
        <tbody>
          <tr class="tax-row open" data-c="${c.id}" title="Click for the settlement audit">
            <td class="l"><span class="tax-caret">▸</span> ${flagOf(c.code)} ${escapeHtml(c.name)}</td>
            <td>${c.factories}</td>
            <td>${c.workers}</td>
            <td>₿${money(c.tax)}</td>
            <td><strong>₿${money(c.rebate)}</strong></td>
            <td>${paperCell} ${paperBadge}</td>
            <td>${pc.net != null ? '₿' + money(pc.net) : '<span class="tax-dim">—</span>'}</td>
            <td>₿${money(weekRebate)}</td>
          </tr>
          <tr class="tax-detail open" data-detail="${c.id}"><td colspan="8">${auditHtml(c, deal, weekRebate, paper)}</td></tr>
        </tbody>
      </table></div>`;

    // Row toggle: collapse/expand the audit, matching the main table.
    const $row = $content.querySelector('.tax-row');
    const $detail = $content.querySelector('.tax-detail');
    $row.addEventListener('click', () => {
      const open = $row.classList.toggle('open');
      $detail.classList.toggle('open', open);
    });
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
