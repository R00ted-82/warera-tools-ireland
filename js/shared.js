/* ═══════════════════════════════════════════════════════════════════
 *  SHARED UTILITIES
 *  Loaded before every tool. Defines the data layer (trpc proxy),
 *  formatting helpers, and the step/status panel constructors used by
 *  MU and the Advisor.
 * ═══════════════════════════════════════════════════════════════════ */
const API_BASE         = 'https://warera-proxy.toie.workers.dev/trpc';
const WARERASTATS_BASE = 'https://warera-proxy.toie.workers.dev/warerastats';
const GAME_BASE        = 'https://app.warera.io';

// Canonical Ireland country ID. Shared by the MU tool's citizenship
// filter and the Irish-only gate on personal tools (clockin, advisor).
const IRELAND_COUNTRY_ID = '6813b6d446e731854c7ac7fe';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function fmtNum(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v.toLocaleString(undefined, {maximumFractionDigits: 0});
  return String(v);
}
function fmt(v, dp = 2) {
  if (!isFinite(v)) return '0';
  return v.toFixed(dp).replace(/\.?0+$/, '');
}
function flag(code) {
  if (!code || code.length !== 2) return '🌐';
  return code.toUpperCase().split('').map(c =>
    String.fromCodePoint(c.charCodeAt(0) - 65 + 0x1F1E6)
  ).join('');
}
function formatDuration(ms) {
  if (!isFinite(ms) || ms <= 0) return 'expired';
  const totalSec = Math.floor(ms / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${Math.max(m, 1)}m`;
}
function formatDate(v) {
  if (!v) return null;
  const d = new Date(v);
  if (isNaN(d)) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Read the bypass flag from the URL. Lifts Irish-only restrictions
 * for admin/debugging. Works whether the param sits inside the hash
 * (e.g. #clockin?u=foo&bypass=1) or before it (?bypass=1#clockin).
 */
function hasBypassFlag() {
  const hashQuery = location.hash.split('?')[1] || '';
  return new URLSearchParams(hashQuery).get('bypass') === '1'
      || new URLSearchParams(location.search).get('bypass') === '1';
}

/**
 * Enforces the Irish-citizens-only restriction. Throws a friendly
 * error if the user is non-Irish and the bypass flag isn't set.
 * Pass null/undefined country (e.g. unresolved user) to let it
 * through — the failure mode of the resolution path is its own
 * error and we don't want to double up.
 */
function enforceIrishOnly(country, username) {
  if (hasBypassFlag()) return;
  if (country == null) return;
  if (country === IRELAND_COUNTRY_ID) return;
  throw new Error(`This tool is for Irish citizens only. "${username}" is not an Irish citizen.`);
}

// Transient errors are worth retrying. Covers raw HTTP 5xx plus proxy
// responses that embed an upstream 5xx in the message body.
function isTransientError(err) {
  if (err && err.status >= 500 && err.status < 600) return true;
  const msg = String(err?.message || '').toLowerCase();
  return /http 50[234]|no available server|timed? ?out|fetch failed|network ?error/.test(msg);
}

// async function trpc(endpoint, input = {}, { retry = false, timeoutMs = null } = {}, attempt = 1) {
//   const MAX_ATTEMPTS = retry ? 3 : 1;
//   const url = `${API_BASE}/${endpoint}?input=${encodeURIComponent(JSON.stringify(input))}`;
//   const ctrl = timeoutMs ? new AbortController() : null;
//   const t = timeoutMs ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
//   try {
//     const res = await fetch(url, ctrl ? { signal: ctrl.signal } : undefined);
//     if (!res.ok) {
//       const err = new Error(`${endpoint} → HTTP ${res.status}`);
//       err.status = res.status;
//       throw err;
//     }
//     const json = await res.json();
//     if (json && !Array.isArray(json) && json.error) {
//       const msg = json.error.message || json.error.data?.message || 'unknown error';
//       throw new Error(`${endpoint} → ${String(msg).slice(0, 120)}`);
//     }
//     const item = Array.isArray(json) ? json[0] : json;
//     return item?.result?.data ?? item;
//   } catch (e) {
//     if (e.name === 'AbortError') throw new Error(`${endpoint} → timed out`);
//     if (attempt < MAX_ATTEMPTS && isTransientError(e)) {
//       await new Promise(r => setTimeout(r, 400 * attempt));
//       return trpc(endpoint, input, { retry, timeoutMs }, attempt + 1);
//     }
//     throw e;
//   } finally {
//     if (t) clearTimeout(t);
//   }
// }

/* ── Session request cache ──────────────────────────────────────────
 *  In-flight dedup is always on: concurrent identical requests share one
 *  promise (pure win, no staleness). The resolved cache, serving a past
 *  value for idempotent endpoints with a TTL, is OFF by default so the
 *  live tools behave exactly as before (Refresh stays fresh). The staging
 *  shell switches it on via setTrpcCache(true) to harmonise calls across
 *  tools and let its background prefetch warm data before a username is
 *  typed, then switches it off (clearing it) on leave. Volatile endpoints
 *  are never resolved-cached.
 */
const TRPC_CACHE_TTL_MS = 90_000;
const TRPC_VOLATILE = new Set([
  'transaction.getPaginatedTransactions',
  'worker.getWorkers',
]);
let _trpcCacheOn = false;
const _trpcInflight = new Map();
const _trpcResolved = new Map();

function setTrpcCache(on) {
  _trpcCacheOn = !!on;
  if (!on) _trpcResolved.clear();
}
function _trpcResolvable(endpoint) {
  return _trpcCacheOn && !TRPC_VOLATILE.has(endpoint);
}

function trpc(endpoint, input = {}, opts = {}) {
  const key = `${endpoint}|${JSON.stringify(input ?? {})}`;

  // Serve a fresh-enough resolved value when caching is on for this endpoint.
  if (_trpcResolvable(endpoint) && !opts.fresh) {
    const hit = _trpcResolved.get(key);
    if (hit && Date.now() - hit.ts < TRPC_CACHE_TTL_MS) return Promise.resolve(hit.value);
  }
  // Share an identical request already in flight.
  if (_trpcInflight.has(key)) return _trpcInflight.get(key);

  const p = _trpcExec(endpoint, input, opts, 1)
    .then(value => {
      if (_trpcResolvable(endpoint)) _trpcResolved.set(key, { value, ts: Date.now() });
      return value;
    })
    .finally(() => { _trpcInflight.delete(key); });
  _trpcInflight.set(key, p);
  return p;
}

async function _trpcExec(endpoint, input = {}, { retry = false, timeoutMs = null } = {}, attempt = 1) {
  const MAX_ATTEMPTS = retry ? 3 : 1;
  const url = `${API_BASE}/${endpoint}?input=${encodeURIComponent(JSON.stringify(input))}`;
  const ctrl = timeoutMs ? new AbortController() : null;
  const t = timeoutMs ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetch(url, ctrl ? { signal: ctrl.signal } : undefined);
    if (!res.ok) {
      const err = new Error(`${endpoint} → HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const json = await res.json();
    if (json && !Array.isArray(json) && json.error) {
      const msg = json.error.message || json.error.data?.message || 'unknown error';
      throw new Error(`${endpoint} → ${String(msg).slice(0, 120)}`);
    }
    const item = Array.isArray(json) ? json[0] : json;
    return item?.result?.data ?? item;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`${endpoint} → timed out`);
    if (attempt < MAX_ATTEMPTS && isTransientError(e)) {
      await new Promise(r => setTimeout(r, 400 * attempt));
      return _trpcExec(endpoint, input, { retry, timeoutMs }, attempt + 1);
    }
    throw e;
  } finally {
    if (t) clearTimeout(t);
  }
}

