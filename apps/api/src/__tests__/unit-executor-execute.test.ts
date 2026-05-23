/**
 * Execution layer — request building, auth attachment, and dispatch.
 * Uses an injected fetch that records the request so we assert exactly what
 * would go over the wire (creds attached server-side, never in the sandbox).
 */
import { describe, expect, test } from 'bun:test';
import {
  applyAuth,
  buildHttpRequest,
  buildMcpRequest,
  executeCall,
  paramHintsFromSchema,
  performRequest,
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

describe('applyAuth', () => {
  test('bearer with default + custom prefix', () => {
    const h: Record<string, string> = {};
    applyAuth(h, new URLSearchParams(), BEARER, 'sk_123');
    expect(h.Authorization).toBe('Bearer sk_123');
    const h2: Record<string, string> = {};
    applyAuth(h2, new URLSearchParams(), { ...BEARER, prefix: 'Token' }, 'sk_123');
    expect(h2.Authorization).toBe('Token sk_123');
  });

  test('basic base64-encodes', () => {
    const h: Record<string, string> = {};
    applyAuth(h, new URLSearchParams(), { type: 'basic', in: 'header', name: null, prefix: null }, 'user:pass');
    expect(h.Authorization).toBe(`Basic ${Buffer.from('user:pass').toString('base64')}`);
  });

  test('custom header + custom query + prefix', () => {
    const h: Record<string, string> = {};
    applyAuth(h, new URLSearchParams(), { type: 'custom', in: 'header', name: 'X-API-Key', prefix: null }, 'k');
    expect(h['X-API-Key']).toBe('k');
    const q = new URLSearchParams();
    applyAuth({}, q, { type: 'custom', in: 'query', name: 'api_key', prefix: 'tok_' }, 'k');
    expect(q.get('api_key')).toBe('tok_k');
  });

  test('none / missing secret attaches nothing', () => {
    const h: Record<string, string> = {};
    applyAuth(h, new URLSearchParams(), { type: 'none', in: 'header', name: null, prefix: null }, 'x');
    applyAuth(h, new URLSearchParams(), BEARER, null);
    expect(Object.keys(h)).toHaveLength(0);
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

describe('buildHttpRequest', () => {
  test('substitutes path params, routes query, attaches bearer', () => {
    const req = buildHttpRequest({
      baseUrl: 'https://api.example.com/v1/',
      method: 'get',
      pathTemplate: '/pets/{petId}',
      auth: BEARER,
      secret: 'sk',
      args: { petId: 'p1', limit: 10 },
      paramHints: { petId: 'path', limit: 'query' },
    });
    expect(req.method).toBe('GET');
    expect(req.url).toBe('https://api.example.com/v1/pets/p1?limit=10');
    expect(req.headers.Authorization).toBe('Bearer sk');
    expect(req.body).toBeUndefined();
  });

  test('POST puts unhinted args in JSON body; explicit body wins', () => {
    const req = buildHttpRequest({
      baseUrl: 'https://api.example.com',
      method: 'post',
      pathTemplate: '/pets',
      args: { name: 'Rex', tag: 'dog' },
    });
    expect(req.method).toBe('POST');
    expect(req.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(req.body!)).toEqual({ name: 'Rex', tag: 'dog' });

    const req2 = buildHttpRequest({
      baseUrl: 'https://api.example.com',
      method: 'post',
      pathTemplate: '/pets',
      args: { body: { name: 'Rex' }, extra: 'ignored-into-body-too?' },
    });
    expect(JSON.parse(req2.body!)).toEqual({ name: 'Rex' }); // explicit body wins
  });

  test('GET routes unhinted args to query', () => {
    const req = buildHttpRequest({ baseUrl: 'https://x', method: 'get', pathTemplate: '/s', args: { q: 'hi', n: 2 } });
    expect(req.url).toContain('q=hi');
    expect(req.url).toContain('n=2');
    expect(req.body).toBeUndefined();
  });
});

describe('buildMcpRequest', () => {
  test('builds JSON-RPC tools/call with auth', () => {
    const req = buildMcpRequest({ url: 'https://mcp.x/mcp', auth: BEARER, secret: 'tok', toolName: 'search', args: { q: 'a' } });
    expect(req.method).toBe('POST');
    expect(req.headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(req.body!)).toMatchObject({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'search', arguments: { q: 'a' } },
    });
  });
});

describe('performRequest', () => {
  test('parses JSON, falls back to text', async () => {
    const json = recordingFetch(200, '{"a":1}');
    expect(await performRequest({ url: 'u', method: 'GET', headers: {} }, json.fetchImpl)).toEqual({ status: 200, ok: true, data: { a: 1 } });
    const txt = recordingFetch(500, 'boom');
    expect(await performRequest({ url: 'u', method: 'GET', headers: {} }, txt.fetchImpl)).toEqual({ status: 500, ok: false, data: 'boom' });
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
