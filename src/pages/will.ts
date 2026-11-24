// src/pages/will.ts - GET /will. The document itself, plus the owner-token edit form.

import type { Will } from '../types.ts';
import { escapeHtml, shell } from './layout.ts';

export interface WillView {
  will: Will | null;
  demo: boolean;
  witnessLinks?: Array<{ name: string; url: string }>;
}

export function renderWill(v: WillView): string {
  const w = v.will;
  const document = w
    ? `
<h2>WITNESSETH</h2>
<p class="letter">${escapeHtml(w.letter).replace(/\n/g, '<br>')}</p>
<h3>Instructions, in order</h3>
<ol class="ops">
  ${w.instructions
    .map((op) => {
      if (op.kind === 'github_issue') return `<li><b>farewell issue</b> on <code>${escapeHtml(op.repo)}</code> - “${escapeHtml(op.title)}”</li>`;
      if (op.kind === 'slack_post') return `<li><b>message</b> to <code>${escapeHtml(op.target)}</code></li>`;
      if (op.kind === 's3_put') return `<li><b>release file</b> <code>${escapeHtml(op.key)}</code></li>`;
      return `<li><b>email</b> to <code>${escapeHtml(op.to)}</code> - “${escapeHtml(op.subject)}”</li>`;
    })
    .join('')}
</ol>
<h3>Witnesses</h3>
<ul class="plain">${w.witnesses.map((x) => `<li>${escapeHtml(x.name)}</li>`).join('')}</ul>
${w.sealed ? `<h3>Sealed</h3><p>A private letter rode along with this will as ciphertext
(${w.sealed.ct.length} bytes). The executor has never seen the passphrase and cannot open it -
<a href="/open">open it in your browser</a>.</p>` : ''}
<p class="muted">version ${w.version} / signed ${escapeHtml(w.updatedAt)}${w.policy.vouchQuorum ? ` / quorum ${w.policy.vouchQuorum}` : ''}</p>`
    : `<p class="muted">No will signed yet. Nothing is armed, and nothing will be executed.</p>`;

  const links = v.witnessLinks?.length
    ? `<div class="card"><p class="kicker">witness links - private, share once</p><ul class="plain">${v.witnessLinks
        .map((l) => `<li>${escapeHtml(l.name)}: <code>${escapeHtml(l.url)}</code></li>`)
        .join('')}</ul></div>`
    : '';

  const body = `
<section class="card">
  <p class="kicker">the will</p>
  ${document}
</section>
${links}
<section class="card">
  <p class="kicker">sign or amend</p>
  <form method="post" action="/api/will">
    <label for="tok">owner token</label>
    <input id="tok" name="token" type="password" autocomplete="current-password" required>
    <label for="letter">your words, in your voice - carried verbatim</label>
    <textarea id="letter" name="letter" rows="6" placeholder="Say the thing.">${w ? escapeHtml(w.letter) : ''}</textarea>
    <label for="github">your github handle</label>
    <input id="github" name="github" value="${w ? escapeHtml(w.owner.github) : ''}" placeholder="PhiBao">
    <label for="repo">repo that receives the farewell issue</label>
    <input id="repo" name="repo" value="${w && w.instructions[0] && w.instructions[0].kind === 'github_issue' ? escapeHtml(w.instructions[0].repo) : ''}" placeholder="owner/repo">
    <label for="slack">slack channel for the message</label>
    <input id="slack" name="slack" value="" placeholder="C0…">
    <label for="witnesses">witnesses - <code>Name &lt;U0123ABCD&gt;</code> or <code>Name &lt;email&gt;</code>, comma separated</label>
    <input id="witnesses" name="witnesses" value="${
      w ? escapeHtml(w.witnesses.map((x) => `${x.name}${x.slackUserId ? ` <${x.slackUserId}>` : x.email ? ` <${x.email}>` : ''}`).join(', ')) : ''
    }" placeholder="Ada <U0123ABCD>, Grace <grace@example.com>">
    <p class="muted small">A witness with a channel is <b>told</b> when the clock runs out. A witness with only a
    name is never notified - and the board says so instead of pretending.</p>
    <label for="sealed">a private thing, sealed (encrypted in your browser - this box never reads it)</label>
    <textarea id="sealed" rows="3" placeholder="Type it here. It leaves this browser as ciphertext."></textarea>
    <label for="sealpass">passphrase for the sealed words</label>
    <input id="sealpass" type="password" autocomplete="new-password" placeholder="nobody can recover this for you">
    <input type="hidden" name="sealed_blob" id="sealed_blob" value="">
    <p class="muted small">${w && w.sealed ? 'A sealed letter is already attached; leave these empty to keep it.' : 'Leave both empty for a plain will.'}</p>
    <div class="row">
      <label for="deadline">deadline (min)</label><input id="deadline" name="deadline" type="number" min="1" value="${w ? w.policy.deadlineMinutes : 10080}">
      <label for="nudge">nudge grace (min)</label><input id="nudge" name="nudge" type="number" min="1" value="${w ? w.policy.nudgeGraceMinutes : 2880}">
      <label for="plead">plead grace (min)</label><input id="plead" name="plead" type="number" min="1" value="${w ? w.policy.pleadGraceMinutes : 1440}">
      <label for="quorum">witness quorum</label><input id="quorum" name="quorum" type="number" min="1" max="5" value="${w?.policy.vouchQuorum ?? 1}">
    </div>
    ${v.demo ? '<p class="muted small">DEMO mode: graces below 60 minutes are accepted and every row is labelled.</p>' : '<p class="muted small">Graces below 60 minutes require DEMO=1.</p>'}
    <button type="submit">Seal it</button>
  </form>
</section>

<section class="card">
  <p class="kicker">withdraw, or rotate a lost token</p>
  <p class="muted">Revoking stops everything for this version. Rotating kills the token you have
  and prints a new one - useful if you lost it, because a lost token means you cannot check in,
  and cannot checking in is how a will executes.</p>
  <form id="revokeform" method="post" action="/api/revoke" data-json="1">
    <label for="rtok">owner token</label>
    <input id="rtok" name="token" type="password" required>
    <div class="buttonrow">
      <button type="submit" name="action" value="revoke">Withdraw consent</button>
      <button type="submit" name="action" value="rotate" formaction="/api/rotate">Rotate token</button>
    </div>
  </form>
  <pre id="ctlout" class="muted small"></pre>
</section>

<script>
(() => {
  // Seal in the browser: the passphrase never leaves this page, so the box cannot open what
  // it stores. If the browser cannot encrypt, refuse rather than storing plaintext quietly.
  const form = document.querySelector('form[action="/api/will"]');
  const b64 = { from: (b) => btoa(String.fromCharCode(...new Uint8Array(b))) };
  const enc = new TextEncoder();
  form.addEventListener('submit', async (e) => {
    const plain = document.getElementById('sealed').value.trim();
    if (!plain) return;
    const pass = document.getElementById('sealpass').value;
    if (!pass) { e.preventDefault(); alert('Sealed words need a passphrase - without it nobody, including you, can ever open them.'); return; }
    e.preventDefault();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const baseKey = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 200000, hash: 'SHA-256' }, baseKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plain));
    document.getElementById('sealed_blob').value = JSON.stringify({ ct: b64.from(ct), iv: b64.from(iv), salt: b64.from(salt), hint: 'the phrase you chose' });
    document.getElementById('sealed').value = '';
    form.submit();
  });

  // The control forms answer in JSON; show it instead of navigating away.
  for (const f of document.querySelectorAll('form[data-json]')) {
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const out = document.getElementById('ctlout');
      const body = new URLSearchParams(new FormData(e.submitter?.formAction ? f : f));
      if (e.submitter?.value === 'rotate') body.delete('action');
      const target = e.submitter?.formAction || f.action;
      out.textContent = 'working…';
      const res = await fetch(target, { method: 'POST', body, headers: { accept: 'application/json' } });
      const json = await res.json().catch(() => ({ ok: false, error: 'unreadable response' }));
      out.textContent = JSON.stringify(json, null, 2);
      if (json.token) out.textContent += '\n\nStore this now - it is not shown again.';
    });
  }
})();
</script>`;
  return shell({ title: 'Codicil - the will', active: 'will', demo: v.demo }, body);
}
