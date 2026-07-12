import { describe, expect, test } from 'bun:test';

import { createPersistedSseProxy } from './acp-sse-proxy';

describe('createPersistedSseProxy', () => {
  test('persists SSE blocks while treating client cancellation as a normal close', async () => {
    const encoder = new TextEncoder();
    const blocks: string[] = [];
    let upstreamCancelled = false;
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };

    try {
      const upstream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('id: 1\ndata: {"ok":true}\n\n'));
          setTimeout(() => {
            try {
              controller.enqueue(encoder.encode('id: 2\ndata: {"late":true}\n\n'));
              controller.close();
            } catch {}
          }, 10);
        },
        cancel() {
          upstreamCancelled = true;
        },
      });

      const proxy = createPersistedSseProxy(upstream, {
        sessionId: 'session-1',
        persistBlock: async (block) => {
          blocks.push(block);
        },
      });
      const reader = proxy.getReader();
      const first = await reader.read();
      expect(first.done).toBe(false);
      await reader.cancel(new Error('test client closed'));
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(upstreamCancelled).toBe(true);
      expect(blocks).toEqual(['id: 1\ndata: {"ok":true}']);
      expect(warnings).toEqual([]);
    } finally {
      console.warn = originalWarn;
    }
  });
});
