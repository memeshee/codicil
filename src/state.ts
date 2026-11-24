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
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  kind      TEXT NOT NULL,
  detail    TEXT NOT NULL DEFAULT '{}',
  prev_hash TEXT,
  row_hash  TEXT
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
    vouchIds: [],
  };
}

export class Store {
  db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /**
   * Additive migration + chain backfill. A database written before the chain existed still
   * opens; its rows are chained from the first one forward, so the tamper-evidence starts
   * with the oldest row we can still see. Any row deleted before the upgrade is undetectable
   * — that is stated on /proof rather than hidden.
   */
  private migrate(): void {
    const cols = this.db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    if (!names.has('prev_hash')) this.db.exec('ALTER TABLE events ADD COLUMN prev_hash TEXT');
    if (!names.has('row_hash')) this.db.exec('ALTER TABLE events ADD COLUMN row_hash TEXT');
    const pending = this.db.prepare('SELECT COUNT(*) AS c FROM events WHERE row_hash IS NULL').get() as { c: number };
    if (pending.c > 0) this.backfillChain();
  }

  private static chainHash(prev: string | null, ts: string, kind: string, detailJson: string): string {
    return createHash('sha256').update(`${prev ?? 'genesis'}|${ts}|${kind}|${detailJson}`).digest('hex');
  }

  /** Chain every unchained row, in insert order. Idempotent. */
  private backfillChain(): void {
    const rows = this.db
      .prepare('SELECT id, ts, kind, detail FROM events WHERE row_hash IS NULL ORDER BY id ASC')
      .all() as Array<{ id: number; ts: string; kind: string; detail: string }>;
    const head = this.db
      .prepare('SELECT row_hash FROM events WHERE row_hash IS NOT NULL ORDER BY id DESC LIMIT 1')
      .get() as { row_hash: string } | undefined;
    let prev = head?.row_hash ?? null;
    const upd = this.db.prepare('UPDATE events SET prev_hash = ?, row_hash = ? WHERE id = ?');
    for (const r of rows) {
      const rowHash = Store.chainHash(prev, r.ts, r.kind, r.detail);
      upd.run(prev, rowHash, r.id);
      prev = rowHash;
    }
  }

  /** Walk the whole chain and recompute it. This is the tamper-evidence, not a promise. */
  verifyChain(): { ok: boolean; checked: number; brokenAtId: number | null; head: string | null } {
    const rows = this.db
      .prepare('SELECT id, ts, kind, detail, prev_hash, row_hash FROM events ORDER BY id ASC')
      .all() as Array<{ id: number; ts: string; kind: string; detail: string; prev_hash: string | null; row_hash: string | null }>;
    let prev: string | null = null;
    for (const r of rows) {
      const expected = Store.chainHash(prev, r.ts, r.kind, r.detail);
      if (r.row_hash !== expected || r.prev_hash !== prev) {
        return { ok: false, checked: rows.length, brokenAtId: r.id, head: prev };
      }
      prev = r.row_hash;
    }
    return { ok: true, checked: rows.length, brokenAtId: null, head: prev };
  }

  /** Rows as they are stored, for the public verifier. */
  listChain(): Array<{ id: number; ts: string; kind: string; detail: string; prevHash: string | null; rowHash: string | null }> {
    return this.db
      .prepare('SELECT id, ts, kind, detail, prev_hash AS prevHash, row_hash AS rowHash FROM events ORDER BY id ASC')
      .all() as Array<{ id: number; ts: string; kind: string; detail: string; prevHash: string | null; rowHash: string | null }>;
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
    const stored = this.getKV<MachineState>('state');
    if (!stored) return initialState(now);
    // Older rows predate these fields; default them rather than trusting the shape.
    if (!Array.isArray(stored.vouchIds)) stored.vouchIds = [];
    if (stored.revokedAt === undefined) delete stored.revokedAt;
    return stored;
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
    const at = ts ?? new Date().toISOString();
    const detailJson = JSON.stringify(detail);
    const head = this.db.prepare('SELECT row_hash FROM events ORDER BY id DESC LIMIT 1').get() as
      | { row_hash: string | null }
      | undefined;
    const prev = head?.row_hash ?? null;
    const rowHash = Store.chainHash(prev, at, kind, detailJson);
    this.db
      .prepare('INSERT INTO events (ts, kind, detail, prev_hash, row_hash) VALUES (?, ?, ?, ?, ?)')
      .run(at, kind, detailJson, prev, rowHash);
  }

  listEvents(limit = 200): Event[] {
    const rows = this.db
      .prepare('SELECT ts, kind, detail, prev_hash, row_hash FROM events ORDER BY id DESC LIMIT ?')
      .all(limit) as Array<{ ts: string; kind: string; detail: string; prev_hash: string | null; row_hash: string | null }>;
    return rows
      .reverse()
      .map((r) => ({
        ts: r.ts,
        kind: r.kind as EventKind,
        detail: JSON.parse(r.detail),
        prevHash: r.prev_hash,
        rowHash: r.row_hash,
      }));
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
