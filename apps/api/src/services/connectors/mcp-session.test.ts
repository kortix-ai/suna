/**
 * MCP streamable-HTTP session handshake. Servers built on the official SDKs in
 * stateful mode answer any request that arrives without `Mcp-Session-Id` with
 * HTTP 400 "Server not initialized" / "Missing session ID". Kortix must then
 * run `initialize` → `notifications/initialized`, keep the issued session id,
 * and replay the request — exactly what every MCP client does.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import {
  type FetchImpl,
  executeCall,
  listMcpTools,
  resetMcpSessionCache,
} from './call';

const BEARER = { type: 'bearer' as const, in: 'header' as const, name: 'Authorization', prefix: 'Bearer' };

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** A stateful MCP server: requires initialize, issues a session id, and can forget sessions. */
function statefulServer(opts: { sessionId?: string; forget?: Set<string> } = {}) {
  const sessionId = opts.sessionId ?? 'sess-1';
  const calls: Call[] = [];
  let initialized = 0;
  const fetchImpl: FetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const message = JSON.parse(init.body ?? '{}') as { method: string; id?: number };
    const respond = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
      status,
      ok: status >= 200 && status < 300,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    });
    if (message.method === 'initialize') {
      initialized++;
      return respond(
        200,
        {
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'stateful', version: '1' },
          },
        },
        { 'mcp-session-id': sessionId },
      );
    }
    const presented = init.headers['Mcp-Session-Id'];
    if (!presented) {
      return respond(400, {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: Server not initialized' },
        id: null,
      });
    }
    if (opts.forget?.has(presented)) {
      opts.forget.delete(presented);
      return respond(404, { jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null });
    }
    if (message.method === 'notifications/initialized') return respond(202, '');
    if (message.method === 'tools/list') {
      return respond(200, { jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'echo' }] } });
    }
    if (message.method === 'tools/call') {
      return respond(200, {
        jsonrpc: '2.0',
        id: message.id,
        result: { content: [{ type: 'text', text: 'pong' }] },
      });
    }
    return respond(404, 'not found');
  };
  return { fetchImpl, calls, initialized: () => initialized };
}

beforeEach(() => resetMcpSessionCache());

describe('MCP session handshake', () => {
  test('a stateful server triggers initialize → initialized → replay with the session id', async () => {
    const server = statefulServer();
    const result = await executeCall({
      binding: { kind: 'mcp', tool: 'echo' },
      baseUrl: 'https://stateful-1.example.com/mcp',
      auth: BEARER,
      secret: 'tok',
      args: { q: 'hi' },
      fetchImpl: server.fetchImpl,
    });
    expect(result.ok).toBe(true);
    expect((result.data as any).result.content[0].text).toBe('pong');
    const methods = server.calls.map((c) => JSON.parse(c.body!).method);
    expect(methods).toEqual(['tools/call', 'initialize', 'notifications/initialized', 'tools/call']);
    const init = JSON.parse(server.calls[1]!.body!);
    expect(init.params).toMatchObject({
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'kortix' },
    });
    // The notification carries no id (JSON-RPC notification) and the session.
    expect('id' in JSON.parse(server.calls[2]!.body!)).toBe(false);
    expect(server.calls[2]!.headers['Mcp-Session-Id']).toBe('sess-1');
    // The replay carries the session id, the negotiated protocol version, and auth.
    expect(server.calls[3]!.headers['Mcp-Session-Id']).toBe('sess-1');
    expect(server.calls[3]!.headers['MCP-Protocol-Version']).toBe('2025-06-18');
    expect(server.calls[3]!.headers.Authorization).toBe('Bearer tok');
    expect(server.calls[1]!.headers.Authorization).toBe('Bearer tok');
  });

  test('the session is reused for later calls on the same server and credential', async () => {
    const server = statefulServer({ sessionId: 'sess-2' });
    const call = () =>
      executeCall({
        binding: { kind: 'mcp', tool: 'echo' },
        baseUrl: 'https://stateful-2.example.com/mcp',
        auth: BEARER,
        secret: 'tok',
        fetchImpl: server.fetchImpl,
      });
    await call();
    server.calls.length = 0;
    const second = await call();
    expect(second.ok).toBe(true);
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]!.headers['Mcp-Session-Id']).toBe('sess-2');
    expect(server.initialized()).toBe(1);
    // tools/list shares the same session.
    server.calls.length = 0;
    const tools = await listMcpTools({
      url: 'https://stateful-2.example.com/mcp',
      auth: BEARER,
      secret: 'tok',
      fetchImpl: server.fetchImpl,
    });
    expect(tools.map((t) => t.name)).toEqual(['echo']);
    expect(server.calls).toHaveLength(1);
  });

  test('a different credential never reuses another credential\'s session', async () => {
    const server = statefulServer({ sessionId: 'sess-3' });
    const call = (secret: string) =>
      executeCall({
        binding: { kind: 'mcp', tool: 'echo' },
        baseUrl: 'https://stateful-3.example.com/mcp',
        auth: BEARER,
        secret,
        fetchImpl: server.fetchImpl,
      });
    await call('alice');
    server.calls.length = 0;
    await call('bob');
    expect(server.calls[0]!.headers['Mcp-Session-Id']).toBeUndefined();
    expect(server.initialized()).toBe(2);
  });

  test('a forgotten session (404) is re-established once and the call replayed', async () => {
    const forget = new Set<string>();
    const server = statefulServer({ sessionId: 'sess-4', forget });
    const call = () =>
      executeCall({
        binding: { kind: 'mcp', tool: 'echo' },
        baseUrl: 'https://stateful-4.example.com/mcp',
        fetchImpl: server.fetchImpl,
      });
    await call();
    forget.add('sess-4');
    server.calls.length = 0;
    const result = await call();
    expect(result.ok).toBe(true);
    const methods = server.calls.map((c) => JSON.parse(c.body!).method);
    expect(methods).toEqual(['tools/call', 'initialize', 'notifications/initialized', 'tools/call']);
  });

  test('an authentication failure is returned as-is, no handshake attempted', async () => {
    const calls: Call[] = [];
    const fetchImpl: FetchImpl = async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, body: init.body });
      return { status: 401, ok: false, text: async () => '{"error":"invalid_token"}' };
    };
    const result = await executeCall({
      binding: { kind: 'mcp', tool: 'echo' },
      baseUrl: 'https://stateful-5.example.com/mcp',
      auth: BEARER,
      secret: 'expired',
      fetchImpl,
    });
    expect(result.status).toBe(401);
    expect(calls).toHaveLength(1);
  });

  test('when initialize itself fails, the original error result is returned', async () => {
    const calls: Call[] = [];
    const fetchImpl: FetchImpl = async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, body: init.body });
      return { status: 400, ok: false, text: async () => 'Bad Request' };
    };
    const result = await executeCall({
      binding: { kind: 'mcp', tool: 'echo' },
      baseUrl: 'https://stateful-6.example.com/mcp',
      fetchImpl,
    });
    expect(result.status).toBe(400);
    expect(result.data).toBe('Bad Request');
    expect(calls.map((c) => JSON.parse(c.body!).method)).toEqual(['tools/call', 'initialize']);
  });

  test('a stateless server that accepts the first request is never initialized', async () => {
    const calls: Call[] = [];
    const fetchImpl: FetchImpl = async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, body: init.body });
      return {
        status: 200,
        ok: true,
        text: async () => '{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}',
      };
    };
    await listMcpTools({ url: 'https://stateless-7.example.com/mcp', fetchImpl });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers['Mcp-Session-Id']).toBeUndefined();
  });
});
