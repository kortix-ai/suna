import { describe, expect, test } from 'bun:test';
import { sendFailureTitle } from '../../src/lib/send-failure';
import { sessionCreateFailure } from '../../src/lib/session-create-failure';

describe('sendFailureTitle', () => {
  test('billing reads as an operator problem, not a retry', () => {
    expect(sendFailureTitle({ kind: 'billing', message: 'x' } as never)).toContain('credit');
  });

  test('a not-ready runtime reads as transient', () => {
    expect(sendFailureTitle({ kind: 'runtime-not-ready', message: 'x' } as never)).toContain(
      'starting',
    );
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
    expect(sendFailureTitle({ kind: 'runtime-error', message: 'x' } as never)).toBe(
      'The agent could not run that',
    );
  });

  test('an unknown kind never produces an empty title', () => {
    expect(sendFailureTitle({ kind: 'something-new', message: 'x' } as never).length).toBeGreaterThan(0);
  });
});

describe('sessionCreateFailure', () => {
  const apiError = (code: string, message: string) =>
    Object.assign(new Error(message), { code, data: { code, error: message } });

  test('the spend cap passes the server’s numbers through and is NOT retryable', () => {
    // The server message carries $spent / $limit / window — inventing a vaguer
    // one would drop the only part the end-user can act on.
    const failure = sessionCreateFailure(
      apiError('per_end_user_spend_limit', 'This end-user has spent $12.50 in the last 30 days (limit $10.00).'),
    );
    expect(failure.title).toBe('Spending limit reached');
    expect(failure.detail).toContain('$12.50');
    expect(failure.retryable).toBe(false);
  });

  test('the per-end-user CONCURRENCY cap is retryable — it self-clears', () => {
    const failure = sessionCreateFailure(apiError('per_origin_session_limit', 'already has 3 active sessions'));
    expect(failure.retryable).toBe(true);
  });

  test('the two 429s are told apart, not merged', () => {
    const spend = sessionCreateFailure(apiError('per_end_user_spend_limit', 'x'));
    const concurrency = sessionCreateFailure(apiError('per_origin_session_limit', 'y'));
    expect(spend.title).not.toBe(concurrency.title);
    expect(spend.retryable).not.toBe(concurrency.retryable);
  });

  test('billing refusals are terminal for the end-user', () => {
    expect(sessionCreateFailure(apiError('insufficient_credits', 'no credit')).retryable).toBe(false);
  });

  test('an unrecognised failure stays generic but retryable', () => {
    const failure = sessionCreateFailure(apiError('SOMETHING_NEW', 'boom'));
    expect(failure.title).toBe('Could not start a session');
    expect(failure.retryable).toBe(true);
  });

  test('a non-API throw does not crash the classifier', () => {
    expect(sessionCreateFailure(new Error('network down')).title).toBe('Could not start a session');
    expect(sessionCreateFailure(null).title).toBe('Could not start a session');
  });
});
