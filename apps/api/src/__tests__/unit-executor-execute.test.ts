/**
 * Execution layer — request building, auth attachment, and dispatch.
 * Uses an injected fetch that records the request so we assert exactly what
 * would go over the wire (creds attached server-side, never in the sandbox).
 */
import { describe, expect, test } from 'bun:test';
import {
  executeCall,
  paramHintsFromSchema,
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

describe('executeCall dispatch', () => {
  test('openapi substitutes path params, routes query, and attaches bearer auth', async () => {
    const { fetchImpl, calls } = recordingFetch();
    await executeCall({
      binding: { kind: 'openapi', method: 'GET', path: '/pets/{petId}', server: 'https://api.example.com/v1/' },
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

  test('auth variants are attached only when a secret is present', async () => {
    const basic = recordingFetch();
    await executeCall({
      binding: { kind: 'http', method: 'GET', path: '/basic' },
      baseUrl: 'https://api.internal',
      auth: { type: 'basic', in: 'header', name: null, prefix: null },
      secret: 'user:pass',
      fetchImpl: basic.fetchImpl,
    });
    expect(basic.calls[0]!.headers.Authorization).toBe(`Basic ${Buffer.from('user:pass').toString('base64')}`);

    const header = recordingFetch();
    await executeCall({
      binding: { kind: 'http', method: 'GET', path: '/header' },
      baseUrl: 'https://api.internal',
      auth: { type: 'custom', in: 'header', name: 'X-API-Key', prefix: null },
      secret: 'k',
      fetchImpl: header.fetchImpl,
    });
    expect(header.calls[0]!.headers['X-API-Key']).toBe('k');

    const query = recordingFetch();
    await executeCall({
      binding: { kind: 'http', method: 'GET', path: '/query' },
      baseUrl: 'https://api.internal',
      auth: { type: 'custom', in: 'query', name: 'api_key', prefix: 'tok_' },
      secret: 'k',
      fetchImpl: query.fetchImpl,
    });
    expect(query.calls[0]!.url).toBe('https://api.internal/query?api_key=tok_k');

    const missing = recordingFetch();
    await executeCall({
      binding: { kind: 'http', method: 'GET', path: '/none' },
      baseUrl: 'https://api.internal',
      auth: BEARER,
      secret: null,
      fetchImpl: missing.fetchImpl,
    });
    expect(missing.calls[0]!.headers.Authorization).toBeUndefined();
  });

  test('POST puts unhinted args in JSON body and explicit body wins', async () => {
    const implicit = recordingFetch();
    await executeCall({
      binding: { kind: 'http', method: 'POST', path: '/pets' },
      baseUrl: 'https://api.example.com',
      args: { name: 'Rex', tag: 'dog' },
      fetchImpl: implicit.fetchImpl,
    });
    expect(implicit.calls[0]!.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(implicit.calls[0]!.body!)).toEqual({ name: 'Rex', tag: 'dog' });

    const explicit = recordingFetch();
    await executeCall({
      binding: { kind: 'http', method: 'POST', path: '/pets' },
      baseUrl: 'https://api.example.com',
      args: { body: { name: 'Rex' }, extra: 'ignored-into-body-too?' },
      fetchImpl: explicit.fetchImpl,
    });
    expect(JSON.parse(explicit.calls[0]!.body!)).toEqual({ name: 'Rex' });
  });

  test('GET routes unhinted args to query', async () => {
    const { fetchImpl, calls } = recordingFetch();
    await executeCall({
      binding: { kind: 'http', method: 'GET', path: '/s' },
      baseUrl: 'https://x',
      args: { q: 'hi', n: 2 },
      fetchImpl,
    });
    expect(calls[0]!.url).toContain('q=hi');
    expect(calls[0]!.url).toContain('n=2');
    expect(calls[0]!.body).toBeUndefined();
  });

  test('parses JSON, falls back to text, and parses SSE-framed JSON', async () => {
    const json = recordingFetch(200, '{"a":1}');
    expect(
      await executeCall({
        binding: { kind: 'http', method: 'GET', path: '/json' },
        baseUrl: 'https://api.internal',
        fetchImpl: json.fetchImpl,
      }),
    ).toEqual({ status: 200, ok: true, data: { a: 1 } });

    const txt = recordingFetch(500, 'boom');
    expect(
      await executeCall({
        binding: { kind: 'http', method: 'GET', path: '/text' },
        baseUrl: 'https://api.internal',
        fetchImpl: txt.fetchImpl,
      }),
    ).toEqual({ status: 500, ok: false, data: 'boom' });

    const sse = recordingFetch(200, 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"hi"}]}}\n\n');
    const res = await executeCall({
      binding: { kind: 'mcp', tool: 'search' },
      baseUrl: 'https://mcp.x/mcp',
      fetchImpl: sse.fetchImpl,
    });
    expect((res.data as any).result.content[0].text).toBe('hi');
  });

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
