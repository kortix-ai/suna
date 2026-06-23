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

  test('provider auth error → actionable provider-config copy', () => {
    const r = classifyTurnError({ name: 'ProviderAuthError', message: 'Invalid API key' });
    expect(r.title).toBe('Provider rejected the request');
    expect(r.text.toLowerCase()).toContain('api key');
    expect(r.text.toLowerCase()).toContain('admin');
  });

  test('unknown error with a non-transient message is surfaced verbatim', () => {
    const r = classifyTurnError({ name: 'UnknownError', message: 'Something weird happened in the toolchain' });
    expect(r.title).toBe('Run failed');
    expect(r.text).toContain('Something weird happened');
    expect(r.aborted).toBe(false);
  });

  test('no error info → generic failure copy (never blank)', () => {
    const r = classifyTurnError(undefined);
    expect(r.title).toBe('Run failed');
    expect(r.text.length).toBeGreaterThan(0);
    expect(r.aborted).toBe(false);
  });

  // ── New taxonomy branches ────────────────────────────────────────────────

  test('output-length error → "Response too long" (no raw message needed)', () => {
    const r = classifyTurnError({ name: 'MessageOutputLengthError' });
    expect(r.title).toBe('Response too long');
    expect(r.text.toLowerCase()).toContain('cut off');
    expect(r.aborted).toBe(false);
  });

  test('content-filter / safety refusal → neutral "Request blocked", no raw text echoed', () => {
    const raw = 'flagged by content policy: graphic_violence detail that should not be shown';
    const r = classifyTurnError({ name: 'APIError', statusCode: 400, message: raw });
    expect(r.title).toBe('Request blocked');
    expect(r.text).not.toContain('graphic_violence');
    expect(r.text.toLowerCase()).toContain('content-policy');
  });

  test('context-window-exceeded → "Conversation too long"', () => {
    const r = classifyTurnError({
      name: 'APIError',
      statusCode: 400,
      message: "This model's maximum context length is 200000 tokens",
    });
    expect(r.title).toBe('Conversation too long');
    expect(r.text.toLowerCase()).toContain('context window');
  });

  test('model-not-found (404) → "Model unavailable" with a config next step', () => {
    const r = classifyTurnError({ name: 'APIError', statusCode: 404, message: 'The model `gpt-foo` does not exist' });
    expect(r.title).toBe('Model unavailable');
    expect(r.text.toLowerCase()).toContain('model');
  });

  test('401 → provider config copy (consolidated with ProviderAuthError)', () => {
    const r = classifyTurnError({ name: 'APIError', statusCode: 401, message: 'Unauthorized' });
    expect(r.title).toBe('Provider rejected the request');
    expect(r.text.toLowerCase()).toContain('api key');
  });

  test('ProviderAuthError names the provider when providerID is present', () => {
    const r = classifyTurnError({ name: 'ProviderAuthError', providerID: 'anthropic', message: 'bad key' });
    expect(r.title).toBe('Provider rejected the request');
    expect(r.text).toContain('anthropic');
  });

  test('transient — isRetryable flag wins even with a scary raw body', () => {
    const r = classifyTurnError({
      name: 'APIError',
      isRetryable: true,
      message: '<html><body>502 Bad Gateway nginx/1.2.3</body></html>',
    });
    expect(r.title).toBe('Provider unavailable');
    expect(r.text).not.toContain('502');
    expect(r.text).not.toContain('html');
    expect(r.text.toLowerCase()).toContain('temporary');
  });

  test('transient — 503 status with no isRetryable flag', () => {
    const r = classifyTurnError({ name: 'APIError', statusCode: 503, message: 'Service Unavailable' });
    expect(r.title).toBe('Provider unavailable');
  });

  test('transient — socket error (no status code) detected from text', () => {
    const r = classifyTurnError({ name: 'UnknownError', message: 'connect ETIMEDOUT 1.2.3.4:443' });
    expect(r.title).toBe('Provider unavailable');
    expect(r.text).not.toContain('ETIMEDOUT');
  });

  test('detail-less unknown error names the error type for debuggability', () => {
    const r = classifyTurnError({ name: 'UnknownError' });
    expect(r.title).toBe('Run failed');
    expect(r.text).toContain('UnknownError');
    expect(r.text.toLowerCase()).toContain('unexpected error');
  });

  // Ordering guards: credits/usage win over the transient bucket even though a
  // 429 can be flagged retryable.
  test('429 with isRetryable still classifies as usage limit, not transient', () => {
    const r = classifyTurnError({ name: 'APIError', statusCode: 429, isRetryable: true, message: 'Too Many Requests' });
    expect(r.title).toBe('Usage limit reached');
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
