import { PlatinumHttpError } from '../../shared/platinum';

/**
 * How a read of a session's runtime fails, classified.
 *
 * A fail-open read of a session's runtime (`readInboxTranscriptState`, the
 * transcript capture and its sub-agent walk) must tolerate the expected
 * states of a sandbox that is stopped, gone, or cold — Platinum auto-stops
 * idle boxes by design, a box can be replaced and come back without its
 * sub-agent transcripts, and a cold box can overrun the read's budget.
 * Warning on those states was a false alarm: the platform worked, the read
 * was optional. This module is the one classifier both call sites share, so
 * the log level follows the same rule everywhere.
 */

/**
 * A transcript read that reached the runtime and got a non-ok status.
 *
 * The message stays the spelling every log pattern already keys on; the
 * status is what callers classify by.
 */
export class TranscriptReadError extends Error {
  constructor(readonly status: number) {
    super(`Transcript read failed: HTTP ${status}`);
    this.name = 'TranscriptReadError';
  }
}

/**
 * Is this failure an expected state of a sandbox runtime that is stopped,
 * gone, or cold — the states a fail-open transcript read tolerates?
 *
 * Sibling of `unreachableCauseForThrow` in `projects/opencode-mapping.ts`
 * (same domain, different question: that one splits timeout-vs-endpoint for
 * the liveness probe; this one splits expected-vs-unexpected for the log
 * level).
 */
const RUNTIME_UNAVAILABLE_STATUSES = new Set([404, 502, 503, 504]);
const RUNTIME_UNAVAILABLE_ERROR_NAMES = new Set([
  'TimeoutError', // AbortSignal.timeout, shared/with-timeout, Platinum's call budget
  'AbortError',
  'DaytonaTimeoutError',
  'DaytonaConnectionError',
]);
// Transport-level fetch failures Bun raises as plain messages, not codes — and
// deliberately no error-`code` check: Postgres errors carry ECONNRESET/
// ECONNREFUSED as `code` too, and these catches also wrap database work. A
// database outage must keep its warn, not pass as an expected runtime state.
const RUNTIME_UNAVAILABLE_MESSAGE_RE =
  /fetch failed|unable to connect|connection refused|socket connection was closed|the operation timed out|\[proxy\] no sandbox row for /i;

export function isRuntimeUnavailableError(error: unknown): boolean {
  // A typed provider answer during endpoint resolution: the expected states
  // of a stopped, gone, or blipped box — the 409 sandbox_not_running (Platinum
  // auto-stop, by design), a gone box's 404, a provider-side 5xx. Everything
  // else the control plane answers — a 429 rate limit, a 401/403 auth
  // failure — stays warn-worthy: the measured prod spikes were 409/404 only.
  if (error instanceof PlatinumHttpError) {
    return error.status === 404 || error.status === 409 || error.status >= 500;
  }
  if (error instanceof TranscriptReadError) return RUNTIME_UNAVAILABLE_STATUSES.has(error.status);
  const err = error as { name?: unknown; message?: unknown } | null | undefined;
  if (RUNTIME_UNAVAILABLE_ERROR_NAMES.has(String(err?.name))) return true;
  return typeof err?.message === 'string' && RUNTIME_UNAVAILABLE_MESSAGE_RE.test(err.message);
}
