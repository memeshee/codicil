// src/types.ts — FROZEN INTERFACES (executor-plan.md §2.1).
// A change here goes back through the architect and is stamped in the plan.

export type Phase =
  | 'DORMANT'
  | 'ARMED'
  | 'CONCERNED'
  | 'PLEADING'
  | 'EXECUTING'
  | 'EXECUTED'
  /** The owner withdrew consent. Nothing executes until a NEW version is signed. */
  | 'REVOKED';

export interface Will {
  version: number;
  owner: { name: string; github: string };
  /** The owner's own words, VERBATIM. Spine of the final letter. */
  letter: string;
  /**
   * The private words: AES-GCM ciphertext produced IN THE BROWSER at signing time.
   * The executor stores and delivers it but can never read it — it has never seen the
   * passphrase. This is the product's strongest claim, and it costs us something.
   */
  sealed?: SealedBlob;
  policy: {
    /** ARMED -> CONCERNED. Production 10080 (7d); demo 2-5 minutes. */
    deadlineMinutes: number;
    /** CONCERNED -> PLEADING. Production 2880; demo 1.5. */
    nudgeGraceMinutes: number;
    /** PLEADING -> EXECUTING. Production 1440; demo 1.5. */
    pleadGraceMinutes: number;
    /** How many witnesses must vouch to stand the clock down. Default 1. */
    vouchQuorum?: number;
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
  /** A channel we can actually reach them on. Without one, "notified" is a lie. */
  slackUserId?: string;
  email?: string;
}

/** Browser-produced ciphertext. The box stores it; it cannot open it. */
export interface SealedBlob {
  /** base64 AES-GCM ciphertext */
  ct: string;
  /** base64 12-byte IV */
  iv: string;
  /** base64 PBKDF2 salt */
  salt: string;
  /** Optional plaintext hint about the passphrase, written by the owner. */
  hint?: string;
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
  | 'return_of_owner' | 'revoked' | 'token_rotated' | 'witness_delivered' | 'quorum' | 'sealed_attached' | 'chain_break';

export interface Event {
  ts: string;
  kind: EventKind;
  detail: Record<string, unknown>;
  /** Tamper-evidence: sha256(prev_hash + ts + kind + detail). */
  prevHash: string | null;
  rowHash: string | null;
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
  /** Witness ids that have vouched during this silence episode (quorum accounting). */
  vouchIds: string[];
  /** How many times witnesses have stood this into-will's clock down since the owner last answered. */
  vouchResets: number;
  /** Set when the owner revoked. REVOKED is terminal until a new version is signed. */
  revokedAt?: string;
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
