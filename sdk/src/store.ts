// Keeper persistence seam (P-2/P-3): watch set + lifecycle tracks survive restarts,
// and every action lands in an append-only journal (the merchant-side ledger that
// reconciliation checks against the chain).
//
// `memoryStore()` here is pure (browser-safe) and is the zero-config default — fine
// for tests and demos, NOT for production billing (a restart loses the watch set).
// Production passes a durable store; `fileStore()` lives in ./store-file (Node-only).

/** Off-chain lifecycle of a watched mandate (the billing state machine, P-1/P-5). */
export type MandateLifecycle =
  | 'active' // chargeable; billing as scheduled
  | 'past_due' // due but the Account can't cover the price (dunning window runs)
  | 'lapsed' // grace expired without recovery — keeper stopped billing (mandate may still be valid on-chain!)
  | 'paused' // subscriber paused on-chain
  | 'expired' // mandate expiry passed (terminal)
  | 'revoked'; // subscriber revoked (terminal)

/** Per-mandate state the keeper persists between ticks/restarts. */
export interface MandateTrack {
  state: MandateLifecycle;
  /** When the current state was entered (ms epoch). */
  sinceMs: number;
  /** Last known on-chain charge_seq. Drift vs chain = external or response-lost charges. */
  chargeCount?: number;
  lastDigest?: string;
}

export interface PersistedKeeperState {
  tracks: Record<string, MandateTrack>;
}

/** One line in the append-only action journal. Amounts are strings (JSON-safe bigint). */
export interface JournalEntry {
  at: number;
  mandateId: string;
  kind: 'submit' | 'charged' | 'observed' | 'skip' | 'fail' | 'state';
  /** charged/submit: charge amount in base units. */
  amount?: string;
  digest?: string;
  /** charged: on-chain seq of this charge (= count after it landed). observed: new count. */
  seq?: number;
  /** skip/fail: why. */
  reason?: string;
  /** state: the lifecycle state entered. */
  state?: MandateLifecycle;
}

/**
 * Where the keeper persists tracks + journal. Implementations must make `save` and
 * `appendJournal` durable before resolving (production: DB/redundant disk).
 * Optional lock methods guard against two keeper instances billing the same set
 * (safe on-chain either way — the contract aborts the loser — but it wastes gas).
 */
export interface KeeperStore {
  load(): Promise<PersistedKeeperState | null>;
  save(state: PersistedKeeperState): Promise<void>;
  appendJournal(entry: JournalEntry): Promise<void>;
  readJournal(): Promise<JournalEntry[]>;
  /** Throw if another live instance holds the lock. */
  acquireLock?(): Promise<void>;
  releaseLock?(): Promise<void>;
}

/** Volatile store — zero-config default for tests/demos. NOT durable. */
export function memoryStore(): KeeperStore {
  let state: PersistedKeeperState | null = null;
  const journal: JournalEntry[] = [];
  return {
    load: async () => state,
    save: async (s) => {
      state = { tracks: { ...s.tracks } };
    },
    appendJournal: async (e) => {
      journal.push(e);
    },
    readJournal: async () => [...journal],
  };
}
