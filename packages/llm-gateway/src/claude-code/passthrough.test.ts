import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { AuthedPrincipal } from '../domain/principal';
import { createClaudeCodePassthrough, type ClaudeCodeHooks, type ClaudeCodeRequest } from './passthrough';

const PRINCIPAL: AuthedPrincipal = { userId: 'u1', accountId: 'a1', projectId: 'p1', sessionId: 's1' };
const BODY = '{"model":"claude-sonnet-5-5","stream":true,"messages":[{"role":"user","content":"hi ✓"}]}';
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

type Seen = { url: string; headers: Record<string, string>; body: string };

function harness(options: {
  credentials?: Awaited<ReturnType<ClaudeCodeHooks['claudeCredentials']>>;
  upstream?: (attempt: number) => Response;
  principal?: AuthedPrincipal | null;
}) {
  const seen: Seen[] = [];
  const calls = { authenticate: [] as string[], credentials: [] as Array<string | null>, rateLimits: [] as Array<[string, number]>, refused: [] as Array<[string, string]> };
  const hooks: ClaudeCodeHooks = {
    authenticate: async (token) => {
      calls.authenticate.push(token);
      return options.principal === undefined ? PRINCIPAL : options.principal;
    },
    claudeCredentials: async (_principal, input) => {
      calls.credentials.push(input.model);
      return options.credentials ?? { credentials: [{ secretId: 'acc-1', apiKey: 'sk-ant-oat01-first' }, { secretId: 'acc-2', apiKey: 'sk-ant-oat01-second' }] };
    },
    notePoolRateLimit: async (_principal, secretId, seconds) => {
      calls.rateLimits.push([secretId, seconds]);
    },
    claudeRefused: async (_principal, secretId, failedKeySha256) => {
      calls.refused.push([secretId, failedKeySha256]);
    },
  };
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    seen.push({ url: String(url), headers, body: init?.body ? new TextDecoder().decode(init.body as Uint8Array) : '' });
    return (options.upstream ?? (() => new Response('data: ok\n\n', { headers: { 'content-type': 'text/event-stream' } })))(seen.length);
  }) as typeof fetch;
  const handle = createClaudeCodePassthrough(hooks, { upstream: 'https://anthropic.test', fetchImpl });
  return { handle, seen, calls };
}

function request(overrides: Partial<ClaudeCodeRequest> = {}): ClaudeCodeRequest {
  return {
    method: 'POST',
    path: '/v1/messages',
    search: '?beta=true',
    headers: new Headers({
      authorization: 'Bearer kortix-session-token',
      'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'user-agent': 'claude-cli/2.1.316 (external, sdk-cli)',
      'x-app': 'cli',
      'x-claude-code-session-id': 'c-1',
      'x-stainless-os': 'Linux',
      'content-type': 'application/json',
      accept: 'application/json',
      cookie: 'secret=1',
      'x-forwarded-for': '10.0.0.1',
      'x-api-key': 'leak',
    }),
    body: new TextEncoder().encode(BODY),
    ...overrides,
  };
}

