// src/pages/will.ts — GET /will. The document itself, plus the owner-token edit form.

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
      if (op.kind === 'github_issue') return `<li><b>farewell issue</b> on <code>${escapeHtml(op.repo)}</code> — “${escapeHtml(op.title)}”</li>`;
      if (op.kind === 'slack_post') return `<li><b>message</b> to <code>${escapeHtml(op.target)}</code></li>`;
      if (op.kind === 's3_put') return `<li><b>release file</b> <code>${escapeHtml(op.key)}</code></li>`;
      return `<li><b>email</b> to <code>${escapeHtml(op.to)}</code> — “${escapeHtml(op.subject)}”</li>`;
    })
    .join('')}
</ol>
<h3>Witnesses</h3>
<ul class="plain">${w.witnesses.map((x) => `<li>${escapeHtml(x.name)}</li>`).join('')}</ul>
<p class="muted">version ${w.version} · signed ${escapeHtml(w.updatedAt)}</p>`
    : `<p class="muted">No will signed yet. Nothing is armed, and nothing will be executed.</p>`;

  const links = v.witnessLinks?.length
    ? `<div class="card"><p class="kicker">witness links — private, share once</p><ul class="plain">${v.witnessLinks
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
    <label for="letter">your words, in your voice — carried verbatim</label>
    <textarea id="letter" name="letter" rows="6" placeholder="Say the thing.">${w ? escapeHtml(w.letter) : ''}</textarea>
    <label for="github">your github handle</label>
    <input id="github" name="github" value="${w ? escapeHtml(w.owner.github) : ''}" placeholder="PhiBao">
    <label for="repo">repo that receives the farewell issue</label>
    <input id="repo" name="repo" value="${w && w.instructions[0] && w.instructions[0].kind === 'github_issue' ? escapeHtml(w.instructions[0].repo) : ''}" placeholder="owner/repo">
    <label for="slack">slack channel for the message</label>
    <input id="slack" name="slack" value="" placeholder="C0…">
    <label for="witnesses">witnesses, comma separated</label>
    <input id="witnesses" name="witnesses" value="${w ? escapeHtml(w.witnesses.map((x) => x.name).join(', ')) : ''}" placeholder="Ada, Grace">
    <div class="row">
      <label for="deadline">deadline (min)</label><input id="deadline" name="deadline" type="number" min="1" value="${w ? w.policy.deadlineMinutes : 10080}">
      <label for="nudge">nudge grace (min)</label><input id="nudge" name="nudge" type="number" min="1" value="${w ? w.policy.nudgeGraceMinutes : 2880}">
      <label for="plead">plead grace (min)</label><input id="plead" name="plead" type="number" min="1" value="${w ? w.policy.pleadGraceMinutes : 1440}">
    </div>
    ${v.demo ? '<p class="muted small">DEMO mode: graces below 60 minutes are accepted and every row is labelled.</p>' : '<p class="muted small">Graces below 60 minutes require DEMO=1.</p>'}
    <button type="submit">Seal it</button>
  </form>
</section>`;
  return shell({ title: 'Codicil — the will', active: 'will', demo: v.demo }, body);
}
