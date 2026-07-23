/* ═══════════════════════════════════════════════════════════════════
 *  SHARED UTILITIES
 *  Loaded before every tool. Defines the data layer (trpc proxy),
 *  formatting helpers, and the step/status panel constructors used by
 *  MU and the Advisor.
 * ═══════════════════════════════════════════════════════════════════ */
const API_BASE         = 'https://warera-proxy.r00ted82.workers.dev/trpc';
const WARERASTATS_BASE = 'https://warera-proxy.r00ted82.workers.dev/warerastats';
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
 *  live tools behave exactly as before (Refresh stays fresh). The toolkit
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

/**
 * Enable or disable the optional 90-second resolved-value cache.
 *
 * In-flight deduplication is independent of this switch and remains active.
 * Disabling the cache immediately clears all resolved values; it does not
 * cancel requests that are already running. Volatile endpoints listed in
 * TRPC_VOLATILE are never resolved-cached, even while caching is enabled.
 *
 * @param {boolean} on Whether resolved responses may be reused.
 * @returns {void}
 */
function setTrpcCache(on) {
  _trpcCacheOn = !!on;
  if (!on) _trpcResolved.clear();
}

/** @returns {boolean} Whether this endpoint may use the resolved cache. */
function _trpcResolvable(endpoint) {
  return _trpcCacheOn && !TRPC_VOLATILE.has(endpoint);
}

/**
 * Call a game API tRPC query through the shared proxy.
 *
 * Scalar mode (the default):
 *   trpc('user.getUserLite', { userId }, { retry: true })
 *
 * `inputOrInputs` must be one non-array, JSON-serialisable tRPC input. The
 * promise resolves to the unwrapped `result.data` value. Transport, HTTP, and
 * tRPC procedure errors reject the promise.
 *
 * Batch mode:
 *   trpc('user.getUserLite', [{ userId: a }, { userId: b }], { batch: true })
 *
 * `inputOrInputs` must be an array of inputs for the SAME endpoint. One HTTP
 * batch request is sent and the promise resolves to an array in the same order
 * using Promise.allSettled's shape:
 *   { status: 'fulfilled', value } | { status: 'rejected', reason }
 * An item-level error therefore does not reject the whole batch. Keep batches
 * modest because all encoded inputs are placed in the request URL.
 *
 * Exact concurrent calls share one in-flight promise. When setTrpcCache(true)
 * is active, successful scalar calls and fully fulfilled batches are also
 * resolved-cached as complete requests; batch entries are not cached or
 * deduplicated individually. `fresh: true` skips the resolved-cache read but
 * still shares an identical in-flight request and stores the new response.
 *
 * `retry: true` allows up to three attempts for transient failures. For batch
 * mode, a transient item error retries the complete batch; after the final
 * attempt, any remaining item errors are returned as rejected results.
 *
 * @param {string} endpoint tRPC procedure name, e.g. `user.getUserLite`.
 * @param {Object|Object[]} [inputOrInputs={}] One input, or an input array when batching.
 * @param {Object} [options]
 * @param {boolean} [options.batch=false] Send all array entries in one HTTP batch.
 * @param {boolean} [options.retry=false] Retry transient failures, up to three attempts.
 * @param {number|null} [options.timeoutMs=null] Abort each HTTP attempt after this many milliseconds.
 * @param {boolean} [options.fresh=false] Bypass a resolved cached value for this call.
 * @returns {Promise<*>} Unwrapped data in scalar mode; settled results in batch mode.
 * @throws {TypeError} If `batch` is not boolean or the input shape does not match it.
 */
function trpc(endpoint, inputOrInputs = {}, {
  batch = false,
  retry = false,
  timeoutMs = null,
  fresh = false,
} = {}) {
  if (typeof batch !== 'boolean') throw new TypeError('tRPC batch option must be a boolean');
  if (batch && !Array.isArray(inputOrInputs)) {
    throw new TypeError('Batch tRPC input must be an array');
  }
  if (!batch && Array.isArray(inputOrInputs)) {
    throw new TypeError('Scalar tRPC input must not be an array');
  }
  if (batch && !inputOrInputs.length) return Promise.resolve([]);

  const key = `${batch ? 'batch' : 'single'}|${endpoint}|${JSON.stringify(inputOrInputs ?? {})}`;

  // Serve a fresh-enough resolved value when caching is on for this endpoint.
  if (_trpcResolvable(endpoint) && !fresh) {
    const hit = _trpcResolved.get(key);
    if (hit && Date.now() - hit.ts < TRPC_CACHE_TTL_MS) return Promise.resolve(hit.value);
  }
  // Share an identical request already in flight.
  if (_trpcInflight.has(key)) return _trpcInflight.get(key);

  const p = _trpcExec(endpoint, inputOrInputs, { batch, retry, timeoutMs }, 1)
    .then(value => {
      const fullyResolved = !batch || value.every(result => result.status === 'fulfilled');
      if (_trpcResolvable(endpoint) && fullyResolved) {
        _trpcResolved.set(key, { value, ts: Date.now() });
      }
      return value;
    })
    .finally(() => { _trpcInflight.delete(key); });
  _trpcInflight.set(key, p);
  return p;
}

