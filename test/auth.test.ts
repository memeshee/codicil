// test/auth.test.ts — token handling and the store round-trips.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, hashToken, newToken, tokenMatches, utcDayKey } from '../src/state.ts';

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), 'codicil-test-'));
  return new Store(join(dir, 'test.db'));
}

test('tokens are random, url-safe, and never stored in the clear', () => {
  const a = newToken();
  const b = newToken();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]{32}$/);
  assert.notEqual(hashToken(a), a);
});

test('tokenMatches accepts the real token and rejects everything else', () => {
  const token = newToken();
  const hash = hashToken(token);
  assert.equal(tokenMatches(token, hash), true);
  assert.equal(tokenMatches(newToken(), hash), false);
  assert.equal(tokenMatches('', hash), false);
  assert.equal(tokenMatches(token, null), false);
  assert.equal(tokenMatches(token, 'deadbeef'), false, 'malformed hash must not throw');
});

test('a witness token round-trips through the store, and the plaintext is never persisted', () => {
  const store = freshStore();
  const created = store.replaceWitnesses([{ name: 'Ada' }, { name: 'Grace', email: 'g@example.com' }]);
  assert.equal(created.length, 2);
  const ada = created[0]!;
  assert.equal(store.getWitness(ada.row.id)?.name, 'Ada');
  assert.equal(tokenMatches(ada.token, store.getWitness(ada.row.id)?.tokenHash), true);

  const raw = JSON.stringify(store.listWitnesses());
  assert.equal(raw.includes(ada.token), false, 'plaintext witness token leaked into stored rows');
  store.close();
});

test('events are append-only and readable newest-last', () => {
  const store = freshStore();
  store.appendEvent('boot', { n: 1 });
  store.appendEvent('checkin', { streakDays: 1 });
  const events = store.listEvents();
  assert.deepEqual(events.map((e) => e.kind), ['boot', 'checkin']);
  assert.equal(store.countEvents('checkin'), 1);
  store.close();
});

test('instruction history survives a new signing; only pending rows are replaced', () => {
  const store = freshStore();
  store.replaceInstructions([{ kind: 'slack_post', target: 'C1', text: '' }]);
  const [row] = store.listInstructions();
  store.markInstruction(row!.id, 'ok', 'https://receipt');
  store.replaceInstructions([{ kind: 'github_issue', repo: 'a/b', title: 't', body: '' }]);
  const rows = store.listInstructions();
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.status, 'ok', 'executed history must not be rewritten');
  assert.equal(rows[0]!.resultRef, 'https://receipt');
  assert.equal(rows[1]!.status, 'pending');
  store.close();
});

test('state survives a reopen of the same database file', () => {
  const store = freshStore();
  const path = store.db.location();
  const state = store.getState();
  state.phase = 'ARMED';
  state.streakDays = 3;
  store.setState(state);
  store.close();

  const reopened = new Store(path);
  assert.equal(reopened.getState().phase, 'ARMED');
  assert.equal(reopened.getState().streakDays, 3);
  reopened.close();
});

test('utcDayKey buckets by UTC date, not local time', () => {
  assert.equal(utcDayKey('2026-11-24T23:59:00.000Z'), '2026-11-24');
  assert.equal(utcDayKey('2026-11-25T00:00:01.000Z'), '2026-11-25');
});
