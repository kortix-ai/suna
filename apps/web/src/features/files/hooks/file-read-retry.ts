import { isSandboxNotReadyError } from '@kortix/sdk';
import { useRuntimeConnectionStore } from '@kortix/sdk/react';

export const UPLOADED_FILE_READ_RETRY_DELAY_MS = 2_000;
export const UPLOADED_FILE_READ_RETRY_WINDOW_MS = 60_000;
export const UPLOADED_FILE_READ_MAX_RETRIES = Math.ceil(
  UPLOADED_FILE_READ_RETRY_WINDOW_MS / UPLOADED_FILE_READ_RETRY_DELAY_MS,
);

export function isUploadedWorkspacePath(filePath: string | null | undefined): boolean {
  if (!filePath) return false;
  const normalized = filePath.replace(/^\/+/, '');
  return (
    normalized === 'uploads' ||
    normalized.startsWith('uploads/') ||
    normalized === 'workspace/uploads' ||
    normalized.startsWith('workspace/uploads/')
  );
}

export function fileReadRetryDelayMs(attempt: number, filePath?: string | null): number {
  if (isUploadedWorkspacePath(filePath)) return UPLOADED_FILE_READ_RETRY_DELAY_MS;
  return Math.min(1000 * Math.pow(2, attempt), 5000);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.toLowerCase() : String(error ?? '').toLowerCase();
}

function isPermanentFileReadFailure(error: unknown): boolean {
  // Prefer a numeric HTTP status when the thrown error carries one: any 4xx
  // except 408/429 is a client error that won't fix itself on retry.
  const status = (error as { status?: unknown } | null)?.status;
  if (
    typeof status === 'number' &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 429
  ) {
    return true;
  }
  const msg = errorMessage(error);
  return (
    msg.includes('404') ||
    msg.includes('401') ||
    msg.includes('403') ||
    msg.includes('400') ||
    msg.includes('bad request') ||
    // A directory read (e.g. `.opencode`) returns 400 "Path is a directory" —
    // permanent, must not be retried on a loop.
    msg.includes('is a directory') ||
    msg.includes('eisdir') ||
    msg.includes('not found') ||
    msg.includes('access denied') ||
    msg.includes('forbidden') ||
    msg.includes('unauthorized') ||
    msg.includes('unprocessable') ||
    msg.includes('no such file') ||
    msg.includes('enoent') ||
    msg.includes('does not exist') ||
    msg.includes('path not found')
  );
}

function isMissingFileReadFailure(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === 'number') return status === 404;
  const msg = errorMessage(error);
  return (
    msg.includes('404') ||
    msg.includes('not found') ||
    msg.includes('no such file') ||
    msg.includes('enoent') ||
    msg.includes('does not exist') ||
    msg.includes('path not found')
  );
}

// How often a file query re-polls while the sandbox reports a readiness 503
// ("sandbox not ready (status: …)"). The control plane answers these without
// dialling the box, so the poll is cheap; the query keeps polling until the
// box is active and the file loads on its own.
export const SANDBOX_WAKING_REFETCH_INTERVAL_MS = 3_000;

/**
 * Re-read cadence while the box is asleep. Slower, never off.
 *
 * A PARKED box resumes only on the next SEND, and the API refuses every read
 * meant to wake it — so the 3s boot cadence is ~20 requests a minute against a
 * state that cannot change on its own. But it still has to be WATCHED: the send
 * that wakes the box can come from the composer, another tab, or a trigger, and
 * when it does the file must appear without the user hunting for a retry
 * button. Stopping the poll outright would trade a busy wait for a dead one.
 *
 * 30s: the same reasoning as `POLL_PARKED` in the SDK's runtime reconnect.
 */
export const SANDBOX_PARKED_REFETCH_INTERVAL_MS = 30_000;

/**
 * Single liveness read of the runtime connection store: the control-plane
 * socket is connected AND the runtime probe answered healthy. Anything else —
 * connecting, disconnected, or connected but not yet probed — reads as "not
 * alive", which for a file surface means the read is PENDING (the session is
 * resuming/starting the box), not failed.
 *
 * Module-level so `useSyncExternalStore` sees one stable `getSnapshot` across
 * renders (zustand v5 React 19: a snapshot created per render throws "The
 * result of getSnapshot should be cached"). The SSR path shares it because
 * zustand v5's own hook pins `getServerSnapshot` to `getInitialState()`, and
 * a server-render dispatcher in the same process can never observe an earlier
 * `setState` — reading through `getState()` for both snapshots keeps render
 * tests honest. No behavior change in the browser or real SSR.
 *
 * Callers: `file-preview.tsx` and the file-read hooks below, which all need
 * the same answer; each previously held its own copy of this rule.
 */
export function runtimeAliveSnapshot(): boolean {
  const state = useRuntimeConnectionStore.getState();
  return state.status === 'connected' && state.healthy === true;
}

/**
 * Whether a file read is still waiting on the runtime, given the error it
 * failed with and whether the runtime is alive right now.
 *
 * The rule that decides pending-vs-failed for file surfaces. The old
 * classification only knew the readiness 503 ("sandbox not ready"), so the
 * first failure a RESUMING box produced — a proxy 502/504, a socket reset, an
 * aborted fetch — was rendered as a verdict: "This session's workspace has
 * ended, so its files can't be opened anymore." (KRTX-1634). A box that is
 * down is coming back (the session page auto-retries /start); a read against
 * it is pending, whichever shape its failure takes. Only a LIVE box's
 * non-readiness error is a real failure.
 */
export function isFileReadWaking(error: unknown, sandboxAlive: boolean): boolean {
  return !sandboxAlive || isSandboxNotReadyError(error);
}

/**
 * How often to re-read a file that is waiting on the runtime.
 *
 * The 3s comment above describes a BOOTING box, and for that box it is right:
 * the file appears on its own in seconds. A parked box takes the slow lane.
 * A box that is not alive at all (mid-resume) keeps the same two lanes — the
 * session's auto-retry brings it back, and the poll must survive every error
 * shape the down box produces, not only the readiness 503.
 */
export function sandboxWakingRefetchInterval(
  error: unknown,
  parked: boolean,
  sandboxAlive = true,
): number | false {
  // A live box that failed with anything but a readiness 503 has genuinely
  // failed — stop polling and let the viewer say so.
  if (sandboxAlive && !isSandboxNotReadyError(error)) return false;
  return parked ? SANDBOX_PARKED_REFETCH_INTERVAL_MS : SANDBOX_WAKING_REFETCH_INTERVAL_MS;
}

export function shouldRetryFileRead(
  filePath: string | null | undefined,
  failureCount: number,
  error: unknown,
): boolean {
  // A parked/booting sandbox is not a failed read. Fail fast out of the inline
  // retry loop so the viewer can render its "waking up" state immediately; the
  // query-level poll (SANDBOX_WAKING_REFETCH_INTERVAL_MS) re-reads until the
  // sandbox is back.
  if (isSandboxNotReadyError(error)) return false;

  if (isUploadedWorkspacePath(filePath)) {
    if (isPermanentFileReadFailure(error) && !isMissingFileReadFailure(error)) return false;
    return failureCount < UPLOADED_FILE_READ_MAX_RETRIES;
  }

  if (isPermanentFileReadFailure(error)) return false;
  return failureCount < 3;
}
