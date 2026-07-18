/**
 * GAP C1 — "Connected" today only means a secret row exists; it never proves
 * the key actually works. verifyProviderConnection makes one cheap, single-
 * attempt completion against the resolved upstream and classifies the
 * outcome so the UI can render "Verified" vs "Key rejected" vs "Couldn't
 * verify" instead of a blind green checkmark. Pure-logic unit tests via
 * injected deps (mirrors unit-executor-gateway.test.ts's GatewayDeps style)
 * — no DB, no network.
 */
import { describe, expect, test } from 'bun:test';
import {
  GatewayResolutionError,
  UpstreamHttpError,
  NetworkError,
  TimeoutError,
} from '@kortix/llm-gateway';
import type { AuthedPrincipal, UpstreamDescriptor } from '@kortix/llm-gateway';
import { verifyProviderConnection, type ProviderVerifyDeps } from './provider-verify';

function principal(overrides: Partial<AuthedPrincipal> = {}): AuthedPrincipal {
  return { userId: 'user-1', accountId: 'acct-1', projectId: 'project-1', ...overrides };
}

function descriptor(overrides: Partial<UpstreamDescriptor> = {}): UpstreamDescriptor {
  return {
    provider: 'openai',
    kind: 'openai-compat',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-test',
    billingMode: 'none',
    markup: 0,
    resolvedModel: 'gpt-4o-mini',
    npm: '@ai-sdk/openai',
    ...overrides,
  };
}

function makeDeps(o: Partial<ProviderVerifyDeps> = {}): ProviderVerifyDeps {
  return {
    pickVerificationModel: o.pickVerificationModel ?? (() => 'openai/gpt-4o-mini'),
    resolveCandidates: o.resolveCandidates ?? (async () => [descriptor()]),
    callUpstream: o.callUpstream ?? (async () => new Response('{}', { status: 200 })),
  };
}

