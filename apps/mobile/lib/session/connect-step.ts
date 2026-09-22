/**
 * The next step of the session-open loop (`ProjectScreen.ensureAndOpen`),
 * decided from one `POST /start` answer. Pure, with no React Native imports,
 * so `bun test` can run it.
 *
 * Same rules as `@kortix/sdk`'s `shouldPollSessionStart` and
 * `shouldRetrySessionStart` on web: a terminal stage or a client error stops
 * at once; a transient failure polls again, up to
 * `MAX_START_REQUEST_FAILURES` in a row, then stops with ONE visible error.
 */
import type { SessionStartResult } from '@kortix/sdk';

/** Structurally `SessionConnectError` (components/session/SessionConnecting). */
export interface ConnectFailure {
  title: string;
  message: string;
  /** Raw error text, shown verbatim under the message. */
  detail?: string;
}

export type ConnectStep =
  /** Not ready yet: wait, then call `/start` again. */
  | { kind: 'poll' }
  /** The sandbox is active: probe its health and open the chat when ready. */
  | { kind: 'open' }
  /** Stop the loop and show this failure. */
  | { kind: 'fail'; failure: ConnectFailure };

/** Failed `/start` requests in a row before the loop gives up. */
export const MAX_START_REQUEST_FAILURES = 3;

type StartAnswer = Pick<SessionStartResult, 'stage' | 'retriable' | 'failure'> & {
  sandbox: { status: string; external_id: string | null } | null;
};

export function connectStepFromStart(start: StartAnswer): ConnectStep {
  if (start.stage === 'failed' || start.sandbox?.status === 'error') {
    return fail(
      'Session failed to start',
      start.failure?.message ?? 'The sandbox could not be provisioned.',
    );
  }
  if (start.sandbox?.status === 'active' && start.sandbox.external_id) {
    return { kind: 'open' };
  }
  if (start.stage === 'stopped' || start.retriable === false) {
    return fail(
      'Session is not running',
      start.failure?.message ?? 'The session runtime stopped. Restart it to continue.',
    );
  }
  return { kind: 'poll' };
}

/**
 * `consecutiveFailures` counts this failure: 1 on the first failed request.
 */
export function connectStepFromRequestError(
  error: unknown,
  consecutiveFailures: number,
): ConnectStep {
  const status = statusOf(error);
  const terminal = status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429;
  if (!terminal && consecutiveFailures < MAX_START_REQUEST_FAILURES) return { kind: 'poll' };

  const message = error instanceof Error && error.message ? error.message : null;
  // No HTTP status: the request never reached the API (DNS, refused, offline).
  if (status === null) {
    return fail(
      'Could not reach the server',
      'The app could not connect to the Kortix API. Check the connection and try again.',
      message ?? undefined,
    );
  }
  return fail('Could not start session', message ?? `Request failed (${status})`);
}

function statusOf(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : null;
}

function fail(title: string, message: string, detail?: string): ConnectStep {
  return { kind: 'fail', failure: detail ? { title, message, detail } : { title, message } };
}
