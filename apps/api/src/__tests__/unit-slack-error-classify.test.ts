import { describe, expect, test } from 'bun:test';

import { classifyTurnError, parseBalance } from '../channels/slack/errors';

describe('classifyTurnError', () => {
  test('out of credits — 402 status', () => {
    const r = classifyTurnError({ name: 'APIError', statusCode: 402, message: 'Payment Required' });
    expect(r.title).toBe('Out of credits');
    expect(r.aborted).toBe(false);
    expect(r.text.toLowerCase()).toContain('out of credits');
    expect(r.text).toContain('Top up');
  });

  test('out of credits — message text without an explicit 402 status', () => {
    const r = classifyTurnError({
      name: 'APIError',
      message: 'Payment Required: Insufficient credits. Balance: $-0.06',
    });
    expect(r.title).toBe('Out of credits');
    // Balance is parsed out of the message and surfaced.
    expect(r.text).toContain('$-0.06');
  });

  test('usage limit — 429 status', () => {
    const r = classifyTurnError({ name: 'APIError', statusCode: 429, message: 'Too Many Requests' });
    expect(r.title).toBe('Usage limit reached');
    expect(r.text.toLowerCase()).toContain('usage limit');
  });

  test('usage limit — "usage limit has been reached" message', () => {
    const r = classifyTurnError({ message: 'The usage limit has been reached' });
    expect(r.title).toBe('Usage limit reached');
    expect(r.aborted).toBe(false);
  });

  test('abort — MessageAbortedError is lowkey, not a failure', () => {
    const r = classifyTurnError({ name: 'MessageAbortedError', message: 'The operation was aborted' });
    expect(r.aborted).toBe(true);
    expect(r.title).toBe('Run stopped');
  });

  test('abort — detected from message text too', () => {
    const r = classifyTurnError({ message: 'Request was cancelled' });
    expect(r.aborted).toBe(true);
  });

  test('provider auth error surfaces the provider message', () => {
    const r = classifyTurnError({ name: 'ProviderAuthError', message: 'Invalid API key for anthropic' });
    expect(r.title).toBe('Run failed');
    expect(r.text).toContain('Invalid API key for anthropic');
  });

  test('unknown error never hides the real message', () => {
    const r = classifyTurnError({ name: 'UnknownError', message: 'connect ETIMEDOUT 1.2.3.4:443' });
    expect(r.title).toBe('Run failed');
    expect(r.text).toContain('ETIMEDOUT');
    expect(r.aborted).toBe(false);
  });

  test('no error info → generic failure copy (never blank)', () => {
    const r = classifyTurnError(undefined);
    expect(r.title).toBe('Run failed');
    expect(r.text.length).toBeGreaterThan(0);
    expect(r.aborted).toBe(false);
  });

  test('long messages are truncated with an ellipsis', () => {
    const long = 'x'.repeat(900);
    const r = classifyTurnError({ name: 'UnknownError', message: long });
    expect(r.text.length).toBeLessThan(500);
    expect(r.text).toContain('…');
  });

  // Credits classification beats the generic abort substring match: "payment
  // required" must not be shadowed by anything, and a real credits error wins.
  test('credits classification takes priority over generic text', () => {
    const r = classifyTurnError({ statusCode: 402, message: 'Insufficient credits' });
    expect(r.title).toBe('Out of credits');
    expect(r.aborted).toBe(false);
  });
});

describe('parseBalance', () => {
  test('parses a negative balance', () => {
    expect(parseBalance('Insufficient credits. Balance: $-0.06')).toBe('$-0.06');
  });
  test('parses a positive balance without a dollar sign', () => {
    expect(parseBalance('balance: 12.5 remaining')).toBe('$12.50');
  });
  test('returns null when there is no balance', () => {
    expect(parseBalance('Payment Required')).toBeNull();
  });
});
