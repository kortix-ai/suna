import { describe, expect, test } from 'bun:test';
import { sendFailureTitle } from '../../src/lib/send-failure';
import { sessionCreateFailure } from '../../src/lib/session-create-failure';

describe('sendFailureTitle', () => {
  test('billing reads as an operator problem, not a retry', () => {
    expect(
      sendFailureTitle({ kind: 'billing', message: 'x' } as never),
    ).toContain('credit');
  });

  test('a not-ready runtime reads as transient', () => {
    expect(
      sendFailureTitle({ kind: 'runtime-not-ready', message: 'x' } as never),
    ).toContain('starting');
  });

  test('a gateway failure names WHICH provider when the envelope carries it', () => {
    expect(
      sendFailureTitle({
        kind: 'runtime-error',
        message: 'x',
        gateway: { provider: 'anthropic' },
      } as never),
    ).toBe('The anthropic model failed');
  });

  test('a gateway failure without a provider still reads sensibly', () => {
    expect(
      sendFailureTitle({ kind: 'runtime-error', message: 'x' } as never),
    ).toBe('The agent could not run that');
  });

  test('an unknown kind never produces an empty title', () => {
    expect(
      sendFailureTitle({ kind: 'something-new', message: 'x' } as never).length,
    ).toBeGreaterThan(0);
  });
});

describe('sessionCreateFailure', () => {
  const apiError = (code: string, message: string) =>
    Object.assign(new Error(message), { code, data: { code, error: message } });

  test('billing refusals are terminal for the end-user', () => {
    expect(
      sessionCreateFailure(apiError('insufficient_credits', 'no credit'))
        .retryable,
    ).toBe(false);
  });

  test('an unrecognised failure stays generic but retryable', () => {
    const failure = sessionCreateFailure(apiError('SOMETHING_NEW', 'boom'));
    expect(failure.title).toBe('Could not start a session');
    expect(failure.retryable).toBe(true);
  });

  test('a non-API throw does not crash the classifier', () => {
    expect(sessionCreateFailure(new Error('network down')).title).toBe(
      'Could not start a session',
    );
    expect(sessionCreateFailure(null).title).toBe('Could not start a session');
  });
});

describe('the overrides dialog makes new refusals reachable (F3)', () => {
  const apiError = (code: string, message = 'x') =>
    Object.assign(new Error(message), { code, data: { code, error: message } });

  test('every code the secrets/connector overrides can produce is TERMINAL, not retryable', () => {
    // Each of these refuses identically on retry: the allowlist and the bindings
    // are create-only, so offering "try again" sends the user in a loop.
    for (const code of [
      'SECRET_IDENTIFIER_NOT_FOUND',
      'SECRET_IDENTIFIER_KEY_COLLISION',
      'INVALID_SESSION_SECRETS',
      'CONNECTOR_CONNECTION_NOT_FOUND',
      'CONNECTOR_CONNECTION_INACTIVE',
      'origin_override_forbidden',
    ]) {
      const failure = sessionCreateFailure(apiError(code));
      expect(failure.retryable).toBe(false);
      expect(failure.title).not.toBe('Could not start a session');
    }
  });

  test('the key-collision refusal names the actual problem', () => {
    // "Two identifiers inject the same env var" is legal in the project and
    // illegal in one session — the user cannot guess that from a generic error.
    const failure = sessionCreateFailure(
      apiError('SECRET_IDENTIFIER_KEY_COLLISION'),
    );
    expect(failure.title.toLowerCase()).toContain('same variable name');
  });

  test('direct mode gets its own copy, not upstream developer text', () => {
    // `secrets` is backend-origin-only, so in direct mode the server's own
    // message is about token kinds — meaningless to an end user.
    const failure = sessionCreateFailure(
      apiError('origin_override_forbidden', 'origin override forbidden'),
    );
    expect(failure.title).toContain('wrapper mode');
    // and it must NOT pass the upstream sentence through, unlike the cases where
    // the server's message carries numbers the user needs.
    expect(failure.detail).not.toContain('origin override forbidden');
  });
});
