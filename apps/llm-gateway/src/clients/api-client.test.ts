import { describe, expect, test } from 'bun:test';
import { GatewayResolutionError } from '@kortix/llm-gateway';

import { ApiUnavailableError, type FetchLike, createApiClient } from './api-client';

const principal = { userId: 'u1', accountId: 'a1' };

function client(fetchImpl: FetchLike) {
  return createApiClient({ baseUrl: 'https://api.test', token: 'secret', fetchImpl });
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('ApiClient', () => {
  test('authenticate returns the principal', async () => {
    const result = await client(async () => jsonResponse({ principal })).authenticate('tok');
    expect(result).toEqual(principal);
  });

  test('authenticate returns null for an invalid token', async () => {
    const result = await client(async () => jsonResponse({ principal: null })).authenticate('tok');
    expect(result).toBeNull();
  });

  test('sends the internal bearer token', async () => {
    let seenAuth: string | undefined;
    const fetchImpl: FetchLike = async (_url, init) => {
      seenAuth = (init.headers as Record<string, string>).authorization;
      return jsonResponse({ principal });
    };
    await client(fetchImpl).authenticate('tok');
    expect(seenAuth).toBe('Bearer secret');
  });

  test('resolveUpstream returns candidates', async () => {
    const candidates = [{ provider: 'openrouter' }, { provider: 'anthropic' }];
    const result = await client(async () => jsonResponse({ candidates })).resolveUpstream(
      principal,
      'm',
    );
    expect(result).toHaveLength(2);
  });

  test('resolveUpstream re-throws a typed GatewayResolutionError from the body (not a 5xx ApiUnavailableError)', async () => {
    // The API catches GatewayResolutionError in /resolve-upstream and returns
    // it in a 200 body. The client must reconstruct the typed error so the
    // pipeline's dispatch loop surfaces a clean 400 — and must NOT treat it as
    // a 5xx (which would retry 3x and lose the actionable suggestion).
    const c = client(async () =>
      jsonResponse({
        candidates: [],
        resolutionError: {
          code: 'provider_not_connected',
          message: 'Connect Codex to use this model.',
          suggestion: 'Connect your ChatGPT/Codex account in project settings, then retry.',
        },
      }),
    );
    await expect(c.resolveUpstream(principal, 'codex/gpt-5.6-sol')).rejects.toMatchObject({
      name: 'GatewayResolutionError',
      code: 'provider_not_connected',
      message: 'Connect Codex to use this model.',
      suggestion: 'Connect your ChatGPT/Codex account in project settings, then retry.',
    });
    await expect(c.resolveUpstream(principal, 'codex/gpt-5.6-sol')).rejects.toBeInstanceOf(
      GatewayResolutionError,
    );
  });

  test('resolveUpstream does NOT retry a resolutionError response (expected 4xx outcome, not a transient 5xx)', async () => {
    let calls = 0;
    const c = client(async () => {
      calls += 1;
      return jsonResponse({
        candidates: [],
        resolutionError: {
          code: 'provider_not_connected',
          message: 'Connect Codex to use this model.',
          suggestion: 'Connect your ChatGPT/Codex account in project settings, then retry.',
        },
      });
    });
    await expect(c.resolveUpstream(principal, 'codex/gpt-5.6-sol')).rejects.toBeInstanceOf(
      GatewayResolutionError,
    );
    expect(calls).toBe(1);
  });

  test('resolveRoute obtains the model plan from the API control plane', async () => {
    let seenPath = '';
    let seenBody: Record<string, unknown> = {};
    const c = client(async (url, init) => {
      seenPath = new URL(url).pathname;
      seenBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return jsonResponse({
        route: {
          policyId: 'platform-default',
          primaryModel: 'codex/gpt-5.6-sol',
          fallbackModels: ['glm-5.3-flash'],
          fallbackOn: 'any-error',
        },
      });
    });

    const route = await c.resolveRoute(principal, {
      requestedModel: 'codex/gpt-5.6-sol',
      requires: { imageInput: false },
    });

    expect(seenPath).toBe('/internal/gateway/resolve-route');
    expect(seenBody).toEqual({
      principal,
      input: { requestedModel: 'codex/gpt-5.6-sol', requires: { imageInput: false } },
    });
    expect(route).toMatchObject({
      policyId: 'platform-default',
      primaryModel: 'codex/gpt-5.6-sol',
      fallbackModels: ['glm-5.3-flash'],
    });
  });

  test('assertBillingActive throws when inactive', async () => {
    const c = client(async () => jsonResponse({ active: false, message: 'no subscription' }));
    await expect(c.assertBillingActive('a1')).rejects.toThrow('no subscription');
  });

  test('assertBillingActive resolves when active', async () => {
    const c = client(async () => jsonResponse({ active: true }));
    await expect(c.assertBillingActive('a1')).resolves.toBeUndefined();
  });

  test('assertBillingActive surfaces an admission holdUsd when the API took one (BILLING-CORRECTNESS atomic hold)', async () => {
    const c = client(async () => jsonResponse({ active: true, holdUsd: 0.01 }));
    await expect(c.assertBillingActive('a1')).resolves.toEqual({ holdUsd: 0.01 });
  });

  test('retries a 503 then succeeds', async () => {
    let calls = 0;
    const c = client(async () => {
      calls += 1;
      return calls < 2 ? jsonResponse({}, 503) : jsonResponse({ principal });
    });
    expect(await c.authenticate('tok')).toEqual(principal);
    expect(calls).toBe(2);
  });

  test('throws ApiUnavailableError after exhausting retries', async () => {
    const c = client(async () => jsonResponse({}, 500));
    await expect(c.authenticate('tok')).rejects.toBeInstanceOf(ApiUnavailableError);
  });

  // A control-plane call that is SLOW (no response at all before the per-attempt
  // budget) must be retried, exactly like one that fails fast with a 5xx.
  //
  // It was not: `withRetry` settles a timed-out attempt with a `TimeoutError`,
  // and `isRetryable` only accepted `ApiUnavailableError`, so `maxAttempts: 3`
  // was dead code for the one failure mode retries exist for. The un-retried
  // `TimeoutError` then escaped `authorize()` in simple-handler.ts (the only
  // un-guarded hook call in the pipeline) and surfaced as an opaque
  // `503 gateway_error "Gateway unavailable"`.
  //
  // Measured on staging 2026-09-16: 2 of 30 identical requests answered
  // 503 gateway_error at 5.14 s and 5.15 s (the 5 s per-attempt budget), the
  // other 28 answered 400 provider_disabled in 2.0-3.2 s. That is the
  // GW-ACCESS-1 release-gate flake (runs 35012251397, 35036053187).
  test('retries a control-plane call that exceeds the per-attempt timeout', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      // Attempt 1 never answers — a slow API, not a refused connection.
      if (calls === 1) return new Promise<Response>(() => {});
      return jsonResponse({ ok: true, principal });
    };
    const c = createApiClient({
      baseUrl: 'https://api.test',
      token: 'secret',
      fetchImpl,
      timeoutMs: 20,
    });
    expect(await c.authorize('tok')).toEqual({ ok: true, principal });
    expect(calls).toBe(2);
  });

  test('gives up after maxAttempts when every attempt times out', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return new Promise<Response>(() => {});
    };
    const c = createApiClient({
      baseUrl: 'https://api.test',
      token: 'secret',
      fetchImpl,
      timeoutMs: 20,
    });
    await expect(c.authorize('tok')).rejects.toBeInstanceOf(Error);
    expect(calls).toBe(3);
  });

  // The counterpart of the rule above. A settlement write has nobody waiting on
  // it, and a timed-out attempt the API actually committed would be charged
  // twice by a repeat (recordGatewayUsage inserts a usage row and deducts
  // credits; neither is keyed by request id at that layer). Writes therefore
  // keep the narrow policy: retry a refused or 5xx-answered attempt, never a
  // silent one.
  test('does NOT retry a settlement write that times out', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return new Promise<Response>(() => {});
    };
    const c = createApiClient({
      baseUrl: 'https://api.test',
      token: 'secret',
      fetchImpl,
      timeoutMs: 20,
    });
    await expect(
      c.recordUsage({ requestId: 'req_1' } as unknown as Parameters<typeof c.recordUsage>[0]),
    ).rejects.toBeInstanceOf(Error);
    expect(calls).toBe(1);
  });

  test('authorize returns the combined gate result (ok)', async () => {
    let seenPath: string | undefined;
    const c = client(async (url) => {
      seenPath = new URL(url).pathname;
      return jsonResponse({ ok: true, principal });
    });
    const result = await c.authorize('tok');
    expect(seenPath).toBe('/internal/gateway/authorize');
    expect(result).toEqual({ ok: true, principal });
  });

  test('authorize surfaces a typed denial', async () => {
    const c = client(async () =>
      jsonResponse({ ok: false, status: 402, errorCode: 'budget_exceeded', message: 'exhausted' }),
    );
    const result = await c.authorize('tok');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(402);
      expect(result.errorCode).toBe('budget_exceeded');
    }
  });
});
