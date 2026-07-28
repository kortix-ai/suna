import { describe, expect, test } from 'bun:test';

import { observeRuntimeSessionTitleStream } from '../projects/acp-session-title-stream';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function chunkedStream(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe('observeRuntimeSessionTitleStream', () => {
  test('captures a real ACP session title across split SSE chunks and preserves the stream', async () => {
    const raw =
      'id: 7\n' +
      'data: {"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"ses_1","update":{"sessionUpdate":"session_info_update","title":"Research Marko Kraemer"}}}\n\n';
    const titles: string[] = [];

    const observed = observeRuntimeSessionTitleStream(
      chunkedStream([raw.slice(0, 31), raw.slice(31, 79), raw.slice(79)]),
      {
        protocol: 'acp',
        expectedSessionId: 'ses_1',
        onTitle: async (event) => {
          titles.push(event.title);
        },
      },
    );

    expect(decoder.decode(await new Response(observed).arrayBuffer())).toBe(raw);
    expect(titles).toEqual(['Research Marko Kraemer']);
  });

  test('ignores placeholders, other sessions, and non-title updates', async () => {
    const envelopes = [
      {
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'ses_1',
          update: {
            sessionUpdate: 'session_info_update',
            title: 'New session - 2026-07-28',
          },
        },
      },
      {
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'ses_other',
          update: {
            sessionUpdate: 'session_info_update',
            title: 'Wrong session',
          },
        },
      },
      {
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'ses_1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Hi' },
          },
        },
      },
    ];
    const raw = envelopes
      .map((envelope, index) => `id: ${index + 1}\ndata: ${JSON.stringify(envelope)}\n\n`)
      .join('');
    const titles: string[] = [];

    const observed = observeRuntimeSessionTitleStream(chunkedStream([raw]), {
      protocol: 'acp',
      expectedSessionId: 'ses_1',
      onTitle: async (event) => {
        titles.push(event.title);
      },
    });

    expect(decoder.decode(await new Response(observed).arrayBuffer())).toBe(raw);
    expect(titles).toEqual([]);
  });

  test('captures an OpenCode REST session.updated title for the pinned root', async () => {
    const raw =
      'data: {"directory":"/workspace","payload":{"type":"session.updated","properties":{"id":"ses_root","title":"REST title"}}}\n\n';
    const events: Array<{ sessionId: string; title: string }> = [];

    const observed = observeRuntimeSessionTitleStream(chunkedStream([raw]), {
      protocol: 'rest',
      expectedSessionId: 'ses_root',
      onTitle: async (event) => {
        events.push(event);
      },
    });

    expect(decoder.decode(await new Response(observed).arrayBuffer())).toBe(raw);
    expect(events).toEqual([{ sessionId: 'ses_root', title: 'REST title' }]);
  });
});
