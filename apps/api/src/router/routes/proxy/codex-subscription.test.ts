import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';

// Regression coverage for docs/specs/2026-07-21-codex-billing-leak-verification.md:
// a Codex ACP session authenticated with a user's own connected ChatGPT/Codex
// subscription used to fall through to the generic `/router/openai` proxy
// (handlers.ts's handleKortixProxy), which injects KORTIX'S OWN
// OPENAI_API_KEY/OPENROUTER_API_KEY and bills the user's Kortix credit wallet
// — completely bypassing the subscription. This route (/router/codex-subscription)
// is the fix: it only accepts a project-scoped account token, resolves the
// CALLER's own Codex credential via resolveCodexCredential, forwards with
// that access token, and never touches Kortix billing.

class FakeCodexRefreshError extends Error {}

let accountTokenResult: {
  isValid: boolean;
  userId?: string;
  accountId?: string;
  projectId?: string | null;
} = { isValid: false };
const validateAccountToken = mock(async (_token: string) => accountTokenResult);
mock.module('../../../repositories/account-tokens', () => ({ validateAccountToken }));

let codexCredential: { access: string; accountId?: string } | null = null;
let codexThrowsRefreshError = false;
let codexThrowsGenericError = false;
const resolveCodexCredential = mock(async (_projectId: string, _userId: string) => {
  if (codexThrowsRefreshError) throw new FakeCodexRefreshError('codex refresh failed');
  if (codexThrowsGenericError) throw new Error('boom');
  return codexCredential;
});
mock.module('../../../llm-gateway/credentials/codex', () => ({
  resolveCodexCredential,
  CodexRefreshError: FakeCodexRefreshError,
}));

// Reuse the SAME shape the real codexDescriptor produces (baseUrl/apiKey/headers)
// so the test also pins that this route reuses that single implementation
// rather than re-deriving the upstream target/headers itself.
mock.module('../../../llm-gateway/resolution/descriptors', () => ({
  codexDescriptor: (credential: { access: string; accountId?: string }, _model: string) => ({
    provider: 'openai-codex',
    kind: 'openai-responses',
    baseUrl: 'https://chatgpt.test/backend-api/codex',
    apiKey: credential.access,
    billingMode: 'none',
    markup: 0,
    resolvedModel: 'unused',
    headers: {
      originator: 'codex_cli_rs',
      'User-Agent': 'kortix-codex-test',
      ...(credential.accountId ? { 'ChatGPT-Account-ID': credential.accountId } : {}),
    },
  }),
}));

const { handleCodexSubscriptionProxy } = await import('./codex-subscription');

function buildApp() {
  const app = new Hono();
  app.all('/codex-subscription/*', handleCodexSubscriptionProxy);
  return app;
}

let originalFetch: typeof fetch;
let fetchCalls: { url: string; init: RequestInit }[] = [];

