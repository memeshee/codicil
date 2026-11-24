// src/types.ts — FROZEN INTERFACES (executor-plan.md §2.1).
// A change here goes back through the architect and is stamped in the plan.

export type Phase = 'DORMANT' | 'ARMED' | 'CONCERNED' | 'PLEADING' | 'EXECUTING' | 'EXECUTED';

export interface Will {
  version: number;
  owner: { name: string; github: string };
  /** The owner's own words, VERBATIM. Spine of the final letter. */
  letter: string;
  policy: {
    /** ARMED -> CONCERNED. Production 10080 (7d); demo 2-5 minutes. */
    deadlineMinutes: number;
    /** CONCERNED -> PLEADING. Production 2880; demo 1.5. */
    nudgeGraceMinutes: number;
    /** PLEADING -> EXECUTING. Production 1440; demo 1.5. */
    pleadGraceMinutes: number;
  };
  /** Executed in ordinal order. */
  instructions: Instruction[];
  witnesses: WitnessSpec[];
  createdAt: string;
  updatedAt: string;
}

export type Instruction =
  | { kind: 'github_issue'; repo: string; title: string; body: string }
  | { kind: 'slack_post'; target: string; text: string }
  | { kind: 's3_put'; key: string; bodyPath: 'letter' | 'bundle' }
  | { kind: 'email_send'; to: string; subject: string; body: string };

export interface WitnessSpec {
  name: string;
  slackUserId?: string;
  email?: string;
}

export interface WitnessRow extends WitnessSpec {
  id: string;
  tokenHash: string;
  notifiedAt?: string;
  vouchedAt?: string;
}

export type EventKind =
  | 'boot'
  | 'will_signed'
  | 'checkin'
  | 'tick'
  | 'phase'
  | 'investigate'
  | 'nudge'
  | 'witness_notified'
  | 'vouch'
  | 'letter_composed'
  | 'execute_ok'
  | 'execute_fail'
  | 'return_of_owner';

export interface Event {
  ts: string;
  kind: EventKind;
  detail: Record<string, unknown>;
}

export interface StateSnapshot {
  phase: Phase;
  lastCheckIn: string;
  streakDays: number;
  /** ISO — the home page's live "heartbeat age". */
  lastTickAt: string | null;
  grace: { nudgeAt?: string; pleadAt?: string };
  willVersion: number;
}

/** Internal persisted machine state (never rendered directly). */
export interface MachineState {
  phase: Phase;
  lastCheckIn: string;
  streakDays: number;
  /** UTC day key of the last counted check-in, e.g. "2026-11-24". */
  lastDayKey: string;
  lastTickAt: string | null;
  grace: { nudgeAt?: string; pleadAt?: string };
  willVersion: number;
  /** Set once the investigator has run for this silence; keeps escalation idempotent. */
  investigated: boolean;
}

export interface ExecRecord {
  id: number;
  ordinal: number;
  kind: Instruction['kind'];
  params: Instruction;
  executedAt: string | null;
  resultRef: string | null;
  status: 'pending' | 'ok' | 'failed' | 'skipped';
}
