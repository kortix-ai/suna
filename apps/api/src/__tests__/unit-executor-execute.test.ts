/**
 * Execution layer — request building, auth attachment, and dispatch.
 * Uses an injected fetch that records the request so we assert exactly what
 * would go over the wire (creds attached server-side, never in the sandbox).
 */
import { describe, expect, test } from 'bun:test';
import {
  executeCall,
  paramHintsFromSchema,
  parseResponseBody,
  type ExecutorAuth,
  type FetchImpl,
} from '../executor/execute';

const BEARER: ExecutorAuth = { type: 'bearer', in: 'header', name: null, prefix: null };

function recordingFetch(status = 200, responseBody = '{"ok":true}') {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
  const fetchImpl: FetchImpl = async (url, init) => {
    calls.push({ url, ...init });
    return { status, ok: status >= 200 && status < 300, text: async () => responseBody };
  };
  return { fetchImpl, calls };
}

describe('auth attachment', () => {
  test('bearer with default + custom prefix', async () => {
    const defaults = recordingFetch();
    await executeCall({
      binding: { kind: 'http', method: 'GET', path: '/users' },
      baseUrl: 'https://api.example.com',
      auth: BEARER,
      secret: 'sk_123',
      fetchImpl: defaults.fetchImpl,
    });
    expect(defaults.calls[0]!.headers.Authorization).toBe('Bearer sk_123');

    const custom = recordingFetch();
    await executeCall({
      binding: { kind: 'http', method: 'GET', path: '/users' },
      baseUrl: 'https://api.example.com',
      auth: { ...BEARER, prefix: 'Token' },
      secret: 'sk_123',
      fetchImpl: custom.fetchImpl,
    });
    expect(custom.calls[0]!.headers.Authorization).toBe('Token sk_123');
  });

  test('basic base64-encodes', async () => {
    const { fetchImpl, calls } = recordingFetch();
    await executeCall({
      binding: { kind: 'http', method: 'GET', path: '/users' },
      baseUrl: 'https://api.example.com',
      auth: { type: 'basic', in: 'header', name: null, prefix: null },
      secret: 'user:pass',
      fetchImpl,
    });
    expect(calls[0]!.headers.Authorization).toBe(`Basic ${Buffer.from('user:pass').toString('base64')}`);
  });

  test('custom header + custom query + prefix', async () => {
    const header = recordingFetch();
    await executeCall({
      binding: { kind: 'http', method: 'GET', path: '/users' },
      baseUrl: 'https://api.example.com',
      auth: { type: 'custom', in: 'header', name: 'X-API-Key', prefix: null },
      secret: 'k',
      fetchImpl: header.fetchImpl,
    });
    expect(header.calls[0]!.headers['X-API-Key']).toBe('k');

    const query = recordingFetch();
    await executeCall({
      binding: { kind: 'http', method: 'GET', path: '/users' },
      baseUrl: 'https://api.example.com',
      auth: { type: 'custom', in: 'query', name: 'api_key', prefix: 'tok_' },
      secret: 'k',
      fetchImpl: query.fetchImpl,
    });
    expect(new URL(query.calls[0]!.url).searchParams.get('api_key')).toBe('tok_k');
  });

  test('none / missing secret attaches nothing', async () => {
    const none = recordingFetch();
    await executeCall({
      binding: { kind: 'http', method: 'GET', path: '/users' },
      baseUrl: 'https://api.example.com',
      auth: { type: 'none', in: 'header', name: null, prefix: null },
      secret: 'x',
      fetchImpl: none.fetchImpl,
    });
    expect(Object.keys(none.calls[0]!.headers)).toHaveLength(0);

    const missing = recordingFetch();
    await executeCall({
      binding: { kind: 'http', method: 'GET', path: '/users' },
      baseUrl: 'https://api.example.com',
      auth: BEARER,
      secret: null,
      fetchImpl: missing.fetchImpl,
    });
    expect(Object.keys(missing.calls[0]!.headers)).toHaveLength(0);
  });
});

describe('paramHintsFromSchema', () => {
  test('reads x-in from properties', () => {
    expect(
      paramHintsFromSchema({
        type: 'object',
        properties: { id: { 'x-in': 'path' }, limit: { 'x-in': 'query' }, body: { type: 'object' } },
      }),
    ).toEqual({ id: 'path', limit: 'query' });
  });
});

