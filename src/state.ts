// src/state.ts — FROZEN SCHEMA (executor-plan.md §2.2).
// node:sqlite (Node >= 22.5, --experimental-sqlite). Append-only events: there is no
// UPDATE or DELETE path for `events` anywhere in this codebase, by design.

import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Event, EventKind, ExecRecord, Instruction, MachineState, Will, WitnessRow, WitnessSpec } from './types.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  kind   TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS instructions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ordinal     INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  params      TEXT NOT NULL,
  executed_at TEXT,
  result_ref  TEXT,
  status      TEXT NOT NULL DEFAULT 'pending'
);
CREATE TABLE IF NOT EXISTS witnesses (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  slack_user_id  TEXT,
  email          TEXT,
  token_hash     TEXT NOT NULL,
  notified_at    TEXT,
  vouched_at     TEXT
);
`;

export function newToken(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time compare of a presented token against a stored hash. */
export function tokenMatches(token: string, storedHash: string | null | undefined): boolean {
  if (!storedHash) return false;
  const a = Buffer.from(hashToken(token), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function utcDayKey(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

export function initialState(now: string): MachineState {
  return {
    phase: 'DORMANT',
    lastCheckIn: now,
    streakDays: 0,
    lastDayKey: '',
    lastTickAt: null,
    grace: {},
    willVersion: 0,
    investigated: false,
  };
}

export class Store {
  db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // --- kv-backed state -----------------------------------------------------
  private getKV<T>(key: string): T | null {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : null;
  }

  private setKV(key: string, value: unknown): void {
    this.db
      .prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }

  getState(now = new Date().toISOString()): MachineState {
    return this.getKV<MachineState>('state') ?? initialState(now);
  }

  setState(s: MachineState): void {
    this.setKV('state', s);
  }

  getWill(): Will | null {
    return this.getKV<Will>('will');
  }

  setWill(w: Will): void {
    this.setKV('will', w);
  }

  getOwnerTokenHash(): string | null {
    return this.getKV<string>('ownerTokenHash');
  }

  setOwnerTokenHash(h: string): void {
    this.setKV('ownerTokenHash', h);
  }

  /** Escape hatch for small bookkeeping keys (execution lock, connector cache). */
  getKVPublic<T>(key: string): T | null {
    return this.getKV<T>(key);
  }

  setKVPublic(key: string, value: unknown): void {
    this.setKV(key, value);
  }

  // --- append-only events --------------------------------------------------
  appendEvent(kind: EventKind, detail: Record<string, unknown> = {}, ts?: string): void {
    if (ts) {
      this.db.prepare('INSERT INTO events (ts, kind, detail) VALUES (?, ?, ?)').run(ts, kind, JSON.stringify(detail));
      return;
    }
    this.db.prepare('INSERT INTO events (kind, detail) VALUES (?, ?)').run(kind, JSON.stringify(detail));
  }

  listEvents(limit = 200): Event[] {
    const rows = this.db
      .prepare('SELECT ts, kind, detail FROM events ORDER BY id DESC LIMIT ?')
      .all(limit) as Array<{ ts: string; kind: string; detail: string }>;
    return rows.reverse().map((r) => ({ ts: r.ts, kind: r.kind as EventKind, detail: JSON.parse(r.detail) }));
  }

  countEvents(kind: EventKind): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM events WHERE kind = ?').get(kind) as { c: number };
    return row.c;
  }

  // --- instructions --------------------------------------------------------
  replaceInstructions(list: Instruction[]): void {
    // Pending rows only: executed history is evidence and is never rewritten.
    this.db.prepare("DELETE FROM instructions WHERE status = 'pending'").run();
    const ins = this.db.prepare('INSERT INTO instructions (ordinal, kind, params) VALUES (?, ?, ?)');
    list.forEach((op, i) => ins.run(i, op.kind, JSON.stringify(op)));
  }

  listInstructions(): ExecRecord[] {
    const rows = this.db
      .prepare('SELECT id, ordinal, kind, params, executed_at, result_ref, status FROM instructions ORDER BY ordinal ASC')
      .all() as Array<{ id: number; ordinal: number; kind: string; params: string; executed_at: string | null; result_ref: string | null; status: string }>;
    return rows.map((r) => ({
      id: r.id,
      ordinal: r.ordinal,
      kind: r.kind as Instruction['kind'],
      params: JSON.parse(r.params) as Instruction,
      executedAt: r.executed_at,
      resultRef: r.result_ref,
      status: r.status as ExecRecord['status'],
    }));
  }

  markInstruction(id: number, status: ExecRecord['status'], resultRef: string | null = null): void {
    this.db
      .prepare('UPDATE instructions SET status = ?, result_ref = ?, executed_at = ? WHERE id = ?')
      .run(status, resultRef, new Date().toISOString(), id);
  }

  // --- witnesses -----------------------------------------------------------
  replaceWitnesses(specs: WitnessSpec[]): Array<{ row: WitnessRow; token: string }> {
    this.db.prepare('DELETE FROM witnesses').run();
    const ins = this.db.prepare(
      'INSERT INTO witnesses (id, name, slack_user_id, email, token_hash) VALUES (?, ?, ?, ?, ?)',
    );
    const out: Array<{ row: WitnessRow; token: string }> = [];
    for (const spec of specs) {
      const id = randomBytes(5).toString('hex');
      const token = newToken();
      const tokenHash = hashToken(token);
      ins.run(id, spec.name, spec.slackUserId ?? null, spec.email ?? null, tokenHash);
      out.push({ row: { id, ...spec, tokenHash }, token });
    }
    return out;
  }

  getWitness(id: string): WitnessRow | null {
    const r = this.db
      .prepare('SELECT id, name, slack_user_id, email, token_hash, notified_at, vouched_at FROM witnesses WHERE id = ?')
      .get(id) as
      | { id: string; name: string; slack_user_id: string | null; email: string | null; token_hash: string; notified_at: string | null; vouched_at: string | null }
      | undefined;
    if (!r) return null;
    const row: WitnessRow = { id: r.id, name: r.name, tokenHash: r.token_hash };
    if (r.slack_user_id) row.slackUserId = r.slack_user_id;
    if (r.email) row.email = r.email;
    if (r.notified_at) row.notifiedAt = r.notified_at;
    if (r.vouched_at) row.vouchedAt = r.vouched_at;
    return row;
  }

  listWitnesses(): WitnessRow[] {
    const rows = this.db.prepare('SELECT id FROM witnesses ORDER BY name ASC').all() as Array<{ id: string }>;
    return rows.map((r) => this.getWitness(r.id)!).filter(Boolean);
  }

  markWitnessNotified(id: string): void {
    this.db.prepare('UPDATE witnesses SET notified_at = ? WHERE id = ? AND notified_at IS NULL').run(new Date().toISOString(), id);
  }

  markWitnessVouched(id: string): void {
    this.db.prepare('UPDATE witnesses SET vouched_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  }
}
