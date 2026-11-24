// src/pages/verify.ts — GET /verify. The ledger's tamper-evidence, checked in your browser.
//
// The page does not ask to be believed: it ships the recomputation, and the JSON it reads
// comes from the same box that could have lied. That is the honest limit and it is printed.

import { escapeHtml, shell } from './layout.ts';

export interface VerifyView {
  chain: { ok: boolean; checked: number; brokenAtId: number | null; head: string | null };
  demo: boolean;
  count: number;
}

export function renderVerify(v: VerifyView): string {
  const status = v.chain.ok
    ? `<p class="big" style="color:#166534">chain intact</p>`
    : `<p class="big" style="color:#9a3412">BROKEN at row #${escapeHtml(String(v.chain.brokenAtId))}</p>`;

  const body = `
<section class="card">
  <p class="kicker">tamper-evidence · ${v.count} rows</p>
  <h1>${status}</h1>
  <p>Every row of the notice board carries <code>sha256(previous row hash | timestamp | kind | detail)</code>.
  Editing one row breaks every hash after it. The server's own answer is below — then the same
  arithmetic is run again in this page, on the bytes it was given.</p>
  <ul class="plain">
    <li>rows checked: <b>${v.chain.checked}</b></li>
    <li>head hash: <code>${escapeHtml(v.chain.head ?? 'genesis')}</code></li>
    <li>server verdict: <b>${v.chain.ok ? 'intact' : 'broken'}</b></li>
  </ul>
  <h3>Your own check</h3>
  <p class="muted small">Recomputes the chain from <code>/verify.json</code> with WebCrypto. Nothing is trusted.</p>
  <pre id="out">running…</pre>
  <p class="muted small"><b>The honest limit:</b> a server that wanted to lie could write a fresh
  chain from row one. What this proves is that the board was not edited <i>after</i> it was
  written, and that the operator cannot quietly rewrite your record without also rewriting
  every hash — which the ledger's own history would no longer match.</p>
</section>
<script>
(async () => {
  const out = document.getElementById('out');
  const enc = new TextEncoder();
  const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  try {
    const res = await fetch('/verify.json', { cache: 'no-store' });
    const data = await res.json();
    const rows = data.rows || [];
    let prev = null;
    let broken = null;
    for (const r of rows) {
      const buf = await crypto.subtle.digest('SHA-256', enc.encode((prev ?? 'genesis') + '|' + r.ts + '|' + r.kind + '|' + r.detail));
      const want = hex(buf);
      if (want !== r.rowHash || (r.prevHash ?? null) !== prev) { broken = r.id; break; }
      prev = want;
    }
    out.textContent = broken === null
      ? 'verified in your browser: ' + rows.length + ' rows, chain intact\\nhead ' + (prev ?? 'genesis')
      : 'MISMATCH at row ' + broken + ' — this board has been edited';
  } catch (err) {
    out.textContent = 'could not verify: ' + err;
  }
})();
</script>`;
  return shell({ title: 'Codicil — verify the board', demo: v.demo }, body);
}
