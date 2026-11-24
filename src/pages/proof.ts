// src/pages/proof.ts - GET /proof. The zero-keys page: names and scopes, never values.

import { escapeHtml, shell } from './layout.ts';

export interface ProofView {
  envNames: string[];
  connectorList: unknown;
  phase: string;
  gateway: string;
  demo: boolean;
  chain: { ok: boolean; checked: number; brokenAtId: number | null; head: string | null };
  sealed: boolean;
}

export function renderProof(v: ProofView): string {
  const envs = v.envNames.length
    ? v.envNames.map((n) => `<li><code>${escapeHtml(n)}</code></li>`).join('')
    : '<li class="muted">none set</li>';

  const list = v.connectorList
    ? `<pre>${escapeHtml(JSON.stringify(v.connectorList, null, 2)).slice(0, 4000)}</pre>`
    : `<p class="muted">The connector catalogue could not be read from this box (it answers only
       inside a Sprite, where the gateway can authenticate the caller's identity).</p>`;

  const body = `
<section class="card">
  <p class="kicker">the claim</p>
  <h1>This executor holds no credential.</h1>
  <p>Every outward call goes to Fly's Connector gateway with <b>no Authorization header</b>. The
  gateway authenticates the request by the Sprite's platform identity, injects the stored
  credential on the way to the provider, and never returns it. An agent that never holds a token
  cannot leak, log, or ship one.</p>

  <h3>Environment variable names present (values never read by this page)</h3>
  <ul class="plain">${envs}</ul>

  <h3>Gateway</h3>
  <p><code>${escapeHtml(v.gateway)}</code></p>

  <h3>Connectors this Sprite can reach, and the scopes granted</h3>
  ${list}

  <h3>What this box cannot read</h3>
  <p>${v.sealed
    ? 'The sealed letter attached to the current will is <b>ciphertext</b>. The passphrase was used in a browser and never sent here, so there is no key on this machine to open it with.'
    : 'No sealed letter is attached yet. Sign one at <a href="/will">the will</a> and the box will hold words it cannot read.'}</p>

  <h3>How to check this yourself</h3>
  <ol class="ops">
    <li>There is exactly one function that can attach a header - <code>headers()</code> in
      <code>src/connectors.ts</code>. It returns <code>content-type</code> and nothing else.</li>
    <li>Ask the gateway from inside the Sprite: <code>curl ${escapeHtml(v.gateway)}/list</code>.</li>
    <li>Verify the notice board yourself: <a href="/verify">/verify</a> recomputes the hash chain
      in your browser against <code>/verify.json</code>.</li>
  </ol>

  <h3>The notice board's chain</h3>
  <p>${v.chain.ok ? 'intact' : `<b>broken at row ${escapeHtml(String(v.chain.brokenAtId))}</b>`} -
  ${v.chain.checked} rows, head <code>${escapeHtml((v.chain.head ?? 'genesis').slice(0, 16))}…</code>.
  Editing a row breaks every hash after it.</p>
  <p class="muted small">Current phase: ${escapeHtml(v.phase)}.
  <b>The honest limits, stated:</b> the operator can read the public letter, the will's policy and
  the ledger; the sealed letter stays closed to it. The chain proves the board was not edited after
  it was written - an operator willing to rewrite every hash from row one is a different trust
  problem, and pretending otherwise would be the sort of claim this page exists to avoid.</p>
</section>`;
  return shell({ title: 'Codicil - no keys', active: 'proof', demo: v.demo }, body);
}
