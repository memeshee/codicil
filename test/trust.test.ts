// test/trust.test.ts — the rules added after the product review: quorum, a bounded vouch
// budget, revocation, the tamper-evident chain, and a sealed letter the box cannot read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, hashToken } from '../src/state.ts';
import { applyCheckIn, applyRevoke, applyVouch, applyWillSigned, evaluate } from '../src/evaluator.ts';
import { sealedBlock } from '../src/executor.ts';
import type { MachineState, Will } from '../src/types.ts';

const at = (min: number) => new Date(Date.UTC(2026, 10, 24, 0, min, 0)).toISOString();

function will(over: Partial<Will> = {}): Will {
  return {
    version: 1,
    owner: { name: 'kiter', github: 'PhiBao' },
    letter: 'water the fig tree',
    policy: { deadlineMinutes: 60, nudgeGraceMinutes: 30, pleadGraceMinutes: 30, vouchQuorum: 1 },
    instructions: [{ kind: 'slack_post', target: 'C1', text: '' }],
    witnesses: [{ name: 'Ada' }],
    createdAt: at(0),
    updatedAt: at(0),
    ...over,
  };
}

const armed = (): MachineState => ({
  phase: 'ARMED',
  lastCheckIn: at(0),
  streakDays: 3,
  lastDayKey: '2026-11-24',
  lastTickAt: null,
  grace: {},
  willVersion: 1,
  investigated: false,
  vouchIds: [],
  vouchResets: 0,
});

test('quorum: the first vouch is counted, only the second stands the clock down', () => {
  const w = will({ policy: { deadlineMinutes: 60, nudgeGraceMinutes: 30, pleadGraceMinutes: 30, vouchQuorum: 2 } });
  const pleading: MachineState = { ...armed(), phase: 'PLEADING' };

  const first = applyVouch(pleading, 'w1', at(100), w);
  assert.equal(first.state.phase, 'PLEADING');
  assert.deepEqual(first.state.vouchIds, ['w1']);
  const counted = first.events.find((e) => e.kind === 'quorum');
  assert.equal((counted?.detail as { needed: number }).needed, 2);

  const second = applyVouch(first.state, 'w2', at(101), w);
  assert.equal(second.state.phase, 'ARMED');
  assert.equal(second.state.vouchResets, 1);
  assert.deepEqual(second.state.vouchIds, []);
});

test('within one silence, a witness cannot vouch twice toward the quorum', () => {
  const w = will({ policy: { deadlineMinutes: 60, nudgeGraceMinutes: 30, pleadGraceMinutes: 30, vouchQuorum: 2 } });
  const pleading: MachineState = { ...armed(), phase: 'PLEADING' };
  const once = applyVouch(pleading, 'w1', at(100), w);
  assert.deepEqual(once.state.vouchIds, ['w1']);

  const twice = applyVouch(once.state, 'w1', at(101), w);
  assert.equal(twice.state.phase, 'PLEADING', 'one person cannot reach a quorum of two');
  assert.deepEqual(twice.state.vouchIds, ['w1']);
  const refusal = twice.events.find((e) => e.kind === 'quorum');
  assert.match(String((refusal?.detail as { reason: string }).reason), /already vouched/);
});

test('the vouch budget stops witnesses keeping a will alive forever', () => {
  let s: MachineState = { ...armed(), phase: 'PLEADING' };
  s = applyVouch(s, 'w1', at(100), will()).state;      // reset #1
  assert.equal(s.vouchResets, 1);
  s = { ...s, phase: 'PLEADING' };
  s = applyVouch(s, 'w2', at(200), will()).state;      // reset #2
  assert.equal(s.vouchResets, 2);
  s = { ...s, phase: 'PLEADING' };
  const third = applyVouch(s, 'w3', at(300), will());  // refused
  assert.equal(third.state.phase, 'PLEADING');
  const refusal = third.events.find((e) => e.kind === 'quorum');
  assert.match(String((refusal?.detail as { reason: string }).reason), /budget spent/);
});

test('an owner check-in restores the witnesses\' budget', () => {
  const spent: MachineState = { ...armed(), phase: 'PLEADING', vouchResets: 2, vouchIds: ['w1'] };
  const r = applyCheckIn(spent, will(), at(400));
  assert.equal(r.state.vouchResets, 0);
  assert.deepEqual(r.state.vouchIds, []);
  assert.equal(r.state.phase, 'ARMED');
});

test('revocation is terminal and a new version is the only way back', () => {
  const revoked = applyRevoke(armed(), 'owner withdrew consent', at(50));
  assert.equal(revoked.state.phase, 'REVOKED');
  assert.equal(revoked.state.revokedAt, at(50));
  // The clock cannot walk a revoked will into an execution, no matter how silent it is.
  const later = evaluate(revoked.state, will(), at(999));
  assert.equal(later.state.phase, 'REVOKED');
  const resigned = applyWillSigned(revoked.state, { ...will(), version: 2 }, at(1000));
  assert.equal(resigned.state.phase, 'ARMED');
  assert.equal(resigned.state.revokedAt, undefined);
});

test('the notice board chain verifies, and notices an edited row', () => {
  const store = new Store(':memory:');
  store.appendEvent('boot', { n: 1 }, at(0));
  store.appendEvent('checkin', { streakDays: 1 }, at(1));
  store.appendEvent('phase', { from: 'ARMED', to: 'CONCERNED' }, at(2));

  const ok = store.verifyChain();
  assert.equal(ok.ok, true);
  assert.equal(ok.checked, 3);
  assert.equal(ok.head?.length, 64);

  // Rewrite history the way a dishonest operator would, in one column, and see the chain fail.
  store.db.prepare("UPDATE events SET detail = '{\"streakDays\":99}' WHERE id = 2").run();
  const broken = store.verifyChain();
  assert.equal(broken.ok, false);
  assert.equal(broken.brokenAtId, 2);
  store.close();
});

test('a reopened database backfills the chain rather than refusing to open', () => {
  const path = `/tmp/codicil-chain-${Date.now()}.db`;
  const first = new Store(path);
  first.appendEvent('boot', {}, at(0));
  // Simulate a pre-chain database.
  first.db.prepare('UPDATE events SET prev_hash = NULL, row_hash = NULL').run();
  first.close();

  const second = new Store(path);
  const result = second.verifyChain();
  assert.equal(result.ok, true);
  assert.equal(result.checked, 1);
  second.close();
});

test('the sealed block is delivered as ciphertext the executor cannot read', () => {
  const blob = { ct: 'AAAAciphertext', iv: 'BBBBiv', salt: 'CCCCsalt', hint: 'our first flat' };
  const text = sealedBlock(will({ sealed: blob }));
  assert.match(text, /cannot read this/);
  assert.match(text, /AAAAciphertext/);
  assert.match(text, /our first flat/);
  assert.equal(sealedBlock(will()), '', 'a will with nothing sealed adds nothing');
});

test('owner tokens are stored and compared as hashes, never as the token', () => {
  const store = new Store(':memory:');
  const token = 'sup3r-secret-token-value';
  store.setOwnerTokenHash(hashToken(token));
  assert.equal(store.getOwnerTokenHash(), hashToken(token));
  assert.ok(!String(store.getOwnerTokenHash()).includes(token));
  store.close();
});
