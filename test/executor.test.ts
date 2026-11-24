// test/executor.test.ts — the execution path, against a shimmed gateway.
//
// Two properties matter more than any other: the gateway call never carries an Authorization
// header (the trust claim), and one failing instruction does not stop the rest.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/state.ts';
import { executeWill } from '../src/executor.ts';
import type { ConnectorInfo } from '../src/connectors.ts';
import type { Instruction, Will } from '../src/types.ts';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

const realFetch = globalThis.fetch;
let calls: Call[] = [];

type Handler = (call: Call, n: number) => { status: number; body: unknown };

function installFetch(handler: Handler): void {
  let n = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = String(v);
    const call: Call = { url, method: init?.method ?? 'GET', headers, body: String(init?.body ?? '') };
    calls.push(call);
    const { status, body } = handler(call, n++);
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return { ok: status < 400, status, text: async () => text } as unknown as Response;
  }) as typeof fetch;
}

const CONNECTORS: ConnectorInfo[] = [
  { id: 'gh-1', provider: 'github', raw: {} },
  { id: 'sl-1', provider: 'slack', raw: {} },
];

function will(instructions: Instruction[]): Will {
  return {
    version: 1,
    owner: { name: 'kiter', github: 'PhiBao' },
    letter: 'Water the fig. Tell Ada the thing about the boat.',
    policy: { deadlineMinutes: 1, nudgeGraceMinutes: 1, pleadGraceMinutes: 1 },
    instructions,
    witnesses: [{ name: 'Ada' }],
    createdAt: '2026-11-24T00:00:00.000Z',
    updatedAt: '2026-11-24T00:00:00.000Z',
  };
}

function storeWith(instructions: Instruction[]): Store {
  const dir = mkdtempSync(join(tmpdir(), 'codicil-exec-'));
  const store = new Store(join(dir, 'exec.db'));
  const w = will(instructions);
  store.setWill(w);
  store.replaceInstructions(instructions);
  store.replaceWitnesses(w.witnesses);
  const state = store.getState();
  state.phase = 'EXECUTING';
  state.willVersion = 1;
  state.lastCheckIn = '2026-11-24T00:00:00.000Z';
  store.setState(state);
  return store;
}

const NOW = '2026-11-24T01:00:00.000Z';
const mind = { connectors: CONNECTORS, provider: 'none' as const, model: 'glm-5.3' };

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test('executes both instructions, records receipts, and lands on EXECUTED', async () => {
  installFetch((call) => {
    if (call.url.includes('/users/')) return { status: 200, body: [{ created_at: '2026-11-20T00:00:00Z' }] };
    if (call.url.includes('/issues')) return { status: 201, body: { html_url: 'https://github.com/memeshee/codicil/issues/7' } };
    return { status: 200, body: { ok: true, ts: '1732.0001', channel: 'C0TEST' } };
  });
  const store = storeWith([
    { kind: 'github_issue', repo: 'memeshee/codicil', title: 'A last word', body: '' },
    { kind: 'slack_post', target: 'C0TEST', text: '' },
  ]);

  const out = await executeWill({ store, connectors: CONNECTORS, mind, now: NOW });

  assert.equal(out.ok, 2);
  assert.equal(out.failed, 0);
  assert.equal(store.getState(NOW).phase, 'EXECUTED');
  const rows = store.listInstructions();
  assert.deepEqual(rows.map((r) => r.status), ['ok', 'ok']);
  assert.equal(rows[0]!.resultRef, 'https://github.com/memeshee/codicil/issues/7');
  assert.ok(rows[1]!.resultRef?.includes('C0TEST'));
  store.close();
});

test('no connector call ever carries an Authorization header', async () => {
  installFetch((call) => {
    if (call.url.includes('/users/')) return { status: 200, body: [] };
    if (call.url.includes('/issues')) return { status: 201, body: { html_url: 'https://x/1' } };
    return { status: 200, body: { ok: true, ts: '1', channel: 'C0' } };
  });
  const store = storeWith([
    { kind: 'github_issue', repo: 'a/b', title: 't', body: '' },
    { kind: 'slack_post', target: 'C0', text: '' },
  ]);

  await executeWill({ store, connectors: CONNECTORS, mind, now: NOW });

  assert.ok(calls.length >= 3);
  for (const c of calls) {
    assert.equal(c.headers['authorization'], undefined, `Authorization header leaked on ${c.url}`);
    assert.ok(c.url.startsWith('https://api.sprites.dev/v1/gateway/'), c.url);
  }
  store.close();
});