beforeEach(() => {
  accountTokenResult = { isValid: false };
  codexCredential = null;
  codexThrowsRefreshError = false;
  codexThrowsGenericError = false;
  fetchCalls = [];
  validateAccountToken.mockClear();
  resolveCodexCredential.mockClear();
  originalFetch = globalThis.fetch;
  globalThis.fetch = mock(async (url: string | URL, init?: RequestInit) => {
    fetchCalls.push({ url: url.toString(), init: init ?? {} });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('POST /router/codex-subscription/responses', () => {
  test('rejects a request with no bearer token', async () => {
    const app = buildApp();
    const res = await app.request('/codex-subscription/responses', { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
    expect(fetchCalls).toHaveLength(0);
  });

  test('rejects a bare sandbox token (kortix_sb_…) — validateAccountToken only accepts kortix_pat_… — never falls back to the Kortix-managed key', async () => {
    // validateAccountToken's real implementation rejects anything that isn't
    // `kortix_pat_…` outright (isAccountToken format check) — modeled here by
    // the mock simply returning isValid:false for a sandbox-shaped token, the
    // same terminal outcome. This is the regression guard for the original
    // bug: the vulnerable path was reachable specifically because the sandbox
    // token WAS accepted by the generic `/router/openai` Mode-1 check.
    accountTokenResult = { isValid: false };
    const app = buildApp();
    const res = await app.request('/codex-subscription/responses', {
      method: 'POST',
      headers: { Authorization: 'Bearer kortix_sb_faketoken' },
      body: '{}',
    });
    expect(res.status).toBe(401);
    expect(resolveCodexCredential).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);
  });

  test('rejects an account token with no projectId (cannot resolve a project-scoped Codex credential)', async () => {
    accountTokenResult = { isValid: true, userId: 'user_1', accountId: 'acct_1', projectId: null };
    const app = buildApp();
    const res = await app.request('/codex-subscription/responses', {
      method: 'POST',
      headers: { Authorization: 'Bearer kortix_pat_test' },
      body: '{}',
    });
    expect(res.status).toBe(401);
    expect(resolveCodexCredential).not.toHaveBeenCalled();
  });

  test('only allows POST /responses — every other method/subpath is rejected', async () => {
    accountTokenResult = {
      isValid: true,
      userId: 'user_1',
      accountId: 'acct_1',
      projectId: 'proj_1',
    };
    const app = buildApp();
    const res = await app.request('/codex-subscription/models', {
      method: 'GET',
      headers: { Authorization: 'Bearer kortix_pat_test' },
    });
    expect(res.status).toBe(403);
    expect(fetchCalls).toHaveLength(0);
  });

  test('missing/unconnected credential fails closed (401) — never falls back to a Kortix-managed key', async () => {
    accountTokenResult = {
      isValid: true,
      userId: 'user_1',
      accountId: 'acct_1',
      projectId: 'proj_1',
    };
    codexCredential = null;
    const app = buildApp();
    const res = await app.request('/codex-subscription/responses', {
      method: 'POST',
      headers: { Authorization: 'Bearer kortix_pat_test' },
      body: '{}',
    });
    expect(res.status).toBe(401);
    expect(fetchCalls).toHaveLength(0);
  });

  test('expired/revoked credential (CodexRefreshError) fails closed (401) — never falls back to a Kortix-managed key', async () => {
    accountTokenResult = {
      isValid: true,
      userId: 'user_1',
      accountId: 'acct_1',
      projectId: 'proj_1',
    };
    codexThrowsRefreshError = true;
    const app = buildApp();
    const res = await app.request('/codex-subscription/responses', {
      method: 'POST',
      headers: { Authorization: 'Bearer kortix_pat_test' },
      body: '{}',
    });
    expect(res.status).toBe(401);
    expect(fetchCalls).toHaveLength(0);
  });

  test('an unexpected resolution error fails closed (502) rather than falling back', async () => {
    accountTokenResult = {
      isValid: true,
      userId: 'user_1',
      accountId: 'acct_1',
      projectId: 'proj_1',
    };
    codexThrowsGenericError = true;
    const app = buildApp();
    const res = await app.request('/codex-subscription/responses', {
      method: 'POST',
      headers: { Authorization: 'Bearer kortix_pat_test' },
      body: '{}',
    });
    expect(res.status).toBe(502);
    expect(fetchCalls).toHaveLength(0);
  });

  test("a resolved credential forwards to the Codex backend with the USER'S OWN access token — never a Kortix-managed key", async () => {
    accountTokenResult = {
      isValid: true,
      userId: 'user_1',
      accountId: 'acct_1',
      projectId: 'proj_1',
    };
    codexCredential = { access: 'user-own-oauth-access-token', accountId: 'chatgpt_acct_9' };
    const app = buildApp();
    const res = await app.request('/codex-subscription/responses', {
      method: 'POST',
      headers: { Authorization: 'Bearer kortix_pat_test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.4', input: [] }),
    });
    expect(res.status).toBe(200);
    expect(resolveCodexCredential).toHaveBeenCalledWith('proj_1', 'user_1');
    expect(fetchCalls).toHaveLength(1);
    const call = fetchCalls.at(0);
    if (!call) throw new Error('expected a captured fetch call');
    expect(call.url).toBe('https://chatgpt.test/backend-api/codex/responses');
    const headers = new Headers(call.init.headers as HeadersInit);
    expect(headers.get('Authorization')).toBe('Bearer user-own-oauth-access-token');
    expect(headers.get('ChatGPT-Account-ID')).toBe('chatgpt_acct_9');
    // The inbound Kortix account token must never be forwarded upstream.
    expect(headers.get('Authorization')).not.toContain('kortix_pat_test');
  });
});