function makeSteps(rootEl) {
  function setStep(n, state, { sub, count } = {}) {
    const el = rootEl.querySelector(`.step[data-step="${n}"]`);
    if (!el) return;
    el.dataset.state = state;
    if (sub   !== undefined) el.querySelector('.step-sub').textContent   = sub   ?? '';
    if (count !== undefined) el.querySelector('.step-count').textContent = count ?? '';
  }
  function reset() {
    rootEl.classList.remove('hidden', 'fading');
    for (const step of rootEl.querySelectorAll('.step')) {
      step.dataset.state = 'pending';
      step.querySelector('.step-sub').textContent = '';
      step.querySelector('.step-count').textContent = '';
    }
  }
  function markActiveAsError(message) {
    const active = rootEl.querySelector('.step[data-state="active"]');
    if (active) {
      active.dataset.state = 'error';
      active.querySelector('.step-sub').textContent = message;
    }
  }
  function fadeOut(delay = 1200) {
    setTimeout(() => rootEl.classList.add('fading'), delay);
    setTimeout(() => rootEl.classList.add('hidden'), delay + 500);
  }
  function hide() { rootEl.classList.add('hidden'); }
  return { setStep, reset, markActiveAsError, fadeOut, hide };
}

function makeStatus(el) {
  return function setStatus(text, isError = false) {
    if (!text) { el.classList.add('hidden'); return; }
    el.textContent = text;
    el.classList.toggle('error', isError);
    el.classList.remove('hidden');
  };
}