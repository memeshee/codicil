// src/ledger.ts — data shaping for the PUBLIC NOTICE board.
// Renders event metadata and public refs only. Letter bodies never appear here.

import type { Event, EventKind } from './types.ts';

export interface NoticeRow {
  ts: string;
  day: string;
  time: string;
  kind: EventKind;
  label: string;
  detail: string;
  ref?: string;
}

const LABELS: Record<EventKind, string> = {
  boot: 'came up',
  will_signed: 'will sealed',
  checkin: 'owner checked in',
  tick: 'clock tick',
  phase: 'phase change',
  investigate: 'investigated',
  nudge: 'nudged owner',
  witness_notified: 'witnesses notified',
  witness_delivered: 'notice delivered',
  vouch: 'witness vouched',
  quorum: 'witness answer',
  revoked: 'will withdrawn',
  token_rotated: 'owner token rotated',
  sealed_attached: 'sealed letter carried',
  chain_break: 'chain break',
  letter_composed: 'letter composed',
  execute_ok: 'instruction carried out',
  execute_fail: 'instruction failed',
  return_of_owner: 'owner returned after execution',
};

/** Events that are noise on a public page. A tick is machine heartbeat, not a notice. */
const HIDDEN: EventKind[] = ['tick', 'boot'];

function isDemo(detail: Record<string, unknown>): boolean {
  return detail.demo === true;
}

export function toNotice(e: Event): NoticeRow | null {
  if (HIDDEN.includes(e.kind)) return null;
  const iso = e.ts.endsWith('Z') ? e.ts : `${e.ts}Z`;
  const d = new Date(iso);
  const row: NoticeRow = {
    ts: iso,
    day: d.toISOString().slice(0, 10),
    time: d.toISOString().slice(11, 16),
    kind: e.kind,
    label: LABELS[e.kind] ?? e.kind,
    detail: summarise(e),
  };
  const ref = e.detail.ref;
  if (typeof ref === 'string') row.ref = ref;
  if (isDemo(e.detail)) row.label = `${row.label} · demo`;
  return row;
}

function summarise(e: Event): string {
  const d = e.detail;
  switch (e.kind) {
    case 'phase':
      return `${String(d.from ?? '?')} → ${String(d.to ?? '?')}${d.reason ? ` (${String(d.reason)})` : ''}`;
    case 'checkin':
      return `streak ${String(d.streakDays ?? '?')} day${d.streakDays === 1 ? '' : 's'}`;
    case 'will_signed':
      return `version ${String(d.version ?? '?')} · ${String(d.instructions ?? 0)} instruction(s) · ${String(d.witnesses ?? 0)} witness(es)`;
    case 'witness_notified':
      return Array.isArray(d.witnesses) ? (d.witnesses as string[]).join(', ') : 'witnesses';
    case 'vouch':
      return `witness ${String(d.witnessId ?? '')}`.trim();
    case 'investigate':
      return `${String(d.source ?? 'source')} · ${String(d.owner ?? '')}`;
    case 'execute_ok':
    case 'execute_fail':
      return `${String(d.kind ?? 'instruction')}${d.target ? ` → ${String(d.target)}` : ''}`;
    case 'return_of_owner':
      return `will version ${String(d.willVersion ?? '?')} already executed`;
    default:
      return Object.keys(d).length ? JSON.stringify(d) : '';
  }
}

export function noticeBoard(events: Event[], limit = 200): NoticeRow[] {
  return events
    .map(toNotice)
    .filter((r): r is NoticeRow => r !== null)
    .slice(-limit)
    .reverse();
}
