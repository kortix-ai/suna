import { describe, expect, test } from 'bun:test';
import { checkApiKeyLiveness, hasLivenessProbe } from './api-key';

describe('hasLivenessProbe', () => {
  test('true for the two Phase-1 launch providers', () => {
    expect(hasLivenessProbe('anthropic')).toBe(true);
    expect(hasLivenessProbe('openai')).toBe(true);
  });

  test('false for a provider with no registered probe — unverified is the honest default, not a gap', () => {
    expect(hasLivenessProbe('groq')).toBe(false);
    expect(hasLivenessProbe('openrouter')).toBe(false);
    expect(hasLivenessProbe('github-copilot')).toBe(false);
  });
});

describe('checkApiKeyLiveness', () => {
  test('invalid immediately for an empty/whitespace key — never sends a request', async () => {
    let called = false;
    const status = await checkApiKeyLiveness('anthropic', '   ', async () => {
      called = true;
      return new Response('{}', { status: 200 });
    });
    expect(status).toBe('invalid');
    expect(called).toBe(false);
  });

  test('unverified for a provider with no registered probe, without ever calling fetch', async () => {
    let called = false;
    const status = await checkApiKeyLiveness('some-unregistered-provider', 'key-a', async () => {
      called = true;
      return new Response('{}', { status: 200 });
    });
    expect(status).toBe('unverified');
    expect(called).toBe(false);
  });

  test('healthy on a 2xx response from a registered provider', async () => {
    const status = await checkApiKeyLiveness(
      'anthropic',
      'key-healthy-a',
      async () => new Response('{}', { status: 200 }),
    );
    expect(status).toBe('healthy');
  });

  test('invalid on 401/403 from a registered provider', async () => {
    expect(
      await checkApiKeyLiveness(
        'openai',
        'key-401-a',
        async () => new Response('{}', { status: 401 }),
      ),
    ).toBe('invalid');
    expect(
      await checkApiKeyLiveness(
        'openai',
        'key-403-a',
        async () => new Response('{}', { status: 403 }),
      ),
    ).toBe('invalid');
  });

  test('unverified (never invalid) on a 5xx/429 or network error — ambiguous never means broken', async () => {
    expect(
      await checkApiKeyLiveness(
        'anthropic',
        'key-500-a',
        async () => new Response('{}', { status: 500 }),
      ),
    ).toBe('unverified');
    expect(
      await checkApiKeyLiveness(
        'anthropic',
        'key-429-a',
        async () => new Response('{}', { status: 429 }),
      ),
    ).toBe('unverified');
    expect(
      await checkApiKeyLiveness('anthropic', 'key-network-a', async () => {
        throw new Error('network blip');
      }),
    ).toBe('unverified');
  });

  test('sends Anthropic keys as x-api-key, OpenAI keys as a bearer token', async () => {
    const anthropicHeaders: { headers: Headers | null } = { headers: null };
    await checkApiKeyLiveness('anthropic', 'anthropic-key-b', async (_input, init) => {
      anthropicHeaders.headers = new Headers(init?.headers);
      return new Response('{}', { status: 200 });
    });
    expect(anthropicHeaders.headers?.get('x-api-key')).toBe('anthropic-key-b');

    const openaiHeaders: { headers: Headers | null } = { headers: null };
    await checkApiKeyLiveness('openai', 'openai-key-b', async (_input, init) => {
      openaiHeaders.headers = new Headers(init?.headers);
      return new Response('{}', { status: 200 });
    });
    expect(openaiHeaders.headers?.get('authorization')).toBe('Bearer openai-key-b');
  });

  test('rate-limits repeat checks of the same (provider, key) within the window — does not call fetch twice', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return new Response('{}', { status: 200 });
    };
    const key = `rate-limit-probe-key-${crypto.randomUUID()}`;
    const first = await checkApiKeyLiveness('anthropic', key, fetchImpl);
    const second = await checkApiKeyLiveness('anthropic', key, fetchImpl);
    expect(first).toBe('healthy');
    expect(second).toBe('healthy');
    expect(calls).toBe(1);
  });

  test('does not rate-limit a DIFFERENT key for the same provider', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return new Response('{}', { status: 200 });
    };
    await checkApiKeyLiveness('anthropic', `distinct-key-a-${crypto.randomUUID()}`, fetchImpl);
    await checkApiKeyLiveness('anthropic', `distinct-key-b-${crypto.randomUUID()}`, fetchImpl);
    expect(calls).toBe(2);
  });
});
