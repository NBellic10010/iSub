// Durable file-backed KeeperStore (Node-only — imports node:fs, so it is NOT
// exported from the package index; server code imports it directly).
//   <dir>/state.json    — tracks (atomic rewrite via temp file)
//   <dir>/journal.jsonl — append-only action journal
//   <dir>/keeper.lock   — single-instance guard (pid + heartbeat mtime)
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { JournalEntry, KeeperStore, PersistedKeeperState } from './store';
import { IsubError } from './errors';

/** A lock older than this is considered abandoned (crashed process) and is taken over. */
const LOCK_STALE_MS = 120_000;

export function fileStore(dir: string): KeeperStore {
  mkdirSync(dir, { recursive: true });
  const statePath = join(dir, 'state.json');
  const journalPath = join(dir, 'journal.jsonl');
  const lockPath = join(dir, 'keeper.lock');

  const touchLock = (): void => writeFileSync(lockPath, `${process.pid}\n`);

  // K-3: a lock is "held" only if its heartbeat is recent AND the recorded pid is
  // still running. A crashed keeper leaves a dead pid → the restart takes over
  // immediately instead of waiting out LOCK_STALE_MS (the old 2-minute lockout).
  // Same-host assumption: `process.kill(pid, 0)` only sees this machine's processes;
  // a multi-host deployment must use a real distributed lock, not this file.
  const lockHeldByLiveProcess = (): boolean => {
    try {
      if (Date.now() - statSync(lockPath).mtimeMs >= LOCK_STALE_MS) return false; // time-stale → free
      const pid = Number(readFileSync(lockPath, 'utf8').trim());
      if (!Number.isInteger(pid) || pid <= 0) return true; // fresh heartbeat, unparseable pid → assume held
      try {
        process.kill(pid, 0); // signal 0 sends nothing — just probes existence
        return true; // process exists (and is ours)
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === 'EPERM'; // EPERM = alive but not ours; ESRCH = dead
      }
    } catch {
      return false; // lock vanished mid-check → not held
    }
  };

  return {
    async load() {
      if (!existsSync(statePath)) return null;
      return JSON.parse(readFileSync(statePath, 'utf8')) as PersistedKeeperState;
    },
    async save(state) {
      const tmp = `${statePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(state, null, 2));
      renameSync(tmp, statePath); // atomic on POSIX
      if (existsSync(lockPath)) touchLock(); // heartbeat
    },
    async appendJournal(entry) {
      appendFileSync(journalPath, JSON.stringify(entry) + '\n');
    },
    async readJournal() {
      if (!existsSync(journalPath)) return [];
      const out: JournalEntry[] = [];
      let skipped = 0;
      for (const line of readFileSync(journalPath, 'utf8').split('\n')) {
        if (!line) continue;
        try {
          out.push(JSON.parse(line) as JournalEntry);
        } catch {
          // K-4: tolerate a truncated/garbage line (e.g. a crash mid-append leaves a
          // partial last line). Skip it instead of throwing — one corrupt tail line
          // must not brick reconcile / keeper init.
          skipped++;
        }
      }
      if (skipped > 0) console.warn(`keeper journal: skipped ${skipped} unparseable line(s) in ${journalPath}`);
      return out;
    },
    async acquireLock() {
      if (existsSync(lockPath) && lockHeldByLiveProcess()) {
        const age = Date.now() - statSync(lockPath).mtimeMs;
        throw new IsubError(
          'lock',
          `another keeper instance holds ${lockPath} (pid alive, heartbeat ${Math.round(age / 1000)}s ago). ` +
            `Running two keepers is safe on-chain but wastes gas — stop the other one first.`,
        );
      }
      touchLock();
    },
    async releaseLock() {
      rmSync(lockPath, { force: true });
    },
  };
}