describe('HTTP execution request shape', () => {
  test('substitutes path params, routes query, attaches bearer', async () => {
    const { fetchImpl, calls } = recordingFetch();
    await executeCall({
      binding: { kind: 'http', method: 'get', path: '/pets/{petId}' },
      baseUrl: 'https://api.example.com/v1/',
      auth: BEARER,
      secret: 'sk',
      args: { petId: 'p1', limit: 10 },
      paramHints: { petId: 'path', limit: 'query' },
      fetchImpl,
    });
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.url).toBe('https://api.example.com/v1/pets/p1?limit=10');
    expect(calls[0]!.headers.Authorization).toBe('Bearer sk');
    expect(calls[0]!.body).toBeUndefined();
  });

  test('POST puts unhinted args in JSON body; explicit body wins', async () => {
    const implicit = recordingFetch();
    await executeCall({
      binding: { kind: 'http', method: 'post', path: '/pets' },
      baseUrl: 'https://api.example.com',
      args: { name: 'Rex', tag: 'dog' },
      fetchImpl: implicit.fetchImpl,
    });
    expect(implicit.calls[0]!.method).toBe('POST');
    expect(implicit.calls[0]!.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(implicit.calls[0]!.body!)).toEqual({ name: 'Rex', tag: 'dog' });

    const explicit = recordingFetch();
    await executeCall({
      binding: { kind: 'http', method: 'post', path: '/pets' },
      baseUrl: 'https://api.example.com',
      args: { body: { name: 'Rex' }, extra: 'ignored-into-body-too?' },
      fetchImpl: explicit.fetchImpl,
    });
    expect(JSON.parse(explicit.calls[0]!.body!)).toEqual({ name: 'Rex' }); // explicit body wins
  });

  test('GET routes unhinted args to query', async () => {
    const { fetchImpl, calls } = recordingFetch();
    await executeCall({
      binding: { kind: 'http', method: 'get', path: '/s' },
      baseUrl: 'https://x',
      args: { q: 'hi', n: 2 },
      fetchImpl,
    });
    expect(calls[0]!.url).toContain('q=hi');
    expect(calls[0]!.url).toContain('n=2');
    expect(calls[0]!.body).toBeUndefined();
  });
});

describe('MCP execution request shape', () => {
  test('builds JSON-RPC tools/call with auth', async () => {
    const { fetchImpl, calls } = recordingFetch();
    await executeCall({
      binding: { kind: 'mcp', tool: 'search' },
      baseUrl: 'https://mcp.x/mcp',
      auth: BEARER,
      secret: 'tok',
      args: { q: 'a' },
      fetchImpl,
    });
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'search', arguments: { q: 'a' } },
    });
  });
});

describe('parseResponseBody', () => {
  test('parses JSON, falls back to text', async () => {
    expect(parseResponseBody('{"a":1}')).toEqual({ a: 1 });
    expect(parseResponseBody('boom')).toBe('boom');
  });

  test('parses SSE-framed JSON (MCP streamable-HTTP)', () => {
    const res = parseResponseBody('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"hi"}]}}\n\n');
    expect((res as any).result.content[0].text).toBe('hi');
  });
});

describe('executeCall dispatch', () => {
  test('openapi uses binding.server when no baseUrl override', async () => {
    const { fetchImpl, calls } = recordingFetch();
    await executeCall({
      binding: { kind: 'openapi', method: 'DELETE', path: '/pets/{id}', server: 'https://api.example.com' },
      auth: BEARER,
      secret: 'sk',
      args: { id: 'p9' },
      paramHints: { id: 'path' },
      fetchImpl,
    });
    expect(calls[0]!.url).toBe('https://api.example.com/pets/p9');
    expect(calls[0]!.method).toBe('DELETE');
    expect(calls[0]!.headers.Authorization).toBe('Bearer sk');
  });

  test('http requires baseUrl', async () => {
    const { fetchImpl, calls } = recordingFetch();
    await executeCall({
      binding: { kind: 'http', method: 'GET', path: '/users' },
      baseUrl: 'https://api.internal',
      fetchImpl,
    });
    expect(calls[0]!.url).toBe('https://api.internal/users');
  });

  test('mcp posts JSON-RPC to url', async () => {
    const { fetchImpl, calls } = recordingFetch(200, '{"jsonrpc":"2.0","id":1,"result":{"ok":1}}');
    const res = await executeCall({
      binding: { kind: 'mcp', tool: 'search' },
      baseUrl: 'https://mcp.x/mcp',
      args: { q: 'hi' },
      fetchImpl,
    });
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({ method: 'tools/call', params: { name: 'search' } });
    expect((res.data as any).result).toEqual({ ok: 1 });
  });

  test('graphql builds a query with inline args + selection, posts to endpoint', async () => {
    const { fetchImpl, calls } = recordingFetch(200, '{"data":{"user":{"id":"1"}}}');
    const res = await executeCall({
      binding: { kind: 'graphql', operation: 'query', field: 'user' },
      baseUrl: 'https://api/graphql',
      auth: BEARER,
      secret: 'gtok',
      args: { id: '1', __select: 'id name' },
      fetchImpl,
    });
    expect(calls[0]!.url).toBe('https://api/graphql');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.headers.Authorization).toBe('Bearer gtok');
    expect(JSON.parse(calls[0]!.body!).query).toBe('query { user(id:"1") { id name } }');
    expect((res.data as any).data.user).toEqual({ id: '1' });
  });

  test('graphql requires an endpoint', async () => {
    const { fetchImpl } = recordingFetch();
    await expect(
      executeCall({ binding: { kind: 'graphql', operation: 'query', field: 'user' }, fetchImpl }),
    ).rejects.toThrow('endpoint');
  });
});
