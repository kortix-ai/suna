import { serverErrorBody } from './api-error-body';
import {
  connectorRequirement,
  connectorRequirementSummary,
} from './connector-required';

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
export interface SessionCreateFailure {
  title: string;
  detail: string;
  retryable: boolean;
}

export function sessionCreateFailure(err: unknown): SessionCreateFailure {
  const body = serverErrorBody(err);
  const code = typeof body?.code === 'string' ? body.code : null;
  const serverText = typeof body?.error === 'string' ? body.error : null;

  switch (code) {
    case 'concurrent_session_limit':
      // Account-wide — an end-user can do nothing about it themselves.
      return {
        title: 'The service is at capacity',
        detail: serverText ?? 'Please try again in a moment.',
        retryable: true,
      };
    case 'subscription_required':
    case 'insufficient_credits':
      return {
        title: 'Out of credit',
        detail: serverText ?? 'This workspace is out of credit.',
        retryable: false,
      };
    case 'CONNECTOR_NOT_ASSIGNED':
      return {
        title: 'This agent is missing a connector',
        detail:
          serverText ??
          'The agent is not granted a connector this session needs.',
        retryable: false,
      };
    // The connector PRE-FLIGHT. These are the two codes the API really sends —
    // `CONNECTOR_CONNECTION_REQUIRED`, which used to sit here, exists nowhere in
    // the platform, so this arm never once matched a real refusal. The wording
    // comes from the same classifier the connect card uses, so the toast and the
    // card cannot tell the user two different stories.
    case 'CONNECTOR_CONNECTION_REQUIRED':
    case 'REQUIRED_CONNECTOR_CONNECTION_UNAVAILABLE': {
      const requirement = connectorRequirement(err);
      const summary = requirement
        ? connectorRequirementSummary(requirement)
        : null;
      return {
        title: summary?.title ?? 'This session needs a connector',
        detail:
          summary?.detail ??
          serverText ??
          'A connector this session declares has no usable connection.',
        // Retrying changes nothing until somebody connects an account, and a
        // retry button next to "connect this first" invites exactly the loop
        // the pre-flight exists to prevent.
        retryable: false,
      };
    }
    // These selections refuse identically until the create input changes.
    case 'SECRET_IDENTIFIER_NOT_FOUND':
      return {
        title: 'A selected secret is not available to sessions',
        detail:
          serverText ??
          'One of the secrets you picked is owned by a connector rather than the project runtime. Deselect it and start again.',
        retryable: false,
      };
    case 'SECRET_IDENTIFIER_KEY_COLLISION':
      return {
        title: 'Two selected secrets use the same variable name',
        detail:
          serverText ??
          'Two of the secrets you picked inject the same environment variable, so the session cannot tell them apart. Pick one of them.',
        retryable: false,
      };
    case 'INVALID_SESSION_SECRETS':
      return {
        title: 'That secret selection is not valid',
        detail: serverText ?? 'Adjust the selected secrets and start again.',
        retryable: false,
      };
    case 'CONNECTOR_CONNECTION_NOT_FOUND':
      return {
        title: 'That connection no longer exists',
        detail:
          serverText ??
          'The connection you picked has been removed. Pick another, or ask a teammate to reconnect it.',
        retryable: false,
      };
    case 'CONNECTOR_CONNECTION_INACTIVE':
      return {
        title: 'That connection needs reconnecting',
        detail:
          serverText ??
          'The connection you picked is revoked or disabled. A teammate needs to reconnect it before a session can use it.',
        retryable: false,
      };
    case 'origin_override_forbidden':
      // Direct mode: `secrets` is a backend-origin field, so a browser PAT is
      // refused. Developer-facing upstream copy would be meaningless here.
      return {
        title: 'Secret narrowing needs wrapper mode',
        detail:
          'This deployment is talking to Kortix directly, where the per-session secret allowlist is not available.',
        retryable: false,
      };
    case 'INVALID_SESSION_MODEL':
      return {
        title: 'That model is unavailable',
        detail: serverText ?? 'Pick a different model and try again.',
        retryable: false,
      };
    default:
      return {
        title: 'Could not start a session',
        detail: serverText ?? 'Something went wrong. Please try again.',
        // Unknown failures are assumed transient — a retry costs one request and
        // an unrecoverable one will simply refuse again with the same message.
        retryable: true,
      };
  }
}
