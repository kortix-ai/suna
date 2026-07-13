import { describe, expect, test } from 'bun:test';

import { createAcpClient } from './client';
import { acpTranscriptJsonl, acpTranscriptMarkdown } from './transcript';

describe('ACP client', () => {
  test('preserves raw JSON-RPC for initialize, session/new, and prompt', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ url: String(input), body });
      const method = body.method;
      const result = method === 'session/new'
        ? { sessionId: 'acp-session-1' }
        : method === 'session/prompt' ? { stopReason: 'end_turn' } : { protocolVersion: 1 };
      return Response.json({ jsonrpc: '2.0', id: body.id, result });
    };
    const client = createAcpClient({
      baseUrl: 'https://runtime.test/',
      serverId: 'server one',
      fetch: fakeFetch as typeof fetch,
    });

    await client.initialize({ protocolVersion: 1, clientInfo: { name: 'test', version: '1' } });
    const session = await client.newSession({ cwd: '/workspace' });
    const result = await client.prompt(session.sessionId, [{ type: 'text', text: 'hello' }]);

    expect(calls.map((call) => call.url)).toEqual([
      'https://runtime.test/acp/server%20one',
      'https://runtime.test/acp/server%20one',
      'https://runtime.test/acp/server%20one',
    ]);
    expect(calls.map((call) => call.body.method)).toEqual(['initialize', 'session/new', 'session/prompt']);
    expect(result.stopReason).toBe('end_turn');
  });

  test('streams SSE envelopes and exposes lossless transcript projections', async () => {
    const sse = [
      ': connected',
      '',
      'id: 1',
      'data: {"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Hello"}}}}',
      '',
    ].join('\n');
    const fakeFetch = async () => new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } });
    const client = createAcpClient({ baseUrl: 'https://runtime.test', serverId: 's1', fetch: fakeFetch as unknown as typeof fetch });
    const events: any[] = [];
    await new Promise<void>((resolve) => {
      client.connect({
        reconnect: false,
        onEvent(event) {
          events.push(event);
          resolve();
        },
      });
    });

    expect(events[0].id).toBe(1);
    expect(acpTranscriptJsonl(events)).toContain('"sequence":1');
    expect(acpTranscriptMarkdown(events)).toContain('Hello');
  });

  test('polls the durable ACP transcript automatically on React Native', async () => {
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { product: 'ReactNative' },
    });
    const calls: string[] = [];
    const fakeFetch = async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return Response.json({
        runtime_id: 'runtime-1',
        envelopes: [{
          ordinal: 7,
          direction: 'agent_to_client',
          streamEventId: 3,
          envelope: {
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'Mobile hello' },
              },
            },
          },
          createdAt: '2026-07-13T00:00:00.000Z',
        }],
      });
    };
    try {
      const client = createAcpClient({
        endpoint: 'https://api.test/projects/p/sessions/s/acp',
        fetch: fakeFetch as unknown as typeof fetch,
      });

      const event = await new Promise<any>((resolve) => {
        const stream = client.connect({
          onEvent(next) {
            stream.close();
            resolve(next);
          },
        });
      });

      expect(calls).toEqual([
        'https://api.test/projects/p/sessions/s/acp/transcript',
      ]);
      expect(event.id).toBe(3);
      expect(event.envelope.params.update.content.text).toBe('Mobile hello');
    } finally {
      if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
      else delete (globalThis as { navigator?: unknown }).navigator;
    }
  });
});
