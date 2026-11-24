// src/pages/try.ts — GET /try. The spectator door.
//
// A judge lands cold, signs a throwaway will, and watches the ladder walk itself. No owner
// token, because this is a disposable demo instance and the token would be a wall between a
// judge and the only thing worth judging.

import type { StateSnapshot, Will } from '../types.ts';
import { escapeHtml, shell } from './layout.ts';

export interface TryView {
  will: Will | null;
  snapshot: StateSnapshot;
  msToNextBoundary: number | null;
  demoToken: string;
  repo: string;
  channel: string;
  demo: boolean;
  /** Prefilled from the query string, so a demo can be driven by a link alone. */
  prefill?: { name?: string; letter?: string; witnesses?: string };
}

export function renderTry(v: TryView): string {
  const s = v.snapshot;
  const live = s.phase !== 'DORMANT';
  const ladder =
    '<ul class="plain">' +
    '<li><b>ARMED</b> — the clock runs from the moment you seal it</li>' +
    '<li><b>CONCERNED</b> — deadline missed: the nudge goes to the owner</li>' +
    '<li><b>PLEADING</b> — witnesses are written to, with what was checked and what could not be</li>' +
    '<li><b>EXECUTING</b> — the instructions run, in order, with bounded retries</li>' +
    '<li><b>EXECUTED</b> — receipts, and a board nobody can edit quietly</li>' +
    '</ul>';

  const body = `
<section class="card wake">
  <p class="kicker">try it · 60 seconds · this instance is disposable</p>
  <h1>${live ? `Phase: ${escapeHtml(s.phase)}` : 'Sign a will and watch it run.'}</h1>
  <p>This is a demo instance. The will you sign here is <b>this instance's</b> will, its graces are
  measured in seconds, and every row it produces is labelled <code>DEMO</code>. Nothing here can
  touch an account that has not been connected to this box.</p>
  ${v.repo || v.channel
    ? `<p class="muted small">Instructions on this instance point at ${escapeHtml(v.repo || 'no repo')} / ${escapeHtml(v.channel || 'no channel')}.</p>`
    : `<p class="muted small">No connectors are wired on this instance yet, so the execution step will record
       honest failures instead of sending anything. The ladder is still real.</p>`}
  ${live
    ? `<p class="kicker">live</p><p class="big" id="countdown" data-ms="${v.msToNextBoundary ?? 0}">—</p>
       <p class="muted">last check-in ${escapeHtml(s.lastCheckIn)} · streak ${s.streakDays} · version ${s.willVersion}</p>
       ${v.demoToken ? `<p class="muted small">Your check-in token for this instance: <code>${escapeHtml(v.demoToken)}</code> —
       paste it on the home page to reset the ladder and watch it stand down.</p>` : ''}`
    : ''}
  <h3>The ladder, in the order it will happen</h3>
  ${ladder}
</section>

<section class="card">
  <p class="kicker">seal a demo will</p>
  <form id="tryform" method="post" action="/try">
    <label for="tname">your name</label>
    <input id="tname" name="name" placeholder="a visitor" value="${escapeHtml(v.prefill?.name ?? (v.will ? v.will.owner.name : ''))}">
    <label for="tletter">your words — carried verbatim, in the clear</label>
    <textarea id="tletter" name="letter" rows="3" placeholder="Say the thing you would actually say.">${
      escapeHtml(v.prefill?.letter ?? (v.will ? v.will.letter : ''))
    }</textarea>
    <label for="twit">witnesses — <code>Name &lt;U0123ABCD&gt;</code>, comma separated (optional)</label>
    <input id="twit" name="witnesses" placeholder="Ada <U0123ABCD>" value="${escapeHtml(v.prefill?.witnesses ?? '')}">
    <label for="tsealed">a private thing, sealed (optional)</label>
    <textarea id="tsealed" rows="2" placeholder="Type it. It is encrypted in your browser before it is sent — this box will never read it."></textarea>
    <label for="tpass">passphrase for the sealed words</label>
    <input id="tpass" type="password" autocomplete="new-password" placeholder="only you, and whoever you tell">
    <input type="hidden" name="sealed_blob" id="tblob" value="">
    <p class="muted small">Sixty seconds end to end: 20s to CONCERNED, 20s to PLEADING, 20s to executing.
    The page refreshes itself, and every request is a wake — that is how a Sprite keeps time.</p>
    <button type="submit">Seal it and watch</button>
  </form>
</section>

<script>
(() => {
  const form = document.getElementById('tryform');
  const b64 = { from: (b) => btoa(String.fromCharCode(...new Uint8Array(b))) };
  const enc = new TextEncoder();
  form.addEventListener('submit', async (e) => {
    const plain = document.getElementById('tsealed').value.trim();
    if (!plain) return;                       // nothing sealed: a plain submit
    const pass = document.getElementById('tpass').value;
    if (!pass) { e.preventDefault(); alert('The sealed words need a passphrase — without it nobody, including you, can open them.'); return; }
    e.preventDefault();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const baseKey = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 200000, hash: 'SHA-256' },
      baseKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt'],
    );
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plain));
    document.getElementById('tblob').value = JSON.stringify({ ct: b64.from(ct), iv: b64.from(iv), salt: b64.from(salt), hint: 'the phrase you chose' });
    document.getElementById('tsealed').value = '';
    form.submit();
  });

  const el = document.getElementById('countdown');
  if (el) {
    let ms = Number(el.dataset.ms || 0);
    const fmt = (t) => { const s = Math.max(0, Math.floor(t / 1000)); return s + 's'; };
    setInterval(() => {
      ms = Math.max(0, ms - 1000);
      el.textContent = fmt(ms);
      if (ms === 0) location.reload();        // the reload is the wake
    }, 1000);
  }
})();
</script>`;
  return shell({ title: 'Codicil — try it', active: 'home', demo: v.demo }, body);
}
