/* ═══════════════════════════════════════════════════════════════════
 *  IRELAND DONATION DRAW  (#donation-draw)
 *
 *  Loads money donations to Ireland for a precise half-open period,
 *  resolves current citizenship, and draws uniformly from unique eligible
 *  donors. Public transactions and per-filter winner history are cached in
 *  versioned localStorage; every load still starts with a freshness request.
 * ═══════════════════════════════════════════════════════════════════ */
const IrelandDonationDrawTool = (() => {
  const DAY_MS = 86_400_000;
  const MAX_LOOKBACK_MS = 31 * DAY_MS;
  const DEFAULT_LOOKBACK_MS = 7 * DAY_MS;
  const PROFILE_STALE_MS = 60_000;
  const PROFILE_BATCH_SIZE = 20;
  const PAGE_LIMIT = 100;
  const MAX_PAGES = 500;
  const CACHE_KEY = 'ireland-donation-draw:transactions:v1';
  const DRAW_PREFIX = 'ireland-donation-draw:draw:v1:';
  const CACHE_VERSION = 1;
  const DRAW_VERSION = 1;

  const $form = document.getElementById('idd-period-form');
  const $start = document.getElementById('idd-start');
  const $end = document.getElementById('idd-end');
  const $minimum = document.getElementById('idd-minimum');
  const $timezone = document.getElementById('idd-timezone');
  const $refresh = document.getElementById('idd-refresh');
  const $copy = document.getElementById('idd-copy');
  const $reset = document.getElementById('idd-reset');
  const $roll = document.getElementById('idd-roll');
  const $status = document.getElementById('idd-status');
  const $warning = document.getElementById('idd-warning');
  const $results = document.getElementById('idd-results');
  const $summary = document.getElementById('idd-summary');
  const $winner = document.getElementById('idd-winner');
  const $historyPanel = document.getElementById('idd-history-panel');
  const $history = document.getElementById('idd-history');
  const $search = document.getElementById('idd-search');
  const $showIneligible = document.getElementById('idd-show-ineligible');
  const $tableBody = document.getElementById('idd-table-body');
  const $table = document.querySelector('.idd-table');
  const steps = makeSteps(document.getElementById('idd-steps'));
  const setStatus = makeStatus($status);

  const initialEndMs = Math.floor(Date.now() / 1000) * 1000;
  const defaultConfig = () => makeConfig(
    initialEndMs - DEFAULT_LOOKBACK_MS,
    initialEndMs,
    1,
  );

  let listenersBound = false;
  let loadPromise = null;
  let pendingLoad = null;
  let requestedConfigKey = null;
  let directionAccepted = true;
  let currentConfig = null;
  let transactions = [];
  let donors = [];
  let winners = [];
  let warnings = [];
  let dataComplete = false;
  let eligibilityComplete = false;
  let profileCheckedAt = 0;
  let sortKey = 'total';
  let sortDirection = 'desc';
  const expanded = new Set();
  // Names are stable display data and can be reused during this page session.
  // Citizenship is deliberately never stored here; every load refreshes the
  // authoritative Irish roster before eligibility is calculated.
  const usernameById = new Map();

  function makeConfig(startMs, endMs, minimum) {
    const min = Number(Number(minimum).toFixed(8));
    return {
      startMs,
      endMs,
      minimum: min,
      startIso: new Date(startMs).toISOString(),
      endIso: new Date(endMs).toISOString(),
      minimumText: String(min),
    };
  }

  function validateConfig(startMs, endMs, minimum, nowMs = Date.now()) {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      return 'Start and end must both be valid date-times.';
    }
    if (!Number.isFinite(minimum) || minimum < 1) {
      return 'Minimum aggregate donation must be at least ₿1.';
    }
    if (startMs >= endMs) return 'Start must be earlier than end.';
    if (endMs > nowMs) return 'End cannot be in the future.';
    if (startMs < nowMs - MAX_LOOKBACK_MS) {
      return 'Start cannot be more than 31 days ago.';
    }
    return null;
  }

  function configFromParams(params) {
    const fallback = defaultConfig();
    const rawStart = params.get('start');
    const rawEnd = params.get('end');
    const rawMin = params.get('min');
    const startMs = rawStart == null ? fallback.startMs : Date.parse(rawStart);
    const endMs = rawEnd == null ? fallback.endMs : Date.parse(rawEnd);
    const minimum = rawMin == null ? fallback.minimum : Number(rawMin);
    const error = validateConfig(startMs, endMs, minimum);
    return error ? { error } : { config: makeConfig(startMs, endMs, minimum) };
  }

  function configKey(config) {
    return `${config.startIso}|${config.endIso}|${config.minimumText}`;
  }

  function drawStorageKey(config) {
    return DRAW_PREFIX + encodeURIComponent(configKey(config));
  }

  function writeConfigHash(config) {
    const params = new URLSearchParams({
      start: config.startIso,
      end: config.endIso,
      min: config.minimumText,
    });
    const hash = `#donation-draw?${params.toString()}`;
    if (location.hash !== hash) {
      history.replaceState(null, '', `${location.pathname}${location.search}${hash}`);
    }
  }

  function toLocalInput(ms) {
    const d = new Date(ms);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
      `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function setControls(config) {
    $start.value = toLocalInput(config.startMs);
    $end.value = toLocalInput(config.endMs);
    $minimum.value = config.minimumText;
  }

  function timezoneLabel() {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Local time';
    let offset = '';
    try {
      const part = new Intl.DateTimeFormat(undefined, { timeZoneName: 'longOffset' })
        .formatToParts(new Date()).find(p => p.type === 'timeZoneName');
      offset = part?.value ? `, ${part.value}` : '';
    } catch { /* older browsers can omit longOffset */ }
    return `Times shown in your local timezone: ${zone}${offset}. The start is included; the end is excluded.`;
  }

  function pageItems(page) {
    return page?.items ?? page?.data ?? (Array.isArray(page) ? page : []);
  }

  function normalizeTransaction(raw) {
    if (!raw || typeof raw !== 'object' || typeof raw._id !== 'string' || !raw._id) return null;
    const timestamp = Date.parse(raw.createdAt);
    if (!Number.isFinite(timestamp)) return null;
    const numericMoney = Number(raw.money);
    return {
      id: raw._id,
      transactionType: typeof raw.transactionType === 'string' ? raw.transactionType : '',
      sellerCountryId: typeof raw.sellerCountryId === 'string' ? raw.sellerCountryId : '',
      buyerId: typeof raw.buyerId === 'string' ? raw.buyerId : '',
      money: Number.isFinite(numericMoney) ? numericMoney : null,
      createdAt: new Date(timestamp).toISOString(),
      itemCode: typeof raw.itemCode === 'string' ? raw.itemCode : '',
      hasQuantity: raw.quantity != null,
    };
  }

  function validStoredTransaction(tx) {
    return tx && typeof tx === 'object' && typeof tx.id === 'string' && tx.id &&
      typeof tx.createdAt === 'string' && Number.isFinite(Date.parse(tx.createdAt)) &&
      typeof tx.transactionType === 'string' && typeof tx.sellerCountryId === 'string' &&
      typeof tx.buyerId === 'string' && (tx.money == null || Number.isFinite(tx.money)) &&
      typeof tx.itemCode === 'string' && typeof tx.hasQuantity === 'boolean';
  }

  function readTransactionCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return { transactions: [], coveredStart: null, warnings: [] };
      const parsed = JSON.parse(raw);
      if (parsed?.version !== CACHE_VERSION || !Array.isArray(parsed.transactions) ||
          !parsed.transactions.every(validStoredTransaction) ||
          !(parsed.coveredStart == null || Number.isFinite(parsed.coveredStart))) {
        return {
          transactions: [], coveredStart: null,
          warnings: ['The saved transaction cache was corrupt or from an unsupported version. It was ignored.'],
        };
      }
      return { transactions: parsed.transactions, coveredStart: parsed.coveredStart, warnings: [] };
    } catch {
      return {
        transactions: [], coveredStart: null,
        warnings: ['Browser storage is unavailable, so transaction caching and persistence may not work.'],
      };
    }
  }

  function writeTransactionCache(items, coveredStart, warningList) {
    const boundary = Date.now() - MAX_LOOKBACK_MS;
    const retained = items.filter(tx => Date.parse(tx.createdAt) >= boundary);
    const safeCoverage = coveredStart == null ? null : Math.max(coveredStart, boundary);
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({
        version: CACHE_VERSION,
        coveredStart: safeCoverage,
        transactions: retained,
      }));
    } catch {
      warningList.push('The refreshed transaction cache could not be saved in this browser.');
    }
    return retained;
  }

  async function fetchTransactionPage(input) {
    const opts = { retry: true, timeoutMs: 25_000, fresh: true };
    if (directionAccepted) {
      try {
        return await trpc('transaction.getPaginatedTransactions', { ...input, direction: 'forward' }, opts);
      } catch (error) {
        if (error?.status !== 400 && !/direction/i.test(String(error?.message || ''))) throw error;
        directionAccepted = false;
      }
    }
    return trpc('transaction.getPaginatedTransactions', input, opts);
  }

  async function syncTransactions(config, cached) {
    const merged = new Map(cached.transactions.map(tx => [tx.id, tx]));
    const cachedIds = new Set(merged.keys());
    const cacheCoversStart = cached.coveredStart != null && cached.coveredStart <= config.startMs;
    const syncWarnings = [...cached.warnings];
    const seenCursors = new Set();
    let cursor = null;
    let pages = 0;
    let added = 0;
    let coveredStart = cached.coveredStart;
    let complete = true;
    let malformedRelevant = 0;

    while (pages < MAX_PAGES) {
      const input = {
        countryId: IRELAND_COUNTRY_ID,
        transactionType: 'donation',
        limit: PAGE_LIMIT,
      };
      if (cursor) input.cursor = cursor;

      let page;
      try {
        page = await fetchTransactionPage(input);
      } catch (error) {
        complete = false;
        syncWarnings.push(isTransientError(error)
          ? 'A transaction page could not be loaded because the data server is temporarily unavailable. The draw is disabled until Refresh succeeds.'
          : `A required transaction page failed (${error.message}). The draw is disabled until Refresh succeeds.`);
        break;
      }

      pages++;
      const rawItems = pageItems(page);
      let pageOldest = Infinity;
      let overlapsCache = false;
      for (const raw of rawItems) {
        const tx = normalizeTransaction(raw);
        if (!tx) {
          if (raw?.transactionType === 'donation' && raw?.sellerCountryId === IRELAND_COUNTRY_ID) {
            malformedRelevant++;
          }
          continue;
        }
        const timestamp = Date.parse(tx.createdAt);
        pageOldest = Math.min(pageOldest, timestamp);
        if (cachedIds.has(tx.id)) overlapsCache = true;
        if (!merged.has(tx.id)) added++;
        merged.set(tx.id, tx);
      }

      steps.setStep(2, 'active', {
        sub: `${pages} page${pages === 1 ? '' : 's'} checked`,
        count: `${added} new`,
      });

      const next = page?.nextCursor ?? page?.cursor ?? null;
      if (overlapsCache && cacheCoversStart) break;
      if (pageOldest < config.startMs) {
        coveredStart = coveredStart == null ? pageOldest : Math.min(coveredStart, pageOldest);
        break;
      }
      if (!next || rawItems.length === 0) {
        coveredStart = Date.now() - MAX_LOOKBACK_MS;
        break;
      }
      if (seenCursors.has(next)) {
        complete = false;
        syncWarnings.push('Transaction pagination repeated a cursor. The draw is disabled to avoid using an incomplete list.');
        break;
      }
      seenCursors.add(next);
      cursor = next;
    }

    if (pages >= MAX_PAGES) {
      complete = false;
      syncWarnings.push('The transaction page safety limit was reached. The draw is disabled to avoid using an incomplete list.');
    }
    if (malformedRelevant) {
      complete = false;
      syncWarnings.push(`${malformedRelevant} donation record${malformedRelevant === 1 ? '' : 's'} had no usable ID or timestamp and could not be audited. The draw is disabled.`);
    }

    const saved = writeTransactionCache([...merged.values()], coveredStart, syncWarnings);
    return { transactions: saved, complete, pages, added, warnings: syncWarnings };
  }

  // Donation records use misleading trade-side field names. The live game UI
  // confirms that buyerId is the donating USER and sellerCountryId is the
  // recipient COUNTRY for transactionType=donation. Do not reverse this flow.
  function isIrelandDonation(tx) {
    return tx.transactionType === 'donation' &&
      tx.sellerCountryId === IRELAND_COUNTRY_ID &&
      Boolean(tx.buyerId) &&
      Number(tx.money) > 0;
  }

  function isNonMoneyDonationShape(tx) {
    return tx.transactionType === 'donation' &&
      tx.sellerCountryId === IRELAND_COUNTRY_ID &&
      (!(Number(tx.money) > 0) || Boolean(tx.itemCode) || tx.hasQuantity);
  }

  function aggregateDonations(items, config) {
    const byUser = new Map();
    let nonMoneyCount = 0;
    for (const tx of items) {
      const timestamp = Date.parse(tx.createdAt);
      if (timestamp < config.startMs || timestamp >= config.endMs) continue;
      if (isNonMoneyDonationShape(tx)) {
        nonMoneyCount++;
        continue;
      }
      if (!isIrelandDonation(tx)) continue;
      let donor = byUser.get(tx.buyerId);
      if (!donor) {
        donor = {
          id: tx.buyerId,
          username: usernameById.get(tx.buyerId) || null,
          total: 0,
          count: 0,
          firstAt: timestamp,
          latestAt: timestamp,
          transactions: [],
          resolved: false,
          isIrish: false,
        };
        byUser.set(tx.buyerId, donor);
      }
      donor.total = Math.round((donor.total + Number(tx.money)) * 1e8) / 1e8;
      donor.count++;
      donor.firstAt = Math.min(donor.firstAt, timestamp);
      donor.latestAt = Math.max(donor.latestAt, timestamp);
      donor.transactions.push({ id: tx.id, amount: Number(tx.money), timestamp });
    }
    for (const donor of byUser.values()) {
      donor.transactions.sort((a, b) => a.timestamp - b.timestamp);
    }
    return { donors: [...byUser.values()], nonMoneyCount };
  }

  function countryIdOf(profile) {
    const value = profile?.countryId ?? profile?.country;
    return typeof value === 'string' ? value : value?._id ?? null;
  }

  async function fetchLiteProfiles(donorList) {
    const profiles = new Map();
    const chunks = [];
    for (let start = 0; start < donorList.length; start += PROFILE_BATCH_SIZE) {
      chunks.push(donorList.slice(start, start + PROFILE_BATCH_SIZE));
    }
    const results = await Promise.all(chunks.map(async batch => {
      let settled;
      try {
        settled = await trpc('user.getUserLite',
          batch.map(donor => ({ userId: donor.id })),
          { batch: true, retry: true, timeoutMs: 30_000, fresh: true });
      } catch {
        settled = batch.map(() => ({ status: 'rejected' }));
      }
      return { batch, settled };
    }));
    for (const { batch, settled } of results) {
      settled.forEach((result, index) => {
        const profile = result.status === 'fulfilled' ? result.value : null;
        if (profile?._id === batch[index].id) profiles.set(batch[index].id, profile);
      });
    }
    return profiles;
  }

  async function resolveProfiles(donorList) {
    // getUsersByCountry omits users whose profile has isActive=false, even
    // when their current country is still Ireland. Absence from that listing
    // is therefore not evidence of non-citizenship. The donor's own current
    // profile is the authority, fetched in HTTP batches to protect the Worker
    // request budget.
    const liteById = await fetchLiteProfiles(donorList);

    let unresolved = 0;
    for (const donor of donorList) {
      const lite = liteById.get(donor.id);
      const username = typeof lite?.username === 'string' && lite.username.trim()
        ? lite.username.trim() : donor.username;
      const countryId = countryIdOf(lite);
      donor.username = username;
      if (username) usernameById.set(donor.id, username);
      donor.resolved = Boolean(username && countryId);
      donor.isIrish = donor.resolved && countryId === IRELAND_COUNTRY_ID;
      if (!donor.resolved) unresolved++;
    }

    const profileWarnings = [];
    if (unresolved) {
      profileWarnings.push(`${unresolved} donor profile${unresolved === 1 ? '' : 's'} or citizenship record could not be resolved. Rolling is disabled.`);
    }
    return { complete: unresolved === 0, unresolved, warnings: profileWarnings };
  }

  function validWinner(winner) {
    return winner && typeof winner === 'object' && typeof winner.userId === 'string' && winner.userId &&
      typeof winner.username === 'string' && Number.isFinite(winner.total) &&
      typeof winner.selectedAt === 'string' && Number.isFinite(Date.parse(winner.selectedAt));
  }

  function readWinners(config, warningList) {
    try {
      const raw = localStorage.getItem(drawStorageKey(config));
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (parsed?.version !== DRAW_VERSION || !Array.isArray(parsed.winners) ||
          !parsed.winners.every(validWinner)) {
        warningList.push('Saved winner history for this period was corrupt or unsupported and was ignored.');
        return [];
      }
      const seen = new Set();
      return parsed.winners.filter(winner => !seen.has(winner.userId) && seen.add(winner.userId));
    } catch {
      warningList.push('Winner history could not be read from browser storage.');
      return [];
    }
  }

  function writeWinners(config, warningList) {
    try {
      localStorage.setItem(drawStorageKey(config), JSON.stringify({
        version: DRAW_VERSION,
        winners,
      }));
      return true;
    } catch {
      warningList.push('Winner history could not be saved. It will last only until this page is reloaded.');
      return false;
    }
  }

  function winnerIds() {
    return new Set(winners.map(winner => winner.userId));
  }

  function ineligibilityReasons(donor, config = currentConfig) {
    const reasons = [];
    if (donor.total < config.minimum) reasons.push('Below minimum');
    if (donor.resolved && !donor.isIrish) reasons.push('Not currently Irish');
    if (winnerIds().has(donor.id)) reasons.push('Already selected');
    if (!donor.resolved) reasons.push('Unresolved profile');
    return reasons;
  }

  function isEligible(donor) {
    return ineligibilityReasons(donor).length === 0;
  }

  function qualifiesBeforeWinnerHistory(donor) {
    return donor.resolved && donor.isIrish && donor.total >= currentConfig.minimum;
  }

  function money(value) {
    return `₿${Number(value).toLocaleString(undefined, { maximumFractionDigits: 8 })}`;
  }

  function localDate(ms) {
    return new Date(ms).toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  }

  function periodText(config) {
    return `${localDate(config.startMs)} (inclusive) → ${localDate(config.endMs)} (exclusive)`;
  }

  function userName(donor) {
    return donor.username || `Unresolved user ${donor.id.slice(0, 8)}…`;
  }

  function sortedVisibleDonors() {
    const query = $search.value.trim().toLocaleLowerCase();
    const visible = donors.filter(donor => {
      // Unresolved donors remain visible even in the default eligible-only
      // view: hiding them would make the condition blocking the draw easy to
      // miss. Other ineligible rows follow the operator's toggle.
      if (!$showIneligible.checked && donor.resolved && !isEligible(donor)) return false;
      return !query || userName(donor).toLocaleLowerCase().includes(query);
    });
    const direction = sortDirection === 'asc' ? 1 : -1;
    return visible.sort((a, b) => {
      let comparison;
      if (sortKey === 'username') {
        comparison = userName(a).localeCompare(userName(b), undefined, { sensitivity: 'base' });
      } else {
        comparison = Number(a[sortKey]) - Number(b[sortKey]);
      }
      return comparison === 0 ? userName(a).localeCompare(userName(b)) : comparison * direction;
    });
  }

  function renderSummary() {
    const total = donors.reduce((sum, donor) => sum + donor.total, 0);
    const eligible = donors.filter(isEligible).length;
    const unresolved = donors.filter(donor => !donor.resolved).length;
    const excluded = donors.length - eligible;
    $summary.innerHTML = [
      ['Donated in period', money(total)],
      ['Unique donors', donors.length.toLocaleString()],
      ['Eligible donors', eligible.toLocaleString()],
      ['Excluded / unresolved', `${excluded.toLocaleString()} / ${unresolved.toLocaleString()}`],
    ].map(([label, value]) =>
      `<div class="idd-summary-card"><div class="k">${escapeHtml(label)}</div><div class="v">${escapeHtml(value)}</div></div>`
    ).join('');
  }

  function renderHistory() {
    if (!winners.length) {
      $historyPanel.classList.add('hidden');
      $history.innerHTML = '';
      return;
    }
    $historyPanel.classList.remove('hidden');
    $history.innerHTML = winners.map(winner =>
      `<li><a href="${GAME_BASE}/user/${encodeURIComponent(winner.userId)}" target="_blank" rel="noopener">${escapeHtml(winner.username)}</a>` +
      ` — ${escapeHtml(money(winner.total))} <span>(${escapeHtml(localDate(Date.parse(winner.selectedAt)))})</span></li>`
    ).join('');
  }

  function renderSortHeaders() {
    for (const button of $table.querySelectorAll('[data-idd-sort]')) {
      const active = button.dataset.iddSort === sortKey;
      button.querySelector('span').textContent = active ? (sortDirection === 'asc' ? '▲' : '▼') : '';
      button.closest('th').setAttribute('aria-sort', active
        ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none');
    }
  }

  function renderTable() {
    renderSortHeaders();
    const visible = sortedVisibleDonors();
    if (!visible.length) {
      let message = donors.length ? 'No donors match the current table filters.' : 'No money donations were found in the selected period.';
      $tableBody.innerHTML = `<tr class="idd-empty-row"><td colspan="6">${escapeHtml(message)}</td></tr>`;
      return;
    }
    $tableBody.innerHTML = visible.map(donor => {
      const open = expanded.has(donor.id);
      const reasons = ineligibilityReasons(donor);
      const status = reasons.length ? reasons.join(' · ') : 'Eligible';
      const statusClass = donor.resolved ? (reasons.length ? '' : 'eligible') : 'unresolved';
      const name = userName(donor);
      const user = donor.resolved
        ? `<a href="${GAME_BASE}/user/${encodeURIComponent(donor.id)}" target="_blank" rel="noopener">${escapeHtml(name)}</a>`
        : `<span>${escapeHtml(name)}</span>`;
      const txRows = donor.transactions.map(tx =>
        `<li><strong>${escapeHtml(money(tx.amount))}</strong><span>${escapeHtml(localDate(tx.timestamp))}</span></li>`
      ).join('');
      return `<tr class="idd-donor-row${donor.resolved ? '' : ' idd-unresolved'}" data-donor-id="${escapeHtml(donor.id)}" tabindex="0" aria-expanded="${open}">` +
        `<td><div class="idd-user"><span class="idd-expand">${open ? '▾' : '▸'}</span>${user}</div></td>` +
        `<td class="idd-amount">${escapeHtml(money(donor.total))}</td>` +
        `<td>${donor.count.toLocaleString()}</td>` +
        `<td class="idd-date">${escapeHtml(localDate(donor.firstAt))}</td>` +
        `<td class="idd-date">${escapeHtml(localDate(donor.latestAt))}</td>` +
        `<td><span class="idd-status-pill ${statusClass}">${escapeHtml(status)}</span></td></tr>` +
        `<tr class="idd-transactions-row${open ? '' : ' hidden'}"><td colspan="6"><ul class="idd-transactions">${txRows}</ul></td></tr>`;
    }).join('');
  }

  function rollBlockedReason() {
    if (!dataComplete) return 'Transaction history is incomplete.';
    if (!eligibilityComplete) return 'One or more donor profiles are unresolved.';
    if (!donors.some(isEligible)) return 'No eligible donors remain.';
    return '';
  }

  function renderStatus() {
    const eligible = donors.filter(isEligible).length;
    const baseEligible = donors.filter(qualifiesBeforeWinnerHistory).length;
    const unresolved = donors.filter(donor => !donor.resolved).length;
    if (!dataComplete) {
      setStatus('Donation history is incomplete. Refresh is required before a winner can be selected.', true);
    } else if (unresolved) {
      setStatus(`${unresolved} donor profile${unresolved === 1 ? ' is' : 's are'} unresolved. Refresh before rolling.`, true);
    } else if (!donors.length) {
      setStatus('No money donations were found in the selected period.');
    } else if (!donors.some(donor => donor.total >= currentConfig.minimum)) {
      setStatus(`Donations exist, but no donor meets the ${money(currentConfig.minimum)} minimum.`);
    } else if (!baseEligible) {
      setStatus('Donations exist, but no current Irish donor qualifies.');
    } else if (!eligible) {
      setStatus('All eligible donors have already been selected. Reset this draw to make them eligible again.');
    } else {
      setStatus(`${eligible} eligible donor${eligible === 1 ? '' : 's'} in the current draw pool.`);
    }
  }

  function renderWarnings() {
    const unique = [...new Set(warnings.filter(Boolean))];
    if (!unique.length) {
      $warning.textContent = '';
      $warning.classList.add('hidden');
      return;
    }
    $warning.textContent = unique.map(message => `⚠ ${message}`).join('\n');
    $warning.classList.remove('hidden');
  }

  function renderAll() {
    $results.classList.remove('hidden');
    renderSummary();
    renderHistory();
    renderTable();
    renderStatus();
    renderWarnings();
    const blocked = rollBlockedReason();
    $roll.disabled = Boolean(blocked);
    $roll.title = blocked;
    $copy.disabled = !currentConfig;
    $reset.disabled = !winners.length;
  }

  async function loadData(config) {
    currentConfig = config;
    setControls(config);
    writeConfigHash(config);
    expanded.clear();
    $winner.classList.add('hidden');
    $winner.innerHTML = '';
    $results.classList.add('hidden');
    warnings = [];
    dataComplete = false;
    eligibilityComplete = false;
    setBusy(true);
    setStatus('');
    steps.reset();

    try {
      steps.setStep(1, 'active');
      const cache = readTransactionCache();
      steps.setStep(1, 'done', { count: `${cache.transactions.length} cached` });

      steps.setStep(2, 'active');
      const sync = await syncTransactions(config, cache);
      if (requestedConfigKey !== configKey(config)) return;
      transactions = sync.transactions;
      dataComplete = sync.complete;
      warnings.push(...sync.warnings);
      steps.setStep(2, sync.complete ? 'done' : 'error', {
        sub: sync.complete ? '' : 'Required history is incomplete',
        count: `${sync.pages} page${sync.pages === 1 ? '' : 's'}`,
      });

      steps.setStep(3, 'active');
      const aggregated = aggregateDonations(transactions, config);
      donors = aggregated.donors;
      if (aggregated.nonMoneyCount) {
        warnings.push(`${aggregated.nonMoneyCount} non-money or non-positive donation-shaped record${aggregated.nonMoneyCount === 1 ? '' : 's'} appeared in this period and ${aggregated.nonMoneyCount === 1 ? 'was' : 'were'} excluded without a value.`);
      }
      const profiles = await resolveProfiles(donors);
      if (requestedConfigKey !== configKey(config)) return;
      profileCheckedAt = Date.now();
      eligibilityComplete = profiles.complete;
      warnings.push(...profiles.warnings);
      steps.setStep(3, profiles.complete ? 'done' : 'error', {
        sub: profiles.complete ? '' : 'At least one donor is unresolved',
        count: `${donors.length - profiles.unresolved}/${donors.length}`,
      });

      steps.setStep(4, 'active');
      winners = readWinners(config, warnings);
      steps.setStep(4, 'done', { count: `${donors.length} donors` });

      steps.setStep(5, 'active');
      renderAll();
      steps.setStep(5, 'done', { count: `${donors.filter(isEligible).length} eligible` });
      if (dataComplete && eligibilityComplete) steps.fadeOut();
    } catch (error) {
      steps.markActiveAsError(error.message || 'Load failed');
      setStatus(isTransientError(error)
        ? 'The data server is having a moment. Wait a few seconds and Refresh.'
        : `Donation draw failed to load: ${error.message}`, true);
      dataComplete = false;
      eligibilityComplete = false;
      $roll.disabled = true;
    } finally {
      setBusy(false);
    }
  }

  function requestLoad(config) {
    requestedConfigKey = configKey(config);
    pendingLoad = config;
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      while (pendingLoad) {
        const next = pendingLoad;
        pendingLoad = null;
        await loadData(next);
      }
    })().finally(() => { loadPromise = null; });
    return loadPromise;
  }

  function setBusy(busy) {
    $form.querySelector('button[type="submit"]').disabled = busy;
    $refresh.disabled = busy;
    if (busy) $roll.disabled = true;
  }

  function secureRandomIndex(length) {
    if (!Number.isSafeInteger(length) || length <= 0) throw new Error('Cannot select from an empty pool.');
    const range = 0x1_0000_0000;
    const limit = Math.floor(range / length) * length;
    const values = new Uint32Array(1);
    do { crypto.getRandomValues(values); } while (values[0] >= limit);
    return values[0] % length;
  }

  async function revalidateEligibility() {
    setBusy(true);
    setStatus('Revalidating current citizenship before the draw…');
    try {
      const profiles = await resolveProfiles(donors);
      profileCheckedAt = Date.now();
      eligibilityComplete = profiles.complete;
      warnings.push(...profiles.warnings);
      renderAll();
      return profiles.complete;
    } catch (error) {
      eligibilityComplete = false;
      warnings.push(`Citizenship could not be revalidated (${error.message}). Rolling was aborted.`);
      renderAll();
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function handleRoll() {
    if (!currentConfig || loadPromise) return;
    if (!dataComplete || !eligibilityComplete) { renderAll(); return; }
    if (!profileCheckedAt || Date.now() - profileCheckedAt > PROFILE_STALE_MS) {
      const okay = await revalidateEligibility();
      if (!okay || !dataComplete) return;
    }
    const pool = donors.filter(isEligible);
    if (!pool.length) { renderAll(); return; }
    const selected = pool[secureRandomIndex(pool.length)];
    const record = {
      userId: selected.id,
      username: userName(selected),
      total: selected.total,
      selectedAt: new Date().toISOString(),
    };
    winners.push(record);
    writeWinners(currentConfig, warnings);
    renderAll();
    $winner.innerHTML = `<div class="idd-winner-label">Winner #${winners.length}</div>` +
      `<div class="idd-winner-name"><a href="${GAME_BASE}/user/${encodeURIComponent(selected.id)}" target="_blank" rel="noopener">${escapeHtml(record.username)}</a></div>` +
      `<div class="idd-winner-meta">${escapeHtml(money(selected.total))} donated across ${selected.count.toLocaleString()} transaction${selected.count === 1 ? '' : 's'}</div>`;
    $winner.classList.remove('hidden');
    $winner.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function handleReset() {
    if (!currentConfig || !winners.length) return;
    if (!confirm('Reset winner history for this exact period and minimum? Previous winners will become eligible again.')) return;
    try {
      localStorage.removeItem(drawStorageKey(currentConfig));
    } catch {
      warnings.push('Browser storage could not clear the saved draw. The in-memory history was reset only.');
    }
    winners = [];
    $winner.classList.add('hidden');
    $winner.innerHTML = '';
    renderAll();
  }

  function drawSummaryText() {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Local time';
    const eligible = donors.filter(qualifiesBeforeWinnerHistory)
      .sort((a, b) => b.total - a.total || userName(a).localeCompare(userName(b)));
    const unresolved = donors.filter(donor => !donor.resolved);
    const lastDrawAt = winners.length ? localDate(Date.parse(winners[winners.length - 1].selectedAt)) : 'Not rolled yet';
    const lines = [
      'Ireland Donation Draw',
      `Selected Period (${zone}): ${periodText(currentConfig)}`,
      `Donation Threshold: ${money(currentConfig.minimum)} aggregate`,
      `Draw timestamp: ${lastDrawAt}`,
      `Eligible user count: ${eligible.length}`,
      'Eligible users:',
      ...(eligible.length ? eligible.map(donor => `- ${userName(donor)} — ${money(donor.total)}`) : ['- None']),
      'Winners in roll order:',
      ...(winners.length ? winners.map((winner, index) =>
        `${index + 1}. ${winner.username} — ${money(winner.total)} — ${localDate(Date.parse(winner.selectedAt))}`
      ) : ['- None']),
      unresolved.length
        ? `Unresolved-data warning: ${unresolved.length} donor profile(s) unresolved; rolling is blocked.`
        : 'Unresolved-data warning: None.',
    ];
    return lines.join('\n');
  }

  async function copyText(text) {
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    if (!copied) throw new Error('Copy command was rejected');
  }

  async function handleCopy() {
    if (!currentConfig) return;
    try {
      await copyText(drawSummaryText());
      const old = $copy.textContent;
      $copy.textContent = 'Copied';
      setTimeout(() => { $copy.textContent = old; }, 1400);
    } catch (error) {
      setStatus(`Could not copy the draw summary: ${error.message}`, true);
    }
  }

  function handleApply(event) {
    event.preventDefault();
    const startMs = new Date($start.value).getTime();
    const endMs = new Date($end.value).getTime();
    const minimum = Number($minimum.value);
    const error = validateConfig(startMs, endMs, minimum);
    if (error) {
      setStatus(error, true);
      $results.classList.add('hidden');
      $roll.disabled = true;
      return;
    }
    requestLoad(makeConfig(startMs, endMs, minimum));
  }

  function toggleDonorRow(row) {
    const id = row?.dataset.donorId;
    if (!id) return;
    if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
    renderTable();
  }

  function bindListeners() {
    if (listenersBound) return;
    listenersBound = true;
    $form.addEventListener('submit', handleApply);
    $refresh.addEventListener('click', () => currentConfig && requestLoad(currentConfig));
    $roll.addEventListener('click', handleRoll);
    $reset.addEventListener('click', handleReset);
    $copy.addEventListener('click', handleCopy);
    $search.addEventListener('input', renderTable);
    $showIneligible.addEventListener('change', renderTable);
    $table.addEventListener('click', event => {
      const sortButton = event.target.closest('[data-idd-sort]');
      if (sortButton) {
        const nextKey = sortButton.dataset.iddSort;
        if (sortKey === nextKey) sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
        else {
          sortKey = nextKey;
          sortDirection = nextKey === 'username' ? 'asc' : 'desc';
        }
        renderTable();
        return;
      }
      if (event.target.closest('a')) return;
      toggleDonorRow(event.target.closest('.idd-donor-row'));
    });
    $table.addEventListener('keydown', event => {
      if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('.idd-donor-row')) {
        event.preventDefault();
        toggleDonorRow(event.target);
      }
    });
  }

  return {
    activate(params) {
      bindListeners();
      $timezone.textContent = timezoneLabel();
      const parsed = configFromParams(params);
      if (parsed.error) {
        requestedConfigKey = null;
        pendingLoad = null;
        currentConfig = null;
        $results.classList.add('hidden');
        $roll.disabled = true;
        $copy.disabled = true;
        $reset.disabled = true;
        setStatus(`Invalid selected period: ${parsed.error}`, true);
        return;
      }
      const sameConfig = currentConfig && configKey(currentConfig) === configKey(parsed.config);
      if (loadPromise && sameConfig) return;
      requestLoad(parsed.config);
    },
  };
})();