function _trpcResponseError(item, label) {
  if (!item?.error) return null;
  const msg = item.error.message || item.error.data?.message || 'unknown error';
  const err = new Error(`${label} → ${String(msg).slice(0, 120)}`);
  const status = item.error.data?.httpStatus ?? item.error.data?.status ?? item.error.status;
  if (Number.isInteger(status)) err.status = status;
  return err;
}

function _trpcResponseValue(item) {
  return item?.result?.data ?? item;
}

/**
 * Execute one scalar or same-endpoint batch HTTP request.
 *
 * This is the wire-format and retry layer behind trpc(); callers should use
 * trpc() so validation, in-flight deduplication, and resolved caching apply.
 * Inputs have already been validated by trpc(). In batch mode, procedure names
 * are comma-separated and inputs are encoded as a numerically indexed object,
 * as required by the proxy's tRPC batch protocol.
 *
 * @param {string} endpoint tRPC procedure name.
 * @param {Object|Object[]} inputOrInputs Validated scalar or batch input.
 * @param {Object} options Normalised execution options.
 * @param {boolean} [options.batch=false] Select batch URL and response semantics.
 * @param {boolean} [options.retry=false] Permit up to three transient attempts.
 * @param {number|null} [options.timeoutMs=null] Per-attempt abort timeout.
 * @param {number} [attempt=1] Current attempt number; used internally for retries.
 * @returns {Promise<*>} Unwrapped scalar data or ordered settled batch results.
 */
async function _trpcExec(endpoint, inputOrInputs = {}, {
  batch = false,
  retry = false,
  timeoutMs = null,
} = {}, attempt = 1) {
  const MAX_ATTEMPTS = retry ? 3 : 1;
  const label = batch ? `${endpoint} batch` : endpoint;
  let url;
  if (batch) {
    const endpoints = inputOrInputs.map(() => endpoint).join(',');
    const indexedInputs = Object.fromEntries(
      inputOrInputs.map((input, index) => [index, input ?? {}])
    );
    url = `${API_BASE}/${endpoints}?batch=1&input=${encodeURIComponent(JSON.stringify(indexedInputs))}`;
  } else {
    url = `${API_BASE}/${endpoint}?input=${encodeURIComponent(JSON.stringify(inputOrInputs))}`;
  }
  const ctrl = timeoutMs ? new AbortController() : null;
  const t = timeoutMs ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetch(url, ctrl ? { signal: ctrl.signal } : undefined);
    if (!res.ok) {
      const err = new Error(`${label} → HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const json = await res.json();
    if (batch) {
      if (!Array.isArray(json) || json.length !== inputOrInputs.length) {
        throw new Error(`${label} → malformed response`);
      }
      const settled = json.map((item, index) => {
        const reason = _trpcResponseError(item, `${endpoint}[${index}]`);
        return reason
          ? { status: 'rejected', reason }
          : { status: 'fulfilled', value: _trpcResponseValue(item) };
      });
      const transient = settled.find(result =>
        result.status === 'rejected' && isTransientError(result.reason)
      );
      if (transient && attempt < MAX_ATTEMPTS) throw transient.reason;
      return settled;
    }

    const item = Array.isArray(json) ? json[0] : json;
    const responseError = _trpcResponseError(item, endpoint);
    if (responseError) throw responseError;
    return _trpcResponseValue(item);
  } catch (e) {
    if (e.name === 'AbortError') e = new Error(`${label} → timed out`);
    if (attempt < MAX_ATTEMPTS && isTransientError(e)) {
      await new Promise(r => setTimeout(r, 400 * attempt));
      return _trpcExec(endpoint, inputOrInputs, { batch, retry, timeoutMs }, attempt + 1);
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