describe('verifyProviderConnection', () => {
  test('no catalog model to verify against -> unknown, never calls resolveCandidates', async () => {
    let resolveCalled = false;
    const result = await verifyProviderConnection(
      principal(),
      'made-up-provider',
      makeDeps({
        pickVerificationModel: () => null,
        resolveCandidates: async () => {
          resolveCalled = true;
          return [];
        },
      }),
    );
    expect(result.status).toBe('unknown');
    expect(resolveCalled).toBe(false);
  });

  test('resolveCandidates throws provider_not_connected -> not_connected, never calls upstream', async () => {
    let upstreamCalled = false;
    const result = await verifyProviderConnection(
      principal(),
      'openai',
      makeDeps({
        resolveCandidates: async () => {
          throw new GatewayResolutionError(
            'provider_not_connected',
            'No openai API key is connected for this project.',
            'Add a key.',
          );
        },
        callUpstream: async () => {
          upstreamCalled = true;
          return new Response('{}', { status: 200 });
        },
      }),
    );
    expect(result.status).toBe('not_connected');
    expect(result.message).toContain('No openai API key');
    expect(upstreamCalled).toBe(false);
  });

  test('resolveCandidates throws provider_reauth_required -> invalid (needs reconnect)', async () => {
    const result = await verifyProviderConnection(
      principal(),
      'codex',
      makeDeps({
        resolveCandidates: async () => {
          throw new GatewayResolutionError(
            'provider_reauth_required',
            'Your Codex session has expired or was revoked.',
            'Reconnect.',
          );
        },
      }),
    );
    expect(result.status).toBe('invalid');
  });

  test('resolveCandidates throws a non-credential resolution error (e.g. model_not_found) -> unknown', async () => {
    const result = await verifyProviderConnection(
      principal(),
      'openai',
      makeDeps({
        resolveCandidates: async () => {
          throw new GatewayResolutionError(
            'model_not_found',
            '"foo" is not a recognized model.',
            'Check the id.',
          );
        },
      }),
    );
    expect(result.status).toBe('unknown');
  });

  test('resolveCandidates returns no candidates -> unknown', async () => {
    const result = await verifyProviderConnection(
      principal(),
      'openai',
      makeDeps({ resolveCandidates: async () => [] }),
    );
    expect(result.status).toBe('unknown');
  });

  test('upstream call succeeds (2xx) -> verified', async () => {
    const result = await verifyProviderConnection(
      principal(),
      'openai',
      makeDeps({ callUpstream: async () => new Response('{"choices":[]}', { status: 200 }) }),
    );
    expect(result.status).toBe('verified');
  });

  test('upstream call sends a single-attempt, low-token request (cheap ping)', async () => {
    let seenBody: Record<string, unknown> | null = null;
    let seenRetry: unknown = null;
    await verifyProviderConnection(
      principal(),
      'openai',
      makeDeps({
        callUpstream: async (body, _descriptor, opts) => {
          seenBody = body;
          seenRetry = opts?.retry;
          return new Response('{}', { status: 200 });
        },
      }),
    );
    expect(seenBody).toBeTruthy();
    expect((seenBody as any).stream).toBe(false);
    expect((seenRetry as any)?.maxAttempts).toBe(1);
  });

  test('upstream throws UpstreamHttpError 401 -> invalid, surfaces the provider error body as a hint', async () => {
    const result = await verifyProviderConnection(
      principal(),
      'openai',
      makeDeps({
        callUpstream: async () => {
          throw new UpstreamHttpError(
            401,
            JSON.stringify({ error: { message: 'Incorrect API key provided' } }),
            'openai',
          );
        },
      }),
    );
    expect(result.status).toBe('invalid');
    expect(result.message).toContain('Incorrect API key provided');
  });

  test('upstream throws UpstreamHttpError 403 -> invalid', async () => {
    const result = await verifyProviderConnection(
      principal(),
      'anthropic',
      makeDeps({
        callUpstream: async () => {
          throw new UpstreamHttpError(403, '', 'anthropic');
        },
      }),
    );
    expect(result.status).toBe('invalid');
  });

  test('upstream throws UpstreamHttpError 429 -> unknown (rate limited, not proof the key is bad)', async () => {
    const result = await verifyProviderConnection(
      principal(),
      'openai',
      makeDeps({
        callUpstream: async () => {
          throw new UpstreamHttpError(429, '', 'openai');
        },
      }),
    );
    expect(result.status).toBe('unknown');
  });

  test('upstream throws UpstreamHttpError 400 (bad request unrelated to auth) -> unknown, never invalid', async () => {
    const result = await verifyProviderConnection(
      principal(),
      'openai',
      makeDeps({
        callUpstream: async () => {
          throw new UpstreamHttpError(
            400,
            JSON.stringify({ error: { message: 'model requires more tokens' } }),
            'openai',
          );
        },
      }),
    );
    expect(result.status).toBe('unknown');
  });

  test('upstream throws UpstreamHttpError 500 -> unknown', async () => {
    const result = await verifyProviderConnection(
      principal(),
      'openai',
      makeDeps({
        callUpstream: async () => {
          throw new UpstreamHttpError(500, '', 'openai');
        },
      }),
    );
    expect(result.status).toBe('unknown');
  });

  test('upstream throws TimeoutError -> unknown, not invalid', async () => {
    const result = await verifyProviderConnection(
      principal(),
      'openai',
      makeDeps({
        callUpstream: async () => {
          throw new TimeoutError('attempt 1 exceeded 8000ms');
        },
      }),
    );
    expect(result.status).toBe('unknown');
  });

  test('upstream throws NetworkError -> unknown, not invalid', async () => {
    const result = await verifyProviderConnection(
      principal(),
      'openai',
      makeDeps({
        callUpstream: async () => {
          throw new NetworkError('ai-sdk call to openai failed');
        },
      }),
    );
    expect(result.status).toBe('unknown');
  });
});