test('a transient failure is retried once and still succeeds', async () => {
  let slackAttempts = 0;
  installFetch((call) => {
    if (call.url.includes('/users/')) return { status: 200, body: [] };
    if (call.url.includes('chat.postMessage')) {
      slackAttempts += 1;
      return slackAttempts === 1 ? { status: 503, body: { error: 'slow down' } } : { status: 200, body: { ok: true, ts: '2', channel: 'C0' } };
    }
    return { status: 200, body: {} };
  });
  const store = storeWith([{ kind: 'slack_post', target: 'C0', text: '' }]);

  const out = await executeWill({ store, connectors: CONNECTORS, mind, now: NOW });

  assert.equal(slackAttempts, 2, 'expected exactly one retry');
  assert.equal(out.ok, 1);
  assert.equal(store.listInstructions()[0]!.status, 'ok');
  store.close();
});

test('one failing instruction does not stop the next one, and the failure is on the board', async () => {
  installFetch((call) => {
    if (call.url.includes('/users/')) return { status: 200, body: [] };
    if (call.url.includes('/issues')) return { status: 500, body: { message: 'boom' } };
    return { status: 200, body: { ok: true, ts: '3', channel: 'C0' } };
  });
  const store = storeWith([
    { kind: 'github_issue', repo: 'a/b', title: 't', body: '' },
    { kind: 'slack_post', target: 'C0', text: '' },
  ]);

  const out = await executeWill({ store, connectors: CONNECTORS, mind, now: NOW });

  assert.equal(out.ok, 1);
  assert.equal(out.failed, 1);
  const rows = store.listInstructions();
  assert.deepEqual(rows.map((r) => r.status), ['failed', 'ok']);
  const kinds = store.listEvents().map((e) => e.kind);
  assert.ok(kinds.includes('execute_fail'));
  assert.ok(kinds.includes('execute_ok'));
  assert.equal(store.getState(NOW).phase, 'EXECUTED', 'a failure still ends the run — one attempt, no loop');
  store.close();
});

test('instructions with no connector configured are skipped honestly, not silently', async () => {
  installFetch((call) => (call.url.includes('/users/') ? { status: 200, body: [] } : { status: 200, body: {} }));
  const store = storeWith([
    { kind: 's3_put', key: 'letter.txt', bodyPath: 'letter' },
    { kind: 'email_send', to: 'a@b.c', subject: 's', body: '' },
  ]);

  const out = await executeWill({ store, connectors: CONNECTORS, mind, now: NOW });

  assert.equal(out.failed, 2);
  const rows = store.listInstructions();
  assert.deepEqual(rows.map((r) => r.status), ['skipped', 'skipped']);
  const fails = store.listEvents().filter((e) => e.kind === 'execute_fail');
  assert.equal(fails.length, 2);
  store.close();
});

test('a second call inside the lock window does not re-run execution', async () => {
  installFetch((call) => {
    if (call.url.includes('/users/')) return { status: 200, body: [] };
    return { status: 200, body: { ok: true, ts: '9', channel: 'C0' } };
  });
  const store = storeWith([{ kind: 'slack_post', target: 'C0', text: '' }]);

  const first = await executeWill({ store, connectors: CONNECTORS, mind, now: NOW });
  assert.equal(first.ok, 1);
  // The lock is released at the end of a successful run (terminal EXECUTED), so a second call
  // must find no pending instructions rather than executing them twice.
  const second = await executeWill({ store, connectors: CONNECTORS, mind, now: NOW });
  assert.equal(second.ok, 0);
  assert.equal(store.listInstructions().filter((r) => r.status === 'ok').length, 1);
  store.close();
});
