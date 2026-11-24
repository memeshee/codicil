// src/pages/open.ts - GET /open. Where a human opens the sealed letter.
//
// The decryption happens in the browser, after the page has loaded. The executor's own box
// never has the passphrase and never has the plaintext, so this page is not a service the
// operator provides - it is arithmetic the reader runs locally.

import type { Will } from '../types.ts';
import { escapeHtml, shell } from './layout.ts';

export interface OpenView {
  will: Will | null;
  demo: boolean;
}

export function renderOpen(v: OpenView): string {
  const sealed = v.will?.sealed;
  const body = `
<section class="card">
  <p class="kicker">sealed letter</p>
  <h1>${sealed ? 'This letter was sealed before it reached this machine.' : 'Nothing is sealed yet.'}</h1>
  ${sealed
    ? `<p>The executor carried ciphertext and delivered ciphertext. It has never seen the
  passphrase and cannot open this. Your browser can.</p>
  ${sealed.hint ? `<p class="muted">The owner left a hint: <b>${escapeHtml(sealed.hint)}</b></p>` : ''}`
    : `<p class="muted">Sign a will and seal a private letter to use this page.</p>`}
  <label for="pass">passphrase</label>
  <input id="pass" type="password" autocomplete="off" placeholder="the words only you were given">
  <label for="blob">blob</label>
  <textarea id="blob" rows="3" placeholder="ct:… / iv:… / salt:…">${sealed ? `ct:${escapeHtml(sealed.ct)} iv:${escapeHtml(sealed.iv)} salt:${escapeHtml(sealed.salt)}` : ''}</textarea>
  <button id="go" type="button">Open it</button>
  <pre id="out" class="letter"></pre>
  <p class="muted small">AES-GCM with a PBKDF2-SHA256 key (200k iterations). Wrong passphrase = no plaintext,
  not a wrong plaintext - the tag fails instead of guessing.</p>
</section>
<script>
const $ = (id) => document.getElementById(id);
const b64 = {
  to: (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
  from: (b) => btoa(String.fromCharCode(...new Uint8Array(b))),
};
function parse(text) {
  const grab = (k) => (text.match(new RegExp(k + ':([A-Za-z0-9+/=_-]+)')) || [])[1];
  return { ct: grab('ct'), iv: grab('iv'), salt: grab('salt') };
}
$('go').addEventListener('click', async () => {
  const out = $('out');
  out.textContent = 'deriving key…';
  try {
    const { ct, iv, salt } = parse($('blob').value.trim());
    if (!ct || !iv || !salt) throw new Error('blob needs ct:, iv: and salt:');
    const pass = $('pass').value;
    const baseKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: b64.to(salt), iterations: 200000, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt'],
    );
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64.to(iv) }, key, b64.to(ct));
    out.textContent = new TextDecoder().decode(plain);
  } catch (err) {
    out.textContent = 'could not open: ' + (err && err.message ? err.message : err) +
      '\\n\\nA wrong passphrase fails the authentication tag - which is the point.';
  }
});
</script>`;
  return shell({ title: 'Codicil - open the sealed letter', active: 'will', demo: v.demo }, body);
}
