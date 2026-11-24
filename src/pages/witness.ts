// src/pages/witness.ts — GET /w/:wid/:token. The one page a witness ever sees.

import type { StateSnapshot, WitnessRow, Will } from '../types.ts';
import { escapeHtml, shell } from './layout.ts';

export interface WitnessView {
  witness: WitnessRow;
  will: Will | null;
  snapshot: StateSnapshot;
  demo: boolean;
  vouched: boolean;
  lastCheckIn?: string;
}

export function renderWitness(v: WitnessView): string {
  const name = escapeHtml(v.witness.name);
  const owner = v.will ? escapeHtml(v.will.owner.name) : 'the owner';
  const noticed = v.witness.notifiedAt ? escapeHtml(v.witness.notifiedAt) : null;

  const body = v.vouched
    ? `<section class="card">
  <p class="kicker">thank you, ${name}</p>
  <h1>Your word has been counted.</h1>
  <p>The clock is stood down and ${owner} will be told you answered. Nothing further is needed from you.</p>
</section>`
    : `<section class="card">
  <p class="kicker">a personal notice</p>
  <h1>${owner} has gone quiet.</h1>
  <p>You are named as a witness in ${owner}&rsquo;s will. That means one thing: if they stop
  answering, someone who knows them should be asked before anything is carried out.</p>
  ${noticed ? `<p class="muted">you were written to on ${noticed}</p>` : ''}
  ${v.lastCheckIn ? `<p class="muted">${owner} was last seen on ${escapeHtml(v.lastCheckIn)} — that is the silence this notice is about.</p>` : ''}
  <p>If you know ${owner} is safe — travelling, unwell, simply offline — say so. Your word stops
  the clock. If you do not know, do nothing, and say nothing: silence here is an answer too.</p>
  <form method="post" action="/w/${escapeHtml(v.witness.id)}/vouch">
    <button type="submit">I know they are safe</button>
  </form>
  <p class="muted small">Current phase: ${v.snapshot.phase}. This page is private to you; nobody else holds this link.</p>
</section>`;

  return shell({ title: 'Codicil — a personal notice', demo: v.demo }, body);
}
