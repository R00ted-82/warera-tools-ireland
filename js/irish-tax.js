/* ═══════════════════════════════════════════════════════════════════
 *  IRISH FACTORY TAX — password-gated, AES-GCM encrypted
 *
 *  The full Irish Factory Tax tool (CSS, HTML, JS) is encrypted in
 *  TAX_ENCRYPTED_PAYLOAD below.
 *
 *  Blob format: base64 of  salt(16) || iv(12) || AES-GCM-256 ciphertext
 *  Key derivation:         PBKDF2-SHA-256, 200000 iterations
 *
 *  To set up or rotate the password: encrypt tax-payload.js with the
 *  standalone encrypt.html generator, then paste the resulting base64
 *  string as the value of TAX_ENCRYPTED_PAYLOAD below.
 *
 *  Until TAX_ENCRYPTED_PAYLOAD is set, the gate shows
 *  "Irish Factory Tax payload not configured yet." and the tool doesn't load.
 * ═══════════════════════════════════════════════════════════════════ */
const IrishTaxGate = (() => {
  // PASTE YOUR ENCRYPTED BLOB HERE (single line, base64, no surrounding quotes).
  const TAX_ENCRYPTED_PAYLOAD = '';

  const $gate      = document.getElementById('tax-gate');
  const $gateForm  = document.getElementById('tax-gate-form');
  const $gatePw    = document.getElementById('tax-gate-pw');
  const $gateError = document.getElementById('tax-gate-error');
  const $gateBtn   = document.getElementById('tax-gate-submit');

  let unlocked = false;
  let injected = false;

  async function deriveKey(password, salt) {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 200000, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false, ['decrypt']
    );
  }

  async function decryptPayload(password) {
    if (!TAX_ENCRYPTED_PAYLOAD) throw new Error('NOT_CONFIGURED');
    const bytes = Uint8Array.from(atob(TAX_ENCRYPTED_PAYLOAD), c => c.charCodeAt(0));
    if (bytes.length < 28) throw new Error('Malformed payload.');
    const salt = bytes.slice(0, 16);
    const iv   = bytes.slice(16, 28);
    const ct   = bytes.slice(28);
    const key  = await deriveKey(password, salt);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return new TextDecoder().decode(plain);
  }

  function injectAndRun(code) {
    if (injected) return;
    injected = true;
    const s = document.createElement('script');
    s.textContent = code;
    document.body.appendChild(s);
  }

  async function tryUnlock(password) {
    $gateBtn.disabled = true;
    $gateError.textContent = '';
    try {
      const code = await decryptPayload(password);
      $gate.style.display = 'none';
      unlocked = true;
      injectAndRun(code);
    } catch (e) {
      $gateError.textContent = e.message === 'NOT_CONFIGURED'
        ? 'Irish Factory Tax payload not configured yet.'
        : 'Incorrect password.';
      $gatePw.select();
    } finally {
      $gateBtn.disabled = false;
    }
  }

  $gateForm.addEventListener('submit', e => {
    e.preventDefault();
    const pw = $gatePw.value;
    if (pw) tryUnlock(pw);
  });

  return {
    activate() {
      if (unlocked) return;          // Already in; DOM persists across nav.
      $gate.style.display = '';
      $gatePw.value = '';
      $gateError.textContent = '';
      setTimeout(() => $gatePw.focus(), 50);
    }
  };
})();
