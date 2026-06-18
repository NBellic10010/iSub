// One error type for the whole SDK. Everything iSub throws is an `IsubError` (or a
// subclass), carrying a machine-readable `code` so callers branch on `e.code` /
// `e instanceof IsubError` instead of matching message strings. Two subclasses carry
// extra structured data: `IsubAbortError` (on-chain Move abort code) and
// `IsubHttpError` (gateway HTTP status). Construct with `new IsubError(code, msg)`.
import { errorName } from './constants';

/**
 * What kind of failure this is — stable across message wording, safe to switch on.
 *  - `move_abort` — a transaction aborted on-chain (see `IsubAbortError.abortCode`).
 *  - `http`       — a gateway request failed (see `IsubHttpError.status`).
 *  - `lock`       — another instance holds the single-instance lock (terminal; stop the other).
 *  - `config`     — unsupported/invalid SDK configuration (e.g. a SUI-only path on a non-SUI coin).
 *  - `usage`      — invalid caller input (e.g. a non-positive amount).
 *  - `not_found`  — an expected on-chain object/record was missing.
 *  - `parse`      — on-chain data didn't have the expected Move shape.
 */
export type IsubErrorCode = 'move_abort' | 'http' | 'lock' | 'config' | 'usage' | 'not_found' | 'parse';

/** Base class for every error the SDK raises. Branch on `.code` (or instanceof a subclass). */
export class IsubError extends Error {
  readonly code: IsubErrorCode;
  constructor(code: IsubErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'IsubError';
    this.code = code;
  }
}

/**
 * Thrown when a transaction fails on-chain with a Move abort. Carries the structured
 * abort `abortCode` (and its symbolic name) so callers can assert on it without parsing
 * error strings — the gRPC path surfaces abort codes directly.
 */
export class IsubAbortError extends IsubError {
  readonly abortCode: number | null;
  constructor(abortCode: number | null, detail?: string) {
    super(
      'move_abort',
      abortCode !== null
        ? `Move abort ${errorName(abortCode)} (#${abortCode})`
        : `transaction failed${detail ? `: ${detail}` : ''}`,
    );
    this.name = 'IsubAbortError';
    this.abortCode = abortCode;
  }
}

/** Thrown by the managed gateway for a request-level failure; carries the HTTP `status`. */
export class IsubHttpError extends IsubError {
  readonly status: number;
  constructor(status: number, message: string) {
    super('http', message);
    this.name = 'IsubHttpError';
    this.status = status;
  }
}

/** Type guard: is this value an iSub error (so `.code` is available)? */
export function isIsubError(e: unknown): e is IsubError {
  return e instanceof IsubError;
}

/** Extract a Move abort code from any thrown value, or null if it isn't a Move abort. */
export function abortCodeOf(e: unknown): number | null {
  return e instanceof IsubAbortError ? e.abortCode : null;
}
