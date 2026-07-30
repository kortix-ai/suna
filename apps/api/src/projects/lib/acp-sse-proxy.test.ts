import { expect, test } from 'bun:test';

import { createPersistedAcpSseProxy } from './acp-sse-proxy';

test('replays stored envelopes and rewrites live upstream ids to durable ordinals', async () => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          'id: 0\ndata: {"jsonrpc":"2.0","method":"kortix/cursor"}\n\n' +
            'id: 17\ndata: {"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"native-1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"live"}}}}\n\n',
        ),
      );
      controller.close();
    },
  });
  const persisted: unknown[] = [];

  const proxy = createPersistedAcpSseProxy(upstream, {
    afterOrdinal: 3,
    replay: async () => [
      {
        ordinal: 4,
        envelope: {
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'native-1',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'stored' },
            },
          },
        },
      },
    ],
    persist: async (eventId, envelope) => {
      persisted.push({ eventId, envelope });
      return { ordinal: 5, envelope };
    },
  });

  const chunks: Uint8Array[] = [];
  const reader = proxy.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (value) chunks.push(value);
    if (done) break;
  }
  const output = decoder.decode(Buffer.concat(chunks));

  expect(output).toContain('id: 4\ndata: {"jsonrpc":"2.0","method":"session/update"');
  expect(output).toContain('id: 4\ndata: {"jsonrpc":"2.0","method":"kortix/cursor"}');
  expect(output).toContain('id: 5\ndata: {"jsonrpc":"2.0","method":"session/update"');
  expect(persisted).toEqual([
    {
      eventId: 17,
      envelope: expect.objectContaining({ method: 'session/update' }),
    },
  ]);
});

test('suppresses a replayed upstream event that already exists in the durable log', async () => {
  const encoder = new TextEncoder();
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode('id: 17\ndata: {"jsonrpc":"2.0","method":"session/update","params":{}}\n\n'),
      );
      controller.close();
    },
  });

  const proxy = createPersistedAcpSseProxy(upstream, {
    afterOrdinal: 9,
    replay: async () => [],
    persist: async (_eventId, envelope) => ({ ordinal: 7, envelope }),
  });
  const output = await new Response(proxy).text();

  expect(output).toBe('id: 9\ndata: {"jsonrpc":"2.0","method":"kortix/cursor"}\n\n');
});
