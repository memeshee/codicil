// src/pages/proof.ts — GET /proof. The zero-keys page: names and scopes, never values.

import { escapeHtml, shell } from './layout.ts';

export interface ProofView {
  envNames: string[];
  connectorList: unknown;
  phase: string;
  gateway: string;
  demo: boolean;
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

  <h3>How to check this yourself</h3>
  <ol class="ops">
    <li>Open the source: <code>src/connectors.ts</code> — no header is ever attached.</li>
    <li>Grep the repo for <code>Authorization</code>: the only match is this sentence.</li>
    <li>Ask the gateway from inside the Sprite: <code>curl ${escapeHtml(v.gateway)}/list</code>.</li>
  </ol>
  <p class="muted small">Current phase: ${escapeHtml(v.phase)}.</p>
</section>`;
  return shell({ title: 'Codicil — no keys', active: 'proof', demo: v.demo }, body);
}
