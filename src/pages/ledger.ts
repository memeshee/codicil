// src/pages/ledger.ts — GET /ledger. The PUBLIC NOTICE board: append-only, newest last.

import type { NoticeRow } from '../ledger.ts';
import { escapeHtml, shell } from './layout.ts';

export interface LedgerView {
  rows: NoticeRow[];
  demo: boolean;
  count: number;
}

export function renderLedger(v: LedgerView): string {
  const rows = v.rows.length
    ? v.rows
        .map(
          (r) => `<li class="notice k-${escapeHtml(r.kind)}">
      <span class="when">${escapeHtml(r.day)} <b>${escapeHtml(r.time)}</b></span>
      <span class="what">${escapeHtml(r.label)}<span class="detail">${escapeHtml(r.detail)}</span></span>
      ${r.ref ? `<a class="ref" href="${escapeHtml(r.ref)}" rel="noopener">receipt</a>` : '<span class="ref none"></span>'}
    </li>`,
        )
        .join('')
    : '<li class="notice empty">Nothing has happened yet. An empty board is the honest state of a new executor.</li>';

  const body = `
<section class="card">
  <p class="kicker">public notice board · append-only · ${v.count} entries</p>
  <h1>What it has actually done</h1>
  <p class="muted">Every state change, in order, with its receipt where one exists. Nothing on this
  page is a letter body: the words stay between the owner and the people they wrote them for.</p>
  <ol class="board">${rows}</ol>
</section>
<p class="muted small">Written by the executor itself. There is no delete or edit path in the codebase.</p>`;
  return shell({ title: 'Codicil — public notice board', active: 'ledger', demo: v.demo }, body);
}
