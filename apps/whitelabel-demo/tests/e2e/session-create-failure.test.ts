import { describe, expect, test } from 'bun:test';
import { sessionCreateFailure } from '../../src/lib/session-create-failure';

/**
 * Characterization for the create-failure copy: every refusal code the server
 * sends maps to a distinct title, a fixed retryable answer, and a server text
 * that flows through when present. The refactor that turns the switch into a
 * table must not move any of these.
 */
/** The shape the SDK's `ApiError` actually presents: the parsed body on `data`,
 *  the lifted `code`, and the server text as `message` (`src/lib/api-error-body.ts`). */
const apiError = (code: string, error?: string) => ({
  code,
  message: error,
  ...(error !== undefined ? { data: { code, error } } : { data: { code } }),
});

describe('sessionCreateFailure', () => {
  test('credit refusals are never retryable', () => {
    for (const code of ['subscription_required', 'insufficient_credits']) {
      const failure = sessionCreateFailure(apiError(code));
      expect(failure.title).toBe('Out of credit');
      expect(failure.retryable).toBe(false);
    }
    expect(sessionCreateFailure(apiError('insufficient_credits', 'balance is empty')).detail).toBe(
      'balance is empty',
    );
  });

  test('a connector the agent lacks is an operator fix, not a retry', () => {
    const failure = sessionCreateFailure(apiError('CONNECTOR_NOT_ASSIGNED'));
    expect(failure.title).toBe('This agent is missing a connector');
    expect(failure.retryable).toBe(false);
  });

  test('secret selection refusals name the list, not the server', () => {
    expect(sessionCreateFailure(apiError('SECRET_IDENTIFIER_NOT_FOUND')).title).toBe(
      'A selected secret is not available to sessions',
    );
    expect(sessionCreateFailure(apiError('SECRET_IDENTIFIER_KEY_COLLISION')).title).toBe(
      'Two selected secrets use the same variable name',
    );
    expect(sessionCreateFailure(apiError('INVALID_SESSION_SECRETS')).title).toBe(
      'That secret selection is not valid',
    );
    for (const code of [
      'SECRET_IDENTIFIER_NOT_FOUND',
      'SECRET_IDENTIFIER_KEY_COLLISION',
      'INVALID_SESSION_SECRETS',
    ]) {
      expect(sessionCreateFailure(apiError(code)).retryable).toBe(false);
    }
  });

  test('a connection that vanished or was revoked is never retryable', () => {
    expect(sessionCreateFailure(apiError('CONNECTOR_CONNECTION_NOT_FOUND')).title).toBe(
      'That connection no longer exists',
    );
    expect(sessionCreateFailure(apiError('CONNECTOR_CONNECTION_INACTIVE')).title).toBe(
      'That connection needs reconnecting',
    );
  });

  test('secret narrowing behind a browser PAT says wrapper mode is required', () => {
    const failure = sessionCreateFailure(apiError('origin_override_forbidden'));
    expect(failure.title).toBe('Secret narrowing needs wrapper mode');
    expect(failure.retryable).toBe(false);
    // Developer-facing upstream copy would be meaningless here: the detail is
    // this app's own, never the server text.
    expect(sessionCreateFailure(apiError('origin_override_forbidden', 'upstream says no')).detail).toBe(
      'This deployment is talking to Kortix directly, where the per-session secret allowlist is not available.',
    );
  });

  test('an unavailable model is a pick-again, not a retry', () => {
    const failure = sessionCreateFailure(apiError('INVALID_SESSION_MODEL'));
    expect(failure.title).toBe('That model is unavailable');
    expect(failure.retryable).toBe(false);
    expect(sessionCreateFailure(apiError('INVALID_SESSION_MODEL', 'no such model')).detail).toBe(
      'no such model',
    );
  });

  test('an unknown code stays retryable and says so in words a user can act on', () => {
    const failure = sessionCreateFailure(apiError('SOMETHING_NEW'));
    expect(failure.title).toBe('Could not start a session');
    expect(failure.retryable).toBe(true);
  });

  test('a non-ApiError failure is the generic retryable one', () => {
    expect(sessionCreateFailure(null).retryable).toBe(true);
    expect(sessionCreateFailure(new Error('network died')).retryable).toBe(true);
  });
});
