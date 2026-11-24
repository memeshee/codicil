// src/evaluator.ts — the state machine (executor-plan.md §2.1 semantics).
//
// FROZEN SEMANTICS: only an owner check-in (POST /api/checkin with the owner token) or a
// witness vouch resets CONCERNED/PLEADING back to ARMED. Investigation NEVER resets — it
// informs witnesses with context. EXECUTED is terminal for that will version.
//
// Pure functions: no I/O, no clock reads. `now` is always passed in, which is what makes
// the transition table testable and the demo driver deterministic.

import type { EventKind, MachineState, Phase, StateSnapshot, Will } from './types.ts';
import { utcDayKey } from './state.ts';

export interface Transition {
  kind: EventKind;
  detail: Record<string, unknown>;
}

export interface EvalResult {
  state: MachineState;
  events: Transition[];
}

const MINUTE = 60_000;

export function minutesSilent(lastCheckIn: string, now: string): number {
  return (Date.parse(now) - Date.parse(lastCheckIn)) / MINUTE;
}

function thresholds(will: Will) {
  const { deadlineMinutes, nudgeGraceMinutes, pleadGraceMinutes } = will.policy;
  return {
    concerned: deadlineMinutes,
    pleading: deadlineMinutes + nudgeGraceMinutes,
    executing: deadlineMinutes + nudgeGraceMinutes + pleadGraceMinutes,
  };
}

/**
 * Advance the machine to the phase the clock demands. Idempotent: running it twice at the
 * same instant produces the same state and no duplicate events, because each step only
 * fires on a phase it has not yet left.
 *
 * Cascades deliberately: if the sprite was asleep through several thresholds, one tick
 * walks it through every phase it owes, emitting the events in order.
 */
export function evaluate(state: MachineState, will: Will | null, now: string): EvalResult {
  const next: MachineState = { ...state, grace: { ...state.grace } };
  const events: Transition[] = [];

  if (!will || next.willVersion === 0 || next.phase === 'DORMANT' || next.phase === 'EXECUTED' || next.phase === 'EXECUTING') {
    return { state: next, events };
  }

  const t = thresholds(will);
  const silent = minutesSilent(next.lastCheckIn, now);

  for (;;) {
    if (next.phase === 'ARMED' && silent >= t.concerned) {
      next.phase = 'CONCERNED';
      next.grace = { nudgeAt: now };
      events.push({ kind: 'phase', detail: { from: 'ARMED', to: 'CONCERNED', silentMinutes: round(silent) } });
      events.push({ kind: 'nudge', detail: { channel: 'slack', reason: 'deadline missed' } });
      continue;
    }
    if (next.phase === 'CONCERNED' && silent >= t.pleading) {
      next.phase = 'PLEADING';
      next.grace = { ...next.grace, pleadAt: now };
      events.push({ kind: 'phase', detail: { from: 'CONCERNED', to: 'PLEADING', silentMinutes: round(silent) } });
      if (!next.investigated) {
        // The marker only; the real investigation (with what it found) is recorded by the
        // executor when it runs, so the board never shows two of them.
        next.investigated = true;
      }
      events.push({ kind: 'witness_notified', detail: { witnesses: will.witnesses.map((w) => w.name) } });
      continue;
    }
    if (next.phase === 'PLEADING' && silent >= t.executing) {
      next.phase = 'EXECUTING';
      events.push({ kind: 'phase', detail: { from: 'PLEADING', to: 'EXECUTING', silentMinutes: round(silent) } });
      continue;
    }
    break;
  }

  return { state: next, events };
}

export interface ResetResult {
  state: MachineState;
  events: Transition[];
}

/** Owner check-in: the only reset that also advances the streak. */
export function applyCheckIn(state: MachineState, will: Will | null, now: string): ResetResult {
  const events: Transition[] = [];
  const next: MachineState = { ...state, grace: {} };
  const dayKey = utcDayKey(now);

  if (will && will.version > 0 && next.phase !== 'DORMANT') {
    if (next.phase === 'EXECUTED') {
      // Terminal for this will version: keep EXECUTED until a new version is signed.
      events.push({ kind: 'return_of_owner', detail: { willVersion: next.willVersion, note: 'receipts shown; re-arm requires a new will version' } });
      return { state: next, events };
    }
    if (next.phase !== 'ARMED') {
      events.push({ kind: 'phase', detail: { from: next.phase, to: 'ARMED', reason: 'owner check-in' } });
    }
    next.phase = 'ARMED';
    next.investigated = false;
  }

  next.lastCheckIn = now;
  if (dayKey !== next.lastDayKey) {
    next.streakDays += 1;
    next.lastDayKey = dayKey;
  }
  events.push({ kind: 'checkin', detail: { streakDays: next.streakDays, day: dayKey } });
  return { state: next, events };
}

/** Witness vouch: stands the clock down, but does not count toward the owner's streak. */
export function applyVouch(state: MachineState, witnessId: string, now: string): ResetResult {
  const events: Transition[] = [];
  const next: MachineState = { ...state, grace: {} };
  const from = next.phase;
  if (from === 'CONCERNED' || from === 'PLEADING') {
    next.phase = 'ARMED';
    next.investigated = false;
    next.lastCheckIn = now;
    events.push({ kind: 'phase', detail: { from, to: 'ARMED', reason: 'witness vouch' } });
  }
  events.push({ kind: 'vouch', detail: { witnessId, from, phase: next.phase } });
  return { state: next, events };
}

/** Signing a will (new or updated) always re-arms — including after EXECUTED, as a new version. */
export function applyWillSigned(state: MachineState, will: Will, now: string): ResetResult {
  const events: Transition[] = [];
  const next: MachineState = {
    ...state,
    phase: 'ARMED',
    willVersion: will.version,
    grace: {},
    investigated: false,
    lastCheckIn: now,
  };
  events.push({ kind: 'will_signed', detail: { version: will.version, instructions: will.instructions.length, witnesses: will.witnesses.length } });
  return { state: next, events };
}

export function toSnapshot(state: MachineState, will: Will | null): StateSnapshot {
  return {
    phase: state.phase,
    lastCheckIn: state.lastCheckIn,
    streakDays: state.streakDays,
    lastTickAt: state.lastTickAt,
    grace: state.grace,
    willVersion: will?.version ?? state.willVersion,
  };
}

/** Milliseconds until the next phase boundary, for the home page countdown. */
export function msToNextBoundary(state: MachineState, will: Will | null, now: string): number | null {
  if (!will || state.phase === 'DORMANT' || state.phase === 'EXECUTING' || state.phase === 'EXECUTED') return null;
  const t = thresholds(will);
  const target =
    state.phase === 'ARMED' ? t.concerned : state.phase === 'CONCERNED' ? t.pleading : t.executing;
  const due = Date.parse(state.lastCheckIn) + target * MINUTE;
  return Math.max(0, due - Date.parse(now));
}

export function round(n: number): number {
  return Math.round(n * 10) / 10;
}

export const PHASE_ORDER: Phase[] = ['DORMANT', 'ARMED', 'CONCERNED', 'PLEADING', 'EXECUTING', 'EXECUTED'];
