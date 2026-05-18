/**
 * Unit tests for the OAuth device-code flow logic.
 *
 * Each test sets a fake `globalThis.fetch` so we exercise the upstream
 * contract (request URLs/bodies + response handling) without actually
 * hitting auth.openai.com or github.com.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  pollOnceCopilot,
  pollOnceOpenAi,
  startCopilotDeviceFlow,
  startOpenAiDeviceFlow,
} from '../projects/oauth-flow';

type FetchCall = { url: string; init: RequestInit | undefined };
const calls: FetchCall[] = [];
const responders: Array<(url: string, init?: RequestInit) => Response | null> = [];
const originalFetch = globalThis.fetch;

function fakeJsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  calls.length = 0;
  responders.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    for (const responder of responders) {
      const res = responder(url, init);
      if (res) return res;
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('startOpenAiDeviceFlow', () => {
  test('posts to /api/accounts/deviceauth/usercode and returns user_code + handle', async () => {
    responders.push((url) => {
      if (url === 'https://auth.openai.com/api/accounts/deviceauth/usercode') {
        return fakeJsonResponse(200, {
          device_auth_id: 'dev-123',
          user_code: 'AAAA-BBBB',
          interval: '5',
          expires_in: 600,
        });
      }
      return null;
    });

    const flow = await startOpenAiDeviceFlow();

    expect(flow.user_code).toBe('AAAA-BBBB');
    expect(flow.verification_url).toBe('https://auth.openai.com/codex/device');
    expect(flow.interval_ms).toBe(5000);
    expect(flow.handle).toEqual({ device_auth_id: 'dev-123', user_code: 'AAAA-BBBB' });
    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body.client_id).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
  });

  test('throws on upstream failure', async () => {
    responders.push(() => new Response('boom', { status: 500 }));
    await expect(startOpenAiDeviceFlow()).rejects.toThrow(/500/);
  });
});

describe('pollOnceOpenAi', () => {
  const handle = { device_auth_id: 'dev-1', user_code: 'AAAA-BBBB' };

  test('returns pending on 403', async () => {
    responders.push(() => new Response('', { status: 403 }));
    const result = await pollOnceOpenAi(handle);
    expect(result.status).toBe('pending');
  });

  test('returns pending on 404', async () => {
    responders.push(() => new Response('', { status: 404 }));
    const result = await pollOnceOpenAi(handle);
    expect(result.status).toBe('pending');
  });

  test('returns failed on terminal upstream error', async () => {
    responders.push(() => new Response('', { status: 500 }));
    const result = await pollOnceOpenAi(handle);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error).toBe('upstream_500');
  });

  test('exchanges authorization_code for tokens, extracting accountId from id_token JWT', async () => {
    const idTokenClaims = {
      chatgpt_account_id: 'org-from-id-token',
      email: 'user@example.com',
    };
    const idToken = `header.${Buffer.from(JSON.stringify(idTokenClaims)).toString('base64url')}.sig`;

    responders.push((url) => {
      if (url === 'https://auth.openai.com/api/accounts/deviceauth/token') {
        return fakeJsonResponse(200, {
          authorization_code: 'auth-code-abc',
          code_verifier: 'verifier-xyz',
        });
      }
      if (url === 'https://auth.openai.com/oauth/token') {
        return fakeJsonResponse(200, {
          id_token: idToken,
          access_token: 'access-123',
          refresh_token: 'refresh-456',
          expires_in: 3600,
        });
      }
      return null;
    });

    const result = await pollOnceOpenAi(handle);

    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.refresh).toBe('refresh-456');
    expect(result.access).toBe('access-123');
    expect(result.accountId).toBe('org-from-id-token');
    expect(result.enterpriseUrl).toBeNull();
    expect(result.expires).toBeGreaterThan(Date.now() + 3000 * 1000);

    // Verify the exchange call body
    const exchangeCall = calls.find((c) => c.url === 'https://auth.openai.com/oauth/token');
    expect(exchangeCall).toBeDefined();
    const body = new URLSearchParams(exchangeCall!.init?.body as string);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('auth-code-abc');
    expect(body.get('code_verifier')).toBe('verifier-xyz');
    expect(body.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
    expect(body.get('redirect_uri')).toBe('https://auth.openai.com/deviceauth/callback');
  });

  test('falls back to organizations[0].id when chatgpt_account_id is missing', async () => {
    const claims = { organizations: [{ id: 'org-fallback' }] };
    const idToken = `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
    responders.push((url) => {
      if (url.endsWith('/deviceauth/token')) {
        return fakeJsonResponse(200, { authorization_code: 'a', code_verifier: 'v' });
      }
      if (url.endsWith('/oauth/token')) {
        return fakeJsonResponse(200, {
          id_token: idToken,
          access_token: 'a',
          refresh_token: 'r',
        });
      }
      return null;
    });

    const result = await pollOnceOpenAi(handle);
    expect(result.status).toBe('success');
    if (result.status === 'success') expect(result.accountId).toBe('org-fallback');
  });

  test('rejects invalid handles without making any HTTP call', async () => {
    const result = await pollOnceOpenAi({});
    expect(result.status).toBe('failed');
    expect(calls).toHaveLength(0);
  });
});

describe('startCopilotDeviceFlow', () => {
  test('posts to github.com/login/device/code with read:user scope by default', async () => {
    responders.push((url) => {
      if (url === 'https://github.com/login/device/code') {
        return fakeJsonResponse(200, {
          verification_uri: 'https://github.com/login/device',
          user_code: 'XYZA-1234',
          device_code: 'devcode-1',
          interval: 5,
          expires_in: 900,
        });
      }
      return null;
    });

    const flow = await startCopilotDeviceFlow();

    expect(flow.user_code).toBe('XYZA-1234');
    expect(flow.verification_url).toBe('https://github.com/login/device');
    expect(flow.interval_ms).toBe(5000);
    expect(flow.handle.device_code).toBe('devcode-1');
    expect(flow.handle.domain).toBe('github.com');
    expect(flow.handle.enterprise_url).toBeNull();

    const body = JSON.parse(calls[0].init?.body as string);
    expect(body.client_id).toBe('Ov23li8tweQw6odWQebz');
    expect(body.scope).toBe('read:user');
  });

  test('routes to enterprise host when enterpriseUrl is provided', async () => {
    responders.push((url) => {
      if (url === 'https://company.ghe.com/login/device/code') {
        return fakeJsonResponse(200, {
          verification_uri: 'https://company.ghe.com/login/device',
          user_code: 'ENT-CODE',
          device_code: 'devcode-ent',
          interval: 5,
        });
      }
      return null;
    });

    const flow = await startCopilotDeviceFlow({ enterpriseUrl: 'https://company.ghe.com' });

    expect(flow.handle.domain).toBe('company.ghe.com');
    expect(flow.handle.enterprise_url).toBe('company.ghe.com');
    expect(flow.verification_url).toBe('https://company.ghe.com/login/device');
  });
});

describe('pollOnceCopilot', () => {
  const handle = { device_code: 'devcode-1', domain: 'github.com', enterprise_url: null };

  test('returns pending on authorization_pending', async () => {
    responders.push(() => fakeJsonResponse(200, { error: 'authorization_pending' }));
    const result = await pollOnceCopilot(handle);
    expect(result.status).toBe('pending');
  });

  test('returns slow_down with bumped interval per RFC 8628', async () => {
    responders.push(() => fakeJsonResponse(200, { error: 'slow_down' }));
    const result = await pollOnceCopilot(handle);
    expect(result.status).toBe('slow_down');
    if (result.status === 'slow_down') expect(result.new_interval_ms).toBe(5_000);
  });

  test('honors server-suggested interval on slow_down', async () => {
    responders.push(() => fakeJsonResponse(200, { error: 'slow_down', interval: 12 }));
    const result = await pollOnceCopilot(handle);
    expect(result.status).toBe('slow_down');
    if (result.status === 'slow_down') expect(result.new_interval_ms).toBe(12_000);
  });

  test('returns success with expires=0 (Copilot tokens do not expire)', async () => {
    responders.push(() => fakeJsonResponse(200, { access_token: 'gho_test' }));
    const result = await pollOnceCopilot(handle);
    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.access).toBe('gho_test');
    expect(result.refresh).toBe('gho_test');
    expect(result.expires).toBe(0);
    expect(result.enterpriseUrl).toBeNull();
  });

  test('propagates enterpriseUrl from handle on success', async () => {
    responders.push(() => fakeJsonResponse(200, { access_token: 'gho_ent' }));
    const result = await pollOnceCopilot({ ...handle, enterprise_url: 'company.ghe.com' });
    expect(result.status).toBe('success');
    if (result.status === 'success') expect(result.enterpriseUrl).toBe('company.ghe.com');
  });

  test('returns failed on terminal upstream error', async () => {
    responders.push(() => fakeJsonResponse(200, { error: 'access_denied' }));
    const result = await pollOnceCopilot(handle);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error).toBe('access_denied');
  });

  test('returns failed on non-2xx upstream response', async () => {
    responders.push(() => new Response('', { status: 500 }));
    const result = await pollOnceCopilot(handle);
    expect(result.status).toBe('failed');
  });

  test('verifies device-code grant body shape', async () => {
    responders.push(() => fakeJsonResponse(200, { access_token: 'gho_x' }));
    await pollOnceCopilot(handle);
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body.client_id).toBe('Ov23li8tweQw6odWQebz');
    expect(body.device_code).toBe('devcode-1');
    expect(body.grant_type).toBe('urn:ietf:params:oauth:grant-type:device_code');
  });
});
