// test/evaluator.test.ts — the transition table is the trust contract; every cell is asserted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCheckIn, applyVouch, applyWillSigned, evaluate, msToNextBoundary, minutesSilent } from '../src/evaluator.ts';
import { initialState } from '../src/state.ts';
import type { MachineState, Will } from '../src/types.ts';

const T0 = '2026-11-24T00:00:00.000Z';

function will(overrides: Partial<Will['policy']> = {}): Will {
  return {
    version: 1,
    owner: { name: 'kiter', github: 'PhiBao' },
    letter: 'Water the fig.',
    policy: { deadlineMinutes: 60, nudgeGraceMinutes: 30, pleadGraceMinutes: 30, ...overrides },
    instructions: [{ kind: 'slack_post', target: 'C0TEST', text: '' }],
    witnesses: [{ name: 'Ada' }],
    createdAt: T0,
    updatedAt: T0,
  };
}

function armedAt(startIso = T0): MachineState {
  return { ...initialState(startIso), phase: 'ARMED', willVersion: 1, lastCheckIn: startIso };
}

const at = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();

test('DORMANT never escalates, even long past the deadline', () => {
  const s = { ...initialState(T0), phase: 'DORMANT' as const };
  const { state, events } = evaluate(s, will(), at(10_000));
  assert.equal(state.phase, 'DORMANT');
  assert.equal(events.length, 0);
});

test('ARMED -> CONCERNED exactly at the deadline, with a nudge', () => {
  const before = evaluate(armedAt(), will(), at(59));
  assert.equal(before.state.phase, 'ARMED');
  const after = evaluate(armedAt(), will(), at(60));
  assert.equal(after.state.phase, 'CONCERNED');
  assert.deepEqual(after.events.map((e) => e.kind), ['phase', 'nudge']);
});

test('cascade: one tick long past every threshold walks ARMED -> PLEADING -> EXECUTING', () => {
  const { state, events } = evaluate(armedAt(), will(), at(60 + 30 + 30 + 1));
  assert.equal(state.phase, 'EXECUTING');
  assert.deepEqual(events.map((e) => e.kind), ['phase', 'nudge', 'phase', 'witness_notified', 'phase']);
});

test('the investigation marker is set once, and the executor records the finding itself', () => {
  const { state } = evaluate(armedAt(), will(), at(95));
  assert.equal(state.investigated, true);
  assert.equal(evaluate(state, will(), at(96)).state.investigated, true);
});

test('idempotent: the same instant twice produces no duplicate events', () => {
  const first = evaluate(armedAt(), will(), at(75));
  const second = evaluate(first.state, will(), at(75));
  assert.equal(second.events.length, 0);
  assert.equal(second.state.phase, first.state.phase);
});

test('witnesses are written to once per silence, not once per tick', () => {
  const first = evaluate(armedAt(), will(), at(95));
  assert.equal(first.events.filter((e) => e.kind === 'witness_notified').length, 1);
  const again = evaluate({ ...first.state }, will(), at(96));
  assert.equal(again.events.filter((e) => e.kind === 'witness_notified').length, 0);
});

test('owner check-in resets CONCERNED to ARMED and counts the streak once per UTC day', () => {
  const concerned = { ...armedAt(), phase: 'CONCERNED' as const, grace: { nudgeAt: at(61) } };
  const r = applyCheckIn(concerned, will(), '2026-11-24T12:00:00.000Z');
  assert.equal(r.state.phase, 'ARMED');
  assert.equal(r.state.streakDays, 1);
  assert.deepEqual(r.state.grace, {});
  const sameDay = applyCheckIn(r.state, will(), '2026-11-24T18:00:00.000Z');
  assert.equal(sameDay.state.streakDays, 1, 'a second check-in on the same UTC day does not inflate the streak');
  const nextDay = applyCheckIn(sameDay.state, will(), '2026-11-25T01:00:00.000Z');
  assert.equal(nextDay.state.streakDays, 2);
});

test('a witness vouch stands the clock down without advancing the owner streak', () => {
  const pleading = { ...armedAt(), phase: 'PLEADING' as const };
  const r = applyVouch(pleading, 'abc123', at(100));
  assert.equal(r.state.phase, 'ARMED');
  assert.equal(r.state.streakDays, 0);
  assert.equal(r.events[0]?.kind, 'phase');
  assert.equal(r.events.at(-1)?.kind, 'vouch');
});

test('investigation alone never resets: only a check-in or a vouch does', () => {
  const first = evaluate(armedAt(), will(), at(95)); // PLEADING, investigated
  assert.equal(first.state.phase, 'PLEADING');
  const second = evaluate(first.state, will(), at(96));
  assert.equal(second.state.phase, 'PLEADING');
});

test('EXECUTED is terminal for that will version; an owner check-in returns receipts, not a reset', () => {
  const executed: MachineState = { ...armedAt(), phase: 'EXECUTED' };
  const r = applyCheckIn(executed, will(), at(200));
  assert.equal(r.state.phase, 'EXECUTED');
  assert.equal(r.events[0]?.kind, 'return_of_owner');
  const resigned = applyWillSigned(r.state, { ...will(), version: 2 }, at(201));
  assert.equal(resigned.state.phase, 'ARMED');
  assert.equal(resigned.state.willVersion, 2);
});

test('minute arithmetic tolerates sub-minute demo graces', () => {
  assert.equal(minutesSilent(T0, at(1.5)), 1.5);
  const { state } = evaluate(armedAt(), will({ deadlineMinutes: 0.1, nudgeGraceMinutes: 0.1, pleadGraceMinutes: 0.1 }), at(0.31));
  assert.equal(state.phase, 'EXECUTING');
});

test('countdown shrinks to the next boundary, and is null when nothing is pending', () => {
  const ms = msToNextBoundary(armedAt(), will(), at(30));
  assert.equal(ms, 30 * 60_000);
  assert.equal(msToNextBoundary({ ...armedAt(), phase: 'EXECUTED' }, will(), at(30)), null);
});
