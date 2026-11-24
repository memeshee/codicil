// src/executor.ts — carries out the will, in order, once.
//
// Rules from the frozen plan: bounded retry (2 attempts), a failed instruction does not stop
// the rest, every outcome lands on the public notice board with its receipt, and there is no
// re-arming loop — EXECUTED is terminal for that will version.

import type { Briefing, Instruction, Will } from './types.ts';
import { emailSend, githubCreateIssue, slackPostMessage, type ConnectorInfo } from './connectors.ts';
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

/**
 * The sealed block that rides with every delivery. The executor has never seen the
 * passphrase, so this is the honest thing it can say about words it is carrying.
 */
export function sealedBlock(will: Will): string {
  if (!will.sealed) return '';
  const { ct, iv, salt, hint } = will.sealed;
  return [
    '',
    '---',
    'SEALED — this executor cannot read this.',
    'It is ciphertext. The passphrase was never sent to the machine carrying it.',
    hint ? `Hint from the owner: ${hint}` : '',
    '',
    `blob: ${ct}`,
    `iv: ${iv}`,
    `salt: ${salt}`,
    '',
    'Open it at /open on the executor, or with any AES-GCM/PBKDF2 tool. Only the holder of',
    'the passphrase can read it — including after the executor is gone.',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Tell the witnesses. A witness without a reachable channel is not notified, and this
 * says so in the ledger rather than claiming otherwise.
 */
export async function notifyWitnesses(
  deps: Pick<ExecDeps, 'store' | 'connectors' | 'now'>,
  will: Will,
  briefing: Briefing,
  links?: Array<{ id: string; name: string; url: string }>,
): Promise<{ sent: number; unreachable: string[] }> {
  const { store, connectors, now } = deps;
  const sl = connectorFor(connectors, 'slack');
  const sent: string[] = [];
  const unreachable: string[] = [];

  for (const w of store.listWitnesses()) {
    const link = links?.find((l) => l.id === w.id)?.url;
    const text = [
      `${will.owner.name} has gone quiet past their own deadline. You are named in their will.`,
      '',
      briefing.checked.length ? `Checked: ${briefing.checked.join('; ')}` : '',
      briefing.couldNotVerify.length ? `Could not check: ${briefing.couldNotVerify.join('; ')}` : '',
      briefing.suggest.length ? `What you can do: ${briefing.suggest.join('; ')}` : '',
      '',
      link
        ? `Your private notice (the only copy of this link): ${link}`
        : 'Your private notice is the link you were given when the will was signed.',
    ]
      .filter(Boolean)
      .join('\n');

    if (sl && w.slackUserId) {
      const res = await attempt(() => slackPostMessage(sl.id, w.slackUserId!, text));
      if (res.ok) {
        store.markWitnessNotified(w.id);
        store.appendEvent('witness_delivered', { witness: w.id, via: 'slack', ref: refFrom(res.body) }, now);
        sent.push(w.name);
        continue;
      }
      store.appendEvent('witness_delivered', { witness: w.id, via: 'slack', ok: false, reason: `slack ${res.status}` }, now);
      unreachable.push(w.name);
      continue;
    }
    // Email is the second channel, and it is the one most witnesses actually have. It only
    // counts when a mail connector is configured; otherwise the row stays honest.
    const mail = process.env.MAIL_CONNECTOR_ID ?? '';
    const to = (w as { email?: string }).email ?? '';
    if (mail && to) {
      const res = await emailSend(mail, to, `About ${will.owner.name}`, `${will.owner.name} has gone quiet. You are named as a witness. ` +
        `Nothing has been carried out yet. Open your private link to read what was checked, ` +
        `and to say if you know they are safe.`);
      if (res.ok) {
        store.markWitnessNotified(w.id);
        store.appendEvent('witness_delivered', { witness: w.id, via: 'email', ref: to }, now);
        sent.push(w.name);
        continue;
      }
      store.appendEvent('witness_delivered', { witness: w.id, via: 'email', ok: false, reason: `mail ${res.status}` }, now);
      unreachable.push(w.name);
      continue;
    }
    store.appendEvent(
      'witness_delivered',
      {
        witness: w.id,
        ok: false,
        reason: !w.slackUserId && !to
          ? 'no channel on file for this witness'
          : mail ? 'no slack connector granted' : 'no slack or mail connector granted',
      },
      now,
    );
    unreachable.push(w.name);
  }
  return { sent: sent.length, unreachable };
}

/** Every meaningful step is printed, because the demo shows this log on screen. */
function log(line: string): void {
  console.log(`[executor] ${line}`);
}

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

/**
 * The CONCERNED beat: nudge the owner. This is a real connector call, not just a ledger row —
 * the demo script promises a Slack message arrives at the nudge stage, and a promise in the
 * script is a requirement on the code.
 */
export async function sendNudge(
  deps: Pick<ExecDeps, 'store' | 'connectors' | 'now'>,
  will: { owner: { name: string }; instructions: Instruction[] },
  channel: string,
): Promise<{ ok: boolean; ref: string | null; note?: string }> {
  const { store, connectors, now } = deps;
  const sl = connectorFor(connectors, 'slack');
  const text =
    `${will.owner.name} has not checked in. The executor is at CONCERNED and will write to ` +
    `the named witnesses if this is not answered. Reply by checking in.`;
  if (!sl) {
    store.appendEvent('execute_fail', { kind: 'nudge', reason: 'no slack connector granted' }, now);
    return { ok: false, ref: null, note: 'no slack connector granted' };
  }
  const res = await attempt(() => slackPostMessage(sl.id, channel, text));
  if (!res.ok) {
    store.appendEvent('execute_fail', { kind: 'nudge', reason: `slack ${res.status}` }, now);
    return { ok: false, ref: null, note: `slack ${res.status}` };
  }
  const ref = refFrom(res.body);
  store.appendEvent('execute_ok', { kind: 'nudge', target: channel, ref }, now);
  return { ok: true, ref };
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
  log(`investigate: ${investigation.summary}`);

  // 2. Compose the closing note; the owner's words ride verbatim.
  const letter = await composeLetter(will, investigation, mind);
  outcome.letterUsedModel = letter.usedModel;
  store.appendEvent('letter_composed', { usedModel: letter.usedModel, chars: letter.text.length }, now);
  log(`letter composed (${letter.usedModel ? 'model' : 'template'}, ${letter.text.length} chars)`);
  const sealed = sealedBlock(will);
  if (sealed) store.appendEvent('sealed_attached', { bytes: will.sealed?.ct.length ?? 0, readByExecutor: false }, now);

  // 3. Run the instructions in ordinal order.
  const rows = store.listInstructions().filter((r) => r.status === 'pending');
  for (const row of rows) {
    const op = row.params;
    try {
      if (op.kind === 'github_issue') {
        const gh = connectorFor(connectors, 'github');
        if (!gh) throw new Error('no github connector granted');
        const res = await attempt(() =>
          githubCreateIssue(gh.id, op.repo, op.title, `${op.body}\n\n---\n\n${letter.text}${sealed}`),
        );
        if (!res.ok) throw new Error(`github ${res.status} ${res.text.slice(0, 160)}`);
        const ref = refFrom(res.body);
        store.markInstruction(row.id, 'ok', ref);
        store.appendEvent('execute_ok', { kind: op.kind, target: op.repo, ref }, now);
        log(`execute ok: github_issue ${op.repo} → ${ref ?? 'no ref returned'}`);
        outcome.ok += 1;
        outcome.results.push({ kind: op.kind, status: 'ok', ref });
      } else if (op.kind === 'slack_post') {
        const sl = connectorFor(connectors, 'slack');
        if (!sl) throw new Error('no slack connector granted');
        const res = await attempt(() => slackPostMessage(sl.id, op.target, `${letter.text}\n\n${op.text}${sealed}`.trim()));
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
      log(`execute FAILED: ${op.kind} — ${note}`);
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
