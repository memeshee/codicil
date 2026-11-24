// src/executor.ts — carries out the will, in order, once.
//
// Rules from the frozen plan: bounded retry (2 attempts), a failed instruction does not stop
// the rest, every outcome lands on the public notice board with its receipt, and there is no
// re-arming loop — EXECUTED is terminal for that will version.

import type { Instruction } from './types.ts';
import { githubCreateIssue, slackPostMessage, type ConnectorInfo } from './connectors.ts';
import { composeLetter, investigate, type MindContext } from './mind.ts';
import type { Store } from './state.ts';

export interface ExecDeps {
  store: Store;
  connectors: ConnectorInfo[];
  mind: MindContext;
  now: string;
}

export interface ExecOutcome {
  ok: number;
  failed: number;
  letterUsedModel: boolean;
  results: Array<{ kind: Instruction['kind']; status: string; ref: string | null; note?: string }>;
}

const LOCK_KEY = 'executionLock';
const LOCK_TTL_MS = 15 * 60_000;

function connectorFor(list: ConnectorInfo[], name: string): ConnectorInfo | null {
  return list.find((c) => c.provider.toLowerCase().includes(name)) ?? null;
}

async function attempt<T>(fn: () => Promise<{ ok: boolean; status: number; body: T | null; text: string; unreachable?: string }>) {
  const first = await fn();
  if (first.ok) return first;
  await new Promise((r) => setTimeout(r, 700));
  return fn();
}

function refFrom(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const o = payload as Record<string, unknown>;
  if (typeof o.html_url === 'string') return o.html_url;
  if (typeof o.ts === 'string' && typeof o.channel === 'string') return `https://slack.com/app_redirect?channel=${o.channel}&ts=${o.ts}`;
  if (typeof o.location === 'string') return o.location;
  if (typeof o.id === 'string') return o.id;
  return null;
}

export async function executeWill(deps: ExecDeps): Promise<ExecOutcome> {
  const { store, connectors, mind, now } = deps;

  const lock = store.getKVPublic<{ at: string }>(LOCK_KEY);
  if (lock && Date.now() - Date.parse(lock.at) < LOCK_TTL_MS) {
    return { ok: 0, failed: 0, letterUsedModel: false, results: [] };
  }
  store.setKVPublic(LOCK_KEY, { at: now });

  const will = store.getWill();
  const outcome: ExecOutcome = { ok: 0, failed: 0, letterUsedModel: false, results: [] };
  if (!will) {
    store.setKVPublic(LOCK_KEY, { at: '1970-01-01T00:00:00Z' });
    return outcome;
  }

  // 1. Investigate (read-only, never resets the clock).
  const investigation = await investigate(will, mind);
  store.appendEvent('investigate', { source: investigation.source, summary: investigation.summary, ...investigation.detail }, now);

  // 2. Compose the closing note; the owner's words ride verbatim.
  const letter = await composeLetter(will, investigation, mind);
  outcome.letterUsedModel = letter.usedModel;
  store.appendEvent('letter_composed', { usedModel: letter.usedModel, chars: letter.text.length }, now);

  // 3. Run the instructions in ordinal order.
  const rows = store.listInstructions().filter((r) => r.status === 'pending');
  for (const row of rows) {
    const op = row.params;
    try {
      if (op.kind === 'github_issue') {
        const gh = connectorFor(connectors, 'github');
        if (!gh) throw new Error('no github connector granted');
        const res = await attempt(() => githubCreateIssue(gh.id, op.repo, op.title, `${op.body}\n\n---\n\n${letter.text}`));
        if (!res.ok) throw new Error(`github ${res.status} ${res.text.slice(0, 160)}`);
        const ref = refFrom(res.body);
        store.markInstruction(row.id, 'ok', ref);
        store.appendEvent('execute_ok', { kind: op.kind, target: op.repo, ref }, now);
        outcome.ok += 1;
        outcome.results.push({ kind: op.kind, status: 'ok', ref });
      } else if (op.kind === 'slack_post') {
        const sl = connectorFor(connectors, 'slack');
        if (!sl) throw new Error('no slack connector granted');
        const res = await attempt(() => slackPostMessage(sl.id, op.target, `${letter.text}\n\n${op.text}`.trim()));
        if (!res.ok) throw new Error(`slack ${res.status} ${res.text.slice(0, 160)}`);
        const ref = refFrom(res.body);
        store.markInstruction(row.id, 'ok', ref);
        store.appendEvent('execute_ok', { kind: op.kind, target: op.target, ref }, now);
        outcome.ok += 1;
        outcome.results.push({ kind: op.kind, status: 'ok', ref });
      } else if (op.kind === 's3_put' || op.kind === 'email_send') {
        // SHOULD-ship ops: no connector granted in this deployment yet. Recorded honestly
        // rather than silently skipped.
        store.markInstruction(row.id, 'skipped', null);
        store.appendEvent('execute_fail', { kind: op.kind, reason: 'no connector configured for this instruction' }, now);
        outcome.failed += 1;
        outcome.results.push({ kind: op.kind, status: 'skipped', ref: null, note: 'not wired in this deployment' });
      } else {
        store.markInstruction(row.id, 'skipped', null);
        outcome.results.push({ kind: op.kind, status: 'skipped', ref: null });
      }
    } catch (err) {
      const note = err instanceof Error ? err.message : String(err);
      store.markInstruction(row.id, 'failed', null);
      store.appendEvent('execute_fail', { kind: op.kind, reason: note }, now);
      outcome.failed += 1;
      outcome.results.push({ kind: op.kind, status: 'failed', ref: null, note });
    }
  }

  // 4. Terminal for this will version.
  const state = store.getState(now);
  const from = state.phase;
  state.phase = 'EXECUTED';
  store.setState(state);
  store.appendEvent('phase', { from, to: 'EXECUTED', executed: outcome.ok, failed: outcome.failed }, now);
  store.setKVPublic(LOCK_KEY, { at: '1970-01-01T00:00:00Z' });

  return outcome;
}
