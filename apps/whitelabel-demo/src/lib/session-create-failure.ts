import { serverErrorBody } from './api-error-body';

/**
 * Why a session create was refused, in words a wrapper's END-USER can act on.
 *
 * "Could not start a session" is true for every one of these and useful for
 * none of them. The refusals a Kortix-as-a-Backend wrapper actually hits are
 * each somebody's job to fix — the end-user's, the operator's, or nobody's
 * (just wait) — and the whole point of the distinct `code` on each response is
 * that the wrapper can tell them apart.
 *
 * Returns a title plus whether retrying could possibly help, so the UI does not
 * offer a retry button for a refusal that will refuse identically forever.
 */
interface SessionCreateFailure {
  title: string;
  detail: string;
  retryable: boolean;
}

interface FailureCopy {
  title: string;
  detail: string;
  /** Ignore the server's own error text: the upstream copy would be
   *  developer-facing and meaningless to an end user. */
  fixedDetail?: boolean;
}

/**
 * One row per refusal code. Adding a code is one row; an unknown code falls
 * through to the generic retryable failure below.
 *
 * The connector PRE-FLIGHT codes are gone. `CONNECTOR_CONNECTION_REQUIRED` and
 * `REQUIRED_CONNECTOR_CONNECTION_UNAVAILABLE` cannot be returned by create or
 * scope any more — `require_connectors` is accepted and ignored on the wire
 * (see `packages/api-contract` `SessionCreateInputSchema`). The gate moved to
 * the connector CALL, which denies `connector_not_connected` with a
 * `connect_url` the agent's own turn surfaces. Neither case is listed here on
 * purpose: an old server that still sent one would fall through to the generic
 * failure rather than resurrect dead UI for it.
 */
const FAILURE_COPY: Record<string, FailureCopy> = {
  // These selections refuse identically until the create input changes.
  subscription_required: { title: 'Out of credit', detail: 'This workspace is out of credit.' },
  insufficient_credits: { title: 'Out of credit', detail: 'This workspace is out of credit.' },
  CONNECTOR_NOT_ASSIGNED: {
    title: 'This agent is missing a connector',
    detail: 'The agent is not granted a connector this session needs.',
  },
  SECRET_IDENTIFIER_NOT_FOUND: {
    title: 'A selected secret is not available to sessions',
    detail:
      'One of the secrets you picked is owned by a connector rather than the project runtime. Deselect it and start again.',
  },
  SECRET_IDENTIFIER_KEY_COLLISION: {
    title: 'Two selected secrets use the same variable name',
    detail:
      'Two of the secrets you picked inject the same environment variable, so the session cannot tell them apart. Pick one of them.',
  },
  INVALID_SESSION_SECRETS: {
    title: 'That secret selection is not valid',
    detail: 'Adjust the selected secrets and start again.',
  },
  CONNECTOR_CONNECTION_NOT_FOUND: {
    title: 'That connection no longer exists',
    detail:
      'The connection you picked has been removed. Pick another, or ask a teammate to reconnect it.',
  },
  CONNECTOR_CONNECTION_INACTIVE: {
    title: 'That connection needs reconnecting',
    detail:
      'The connection you picked is revoked or disabled. A teammate needs to reconnect it before a session can use it.',
  },
  // Direct mode: `secrets` is a backend-origin field, so a browser PAT is
  // refused. Developer-facing upstream copy would be meaningless here.
  origin_override_forbidden: {
    title: 'Secret narrowing needs wrapper mode',
    detail:
      'This deployment is talking to Kortix directly, where the per-session secret allowlist is not available.',
    fixedDetail: true,
  },
  INVALID_SESSION_MODEL: {
    title: 'That model is unavailable',
    detail: 'Pick a different model and try again.',
  },
};

/** Unknown failures are assumed transient — a retry costs one request and an
 *  unrecoverable one will simply refuse again with the same message. */
const UNKNOWN_FAILURE: SessionCreateFailure = {
  title: 'Could not start a session',
  detail: 'Something went wrong. Please try again.',
  retryable: true,
};

export function sessionCreateFailure(err: unknown): SessionCreateFailure {
  const body = serverErrorBody(err);
  const code = typeof body?.code === 'string' ? body.code : null;
  const serverText = typeof body?.error === 'string' ? body.error : null;
  const copy = code ? FAILURE_COPY[code] : undefined;
  if (!copy) {
    return { ...UNKNOWN_FAILURE, ...(serverText ? { detail: serverText } : {}) };
  }
  return {
    title: copy.title,
    detail: copy.fixedDetail ? copy.detail : (serverText ?? copy.detail),
    retryable: false,
  };
}