describe('Claude Code passthrough', () => {
  test('forwards the body unchanged with the account token and only Claude Code headers', async () => {
    const { handle, seen, calls } = harness({});
    const res = await handle(request());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(await res.text()).toBe('data: ok\n\n');
    expect(calls.authenticate).toEqual(['kortix-session-token']);
    expect(calls.credentials).toEqual(['claude-sonnet-5-5']);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://anthropic.test/v1/messages?beta=true');
    expect(seen[0]!.body).toBe(BODY);
    expect(seen[0]!.headers).toEqual({
      authorization: 'Bearer sk-ant-oat01-first',
      'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'user-agent': 'claude-cli/2.1.316 (external, sdk-cli)',
      'x-app': 'cli',
      'x-claude-code-session-id': 'c-1',
      'x-stainless-os': 'Linux',
      'content-type': 'application/json',
      accept: 'application/json',
    });
  });

  test('an x-api-key authenticates when no Authorization header is sent', async () => {
    const { handle, calls } = harness({});
    const headers = new Headers({ 'x-api-key': 'kortix-session-token', 'content-type': 'application/json' });
    expect((await handle(request({ headers }))).status).toBe(200);
    expect(calls.authenticate).toEqual(['kortix-session-token']);
  });

  test('a 429 rests that account and the request moves to the next one', async () => {
    const { handle, seen, calls } = harness({
      upstream: (attempt) => attempt === 1
        ? new Response('{"type":"error","error":{"type":"rate_limit_error","message":"limit"}}', { status: 429, headers: { 'retry-after': '120' } })
        : new Response('{"id":"msg"}', { headers: { 'content-type': 'application/json' } }),
    });
    const res = await handle(request());
    expect(res.status).toBe(200);
    expect(calls.rateLimits).toEqual([['acc-1', 120]]);
    expect(seen.map((entry) => entry.headers.authorization)).toEqual(['Bearer sk-ant-oat01-first', 'Bearer sk-ant-oat01-second']);
  });

  test('a 429 without retry-after rests the account 60 s; the last account answers the 429', async () => {
    const { handle, calls } = harness({
      credentials: { credentials: [{ secretId: 'acc-1', apiKey: 'sk-ant-oat01-first' }] },
      upstream: () => new Response('{"type":"error"}', { status: 429 }),
    });
    expect((await handle(request())).status).toBe(429);
    expect(calls.rateLimits).toEqual([['acc-1', 60]]);
  });

  test('a 401 marks that account refused (by digest) and the request moves to the next one', async () => {
    const { handle, calls } = harness({
      upstream: (attempt) => attempt === 1 ? new Response('{"type":"error"}', { status: 401 }) : new Response('{}'),
    });
    expect((await handle(request())).status).toBe(200);
    expect(calls.refused).toEqual([['acc-1', sha256('sk-ant-oat01-first')]]);
  });

  test('no account: the host reason in the Anthropic error shape, nothing sent upstream', async () => {
    const { handle, seen } = harness({
      credentials: { error: { status: 400, code: 'provider_not_connected', message: 'Connect Claude to use this model.', suggestion: 'Sign in with Claude.' } },
    });
    const res = await handle(request());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ type: 'error', error: { type: 'invalid_request_error', message: 'Connect Claude to use this model. Sign in with Claude.' } });
    expect(seen).toHaveLength(0);
  });

  test('a missing or unknown token answers 401 before any account lookup', async () => {
    const missing = harness({});
    expect((await missing.handle(request({ headers: new Headers({ 'content-type': 'application/json' }) }))).status).toBe(401);
    expect(missing.calls.credentials).toHaveLength(0);
    const unknown = harness({ principal: null });
    expect((await unknown.handle(request())).status).toBe(401);
    expect(unknown.calls.credentials).toHaveLength(0);
  });

  test('the connectivity check answers 200 without a token', async () => {
    const { handle, seen } = harness({});
    const res = await handle(request({ method: 'HEAD', path: '/api/hello', search: '', headers: new Headers(), body: null }));
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(0);
  });

  test('any other path answers 404 and reaches nobody', async () => {
    const { handle, seen, calls } = harness({});
    expect((await handle(request({ path: '/v1/models', method: 'GET', body: null }))).status).toBe(404);
    expect((await handle(request({ path: '/api/oauth/profile', method: 'GET', body: null }))).status).toBe(404);
    expect(seen).toHaveLength(0);
    expect(calls.authenticate).toHaveLength(0);
  });

  test('count_tokens is forwarded the same way', async () => {
    const { handle, seen } = harness({});
    expect((await handle(request({ path: '/v1/messages/count_tokens' }))).status).toBe(200);
    expect(seen[0]!.url).toBe('https://anthropic.test/v1/messages/count_tokens?beta=true');
  });
});
