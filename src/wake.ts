// src/wake.ts — the one high-risk unknown, handled honestly.
//
// A Sprite has no scheduler: it pauses ~30s after activity stops and runs again only on an
// inbound request, or while a Task holds it (max 1h, renewable). So this module does two
// things and nothing clever:
//   1. onWake() — every inbound request runs the evaluator once, idempotently.
//   2. hold()   — while EXECUTING, ask the platform to keep the box up through the task API,
//                 so a multi-step execution is not interrupted halfway. Best-effort: outside
//                 a Sprite the socket is absent and this is a no-op with a recorded reason.

import { request as httpRequest } from 'node:http';
import type { EventKind, MachineState, Will } from './types.ts';
import { evaluate, type Transition } from './evaluator.ts';
import type { Store } from './state.ts';

export interface WakeResult {
  state: MachineState;
  transitions: Transition[];
  executed: boolean;
}

const SOCK = '/.sprite/api.sock';

function apiCall(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; text: string; reason?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: { ok: boolean; status: number; text: string; reason?: string }) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    try {
      const req = httpRequest(
        { socketPath: SOCK, path, method, headers: { host: 'sprite', 'content-type': 'application/json' } },
        (res) => {
          let text = '';
          res.on('data', (c) => (text += String(c)));
          res.on('end', () => done({ ok: (res.statusCode ?? 500) < 400, status: res.statusCode ?? 0, text }));
        },
      );
      req.on('error', (err) => done({ ok: false, status: 0, text: '', reason: err.message }));
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    } catch (err) {
      done({ ok: false, status: 0, text: '', reason: err instanceof Error ? err.message : String(err) });
    }
  });
}

/** Hold the Sprite active for a short window; renew with another call before it expires. */
export async function hold(name = 'executor', expire = '10m') {
  return apiCall('PUT', `/v1/tasks/${name}`, { expire });
}

export async function release(name = 'executor') {
  return apiCall('DELETE', `/v1/tasks/${name}`);
}

export async function listHolds() {
  return apiCall('GET', '/v1/tasks');
}

/**
 * Run the state machine once. Called on every inbound request; safe to call twice in the
 * same millisecond because transitions only fire on a phase they have not yet left.
 */
export async function onWake(store: Store, now: string): Promise<WakeResult> {
  const state = store.getState(now);
  const will = store.getWill();
  const { state: next, events } = evaluate(state, will, now);

  const transitions: Transition[] = [];
  for (const ev of events) {
    store.appendEvent(ev.kind as EventKind, ev.detail, now);
    transitions.push(ev);
  }
  if (next.phase !== state.phase || next.grace.nudgeAt !== state.grace.nudgeAt || next.investigated !== state.investigated) {
    store.setState(next);
  }

  let executed = false;
  if (next.phase === 'EXECUTING') {
    await hold('executor', '10m');
    executed = true; // the server drains EXECUTING -> EXECUTED via the executor
  }
  return { state: next, transitions, executed };
}

export function recordTick(store: Store, now: string): void {
  const state = store.getState(now);
  state.lastTickAt = now;
  store.setState(state);
  store.appendEvent('tick', { at: now }, now);
}

export function graceSummary(will: Will | null): string {
  if (!will) return 'no will signed';
  const { deadlineMinutes, nudgeGraceMinutes, pleadGraceMinutes } = will.policy;
  return `${deadlineMinutes}m deadline · ${nudgeGraceMinutes}m nudge grace · ${pleadGraceMinutes}m plead grace`;
}
