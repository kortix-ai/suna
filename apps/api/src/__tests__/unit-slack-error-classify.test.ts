import { describe, expect, test } from 'bun:test';

import { classifyTurnError, parseBalance, TEAMS_TURN_ERROR_COMMANDS } from '../channels/slack/errors';

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

  // A prod thread was told "give it a minute" while its only ChatGPT account
  // was out for 4 more days. The gateway names the reset; the card repeats it.
  test('usage limit — a ChatGPT plan limit names its reset and the model command, not "a minute"', () => {
    const body = JSON.stringify({
      message: 'All selected ChatGPT connections reached their usage limit. The first resets in 4 days.',
      code: 'provider_pool_rate_limited',
      suggestion: 'Choose another model, or connect another ChatGPT account.',
    });
    const info = { name: 'UnknownError', statusCode: 429, code: 'rate_limit', message: `429: ${body}` };
    const slack = classifyTurnError(info);
    expect(slack.title).toBe('Usage limit reached');
    expect(slack.text).toContain('ChatGPT usage limit');
    expect(slack.text).toContain('resets in 4 days');
    expect(slack.text).toContain('`/kortix models`');
    expect(slack.text).not.toContain('minute');
    expect(classifyTurnError(info, TEAMS_TURN_ERROR_COMMANDS).text).toContain('`/models`');
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

  test('abort — detected from an anchored user-stop phrase', () => {
    const r = classifyTurnError({ message: 'Cancelled by user' });
    expect(r.aborted).toBe(true);
  });

  // Regression (review finding 1): a real failure status must never be read as a
  // user stop just because its body contains the word "abort"/"cancelled".
  test('500 whose body says "aborted" is transient, NOT a quiet user stop', () => {
    const r = classifyTurnError({ name: 'APIError', statusCode: 500, message: 'Upstream aborted the connection' });
    expect(r.aborted).toBe(false);
    expect(r.title).toBe('Provider unavailable');
  });

  test('402 whose body says "cancelled" still classifies as out of credits', () => {
    const r = classifyTurnError({ statusCode: 402, message: 'payment cancelled — insufficient credits' });
    expect(r.aborted).toBe(false);
    expect(r.title).toBe('Out of credits');
  });

  test('a bare "the provider cancelled the subscription" is surfaced, not silenced as a stop', () => {
    const r = classifyTurnError({ message: 'The provider cancelled the subscription for this API key' });
    expect(r.aborted).toBe(false);
    expect(r.title).toBe('Run failed');
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

  // OpenCode compacts on overflow by itself; this error reaches a thread only
  // when its compaction failed, and a summary request would fail the same way.
  test('OpenCode`s ContextOverflowError → "Conversation too long", never "ask me to summarize"', () => {
    const r = classifyTurnError({
      name: 'ContextOverflowError',
      message: 'Conversation history too large to compact - exceeds model context limit',
    });
    expect(r.title).toBe('Conversation too long');
    expect(r.text).toContain('Start a new thread');
    expect(r.text.toLowerCase()).not.toContain('summarize');
  });

  test('model-not-found (404) → "Model unavailable" with a config next step', () => {
    const r = classifyTurnError({ name: 'APIError', statusCode: 404, message: 'The model `gpt-foo` does not exist' });
    expect(r.title).toBe('Model unavailable');
    expect(r.text.toLowerCase()).toContain('model');
  });

  // Prod 2026-09-30: OpenCode's own wording. "The selected model" sent people
  // to the web picker, which showed a different, working model.
  test('OpenCode`s "Model not found" names the model and the Slack command', () => {
    const r = classifyTurnError({
      name: 'UnknownError',
      message: 'Model not found: codex/gpt-6-sol. Did you mean: gpt-6-sol-mini?',
    });
    expect(r.title).toBe('Model unavailable');
    expect(r.text).toBe(
      ":warning: *The model `codex/gpt-6-sol` isn't available.* Pick another model with `/kortix models`, then start a new thread.",
    );
  });

  test('Teams gets its own model command', () => {
    const r = classifyTurnError({ message: 'Model not found: codex/gpt-6-sol.' }, TEAMS_TURN_ERROR_COMMANDS);
    expect(r.text).toBe(
      ":warning: *The model `codex/gpt-6-sol` isn't available.* Pick another model with `/models`, then send your message again.",
    );
  });

  test('a model error that names no ref keeps the generic subject', () => {
    const r = classifyTurnError({ name: 'APIError', statusCode: 404, message: 'The model `gpt-foo` does not exist' });
    expect(r.text).toStartWith(":warning: *The selected model isn't available.*");
  });

  test('agent-not-found → "Agent unavailable" routing to /kortix agents', () => {
    const r = classifyTurnError({ name: 'UnknownError', message: 'agent "shipper" not found' });
    expect(r.title).toBe('Agent unavailable');
    expect(r.text).toContain('/kortix agents');
    expect(r.aborted).toBe(false);
  });

  test('agent-not-declared (legacy runtime failure) → "Agent unavailable"', () => {
    const r = classifyTurnError({ message: 'Agent "old-bot" is not a declared agent in this project' });
    expect(r.title).toBe('Agent unavailable');
  });

  // The agent bucket requires the word "agent" so it can never shadow the
  // broader model-not-found "does not exist" match.
  test('a model "does not exist" error without the word "agent" stays "Model unavailable"', () => {
    const r = classifyTurnError({ name: 'APIError', statusCode: 404, message: 'The model `gpt-foo` does not exist' });
    expect(r.title).toBe('Model unavailable');
  });

  test('401 → provider config copy (consolidated with ProviderAuthError)', () => {
    const r = classifyTurnError({ name: 'APIError', statusCode: 401, message: 'Unauthorized' });
    expect(r.title).toBe('Provider rejected the request');
    expect(r.text.toLowerCase()).toContain('api key');
  });

  // A Teams turn on dev (2026-09-29) failed with ChatGPT's own 401. The generic
  // copy sent the user to "a workspace admin" about "its API key": neither
  // exists for a ChatGPT login. Only whoever connected the login can fix it.
  test('a refused ChatGPT login says who reconnects it, not "check the API key"', () => {
    const body = JSON.stringify({ error: { message: 'Could not parse your authentication token. Please try signing in again.', code: 'unauthorized_unknown' }, status: 401 });
    for (const message of [body, 'Could not parse your authentication token. Please try signing in again.']) {
      const r = classifyTurnError({ name: 'APIError', statusCode: 401, providerID: 'kortix', message });
      expect(r.title).toBe('ChatGPT login needs reconnection');
      expect(r.text).toContain('ChatGPT accounts');
      expect(r.text.toLowerCase()).not.toContain('api key');
    }
    // Any other 401 keeps the provider-config copy.
    expect(classifyTurnError({ name: 'APIError', statusCode: 401, message: 'Unauthorized' }).title).toBe('Provider rejected the request');
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

  // Regression (review finding 2): a retryable 5xx whose body mentions a "safety
  // system" is transient, not a permanent content-policy refusal.
  test('5xx mentioning "safety-check service" is transient, not a content block', () => {
    const r = classifyTurnError({ name: 'APIError', statusCode: 500, message: 'Internal error in safety-check service; please retry' });
    expect(r.title).toBe('Provider unavailable');
  });

  // Regression (review finding 5): a non-5xx permanent error whose body merely
  // narrates "internal server error" must not be relabeled transient.
  test('400 whose body narrates "internal server error" is surfaced, not faux-transient', () => {
    const r = classifyTurnError({
      statusCode: 400,
      isRetryable: false,
      message: 'the upstream returned an internal server error while validating the request',
    });
    expect(r.title).toBe('Run failed');
    expect(r.text).toContain('internal server error');
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

describe('classifyTurnError — the daemon code decides (W5 E11)', () => {
  test.each([
    ['credits', 'Out of credits'],
    ['rate_limit', 'Usage limit reached'],
    ['auth', 'Provider rejected the request'],
    ['context_length', 'Conversation too long'],
    ['output_length', 'Response too long'],
    ['aborted', 'Run stopped'],
  ] as const)('code %s with no name, status or matching text', (code, title) => {
    expect(classifyTurnError({ name: 'UnknownError', message: 'upstream said no', code }).title).toBe(title);
  });

  test('a specific code beats text that names another bucket', () => {
    expect(classifyTurnError({ message: 'rate limit exceeded', code: 'auth' }).title).toBe('Provider rejected the request');
  });

  test('code unknown falls back to the name, status and text checks', () => {
    expect(classifyTurnError({ message: 'Insufficient credits. Balance: $-0.06', code: 'unknown' }).title).toBe('Out of credits');
    expect(classifyTurnError({ name: 'TimeoutError', message: 'The session made no progress.', code: 'unknown' }).title).toBe('Run failed');
  });

  test('a ChatGPT login refusal still wins over an auth code', () => {
    const r = classifyTurnError({ statusCode: 401, message: 'Could not parse your authentication token.', code: 'auth' });
    expect(r.title).toBe('ChatGPT login needs reconnection');
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
