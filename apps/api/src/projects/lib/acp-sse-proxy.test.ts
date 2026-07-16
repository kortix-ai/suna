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
          blocks.push(`${block.id}:${block.data.join('\n')}`);
        },
      });
      const reader = proxy.getReader();
      const first = await reader.read();
      expect(first.done).toBe(false);
      await reader.cancel(new Error('test client closed'));
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(upstreamCancelled).toBe(true);
      expect(blocks).toEqual(['1:{"ok":true}']);
      expect(warnings).toEqual([]);
    } finally {
      console.warn = originalWarn;
    }
  });

  // --- Rule 2: the client-facing tee is a byte-level passthrough. -----------
  test('the client-facing tee forwards input bytes unchanged, including CR bytes the persistence side normalizes away', async () => {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const raw = 'id: 1\r\ndata: {"a":1}\r\n\r\nid: 2\r\ndata: {"a":2}\r\n\r\n';
    const inputBytes = encoder.encode(raw);
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(inputBytes);
        controller.close();
      },
    });

    const proxy = createPersistedSseProxy(upstream, {
      sessionId: 'session-passthrough',
      persistBlock: async () => {},
    });

    const reader = proxy.getReader();
    const outChunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (value) outChunks.push(value);
      if (done) break;
    }

    const outBytes = new Uint8Array(outChunks.reduce((n, c) => n + c.length, 0));
    let offset = 0;
    for (const chunk of outChunks) {
      outBytes.set(chunk, offset);
      offset += chunk.length;
    }

    expect(outBytes).toEqual(inputBytes);
    expect(decoder.decode(outBytes)).toBe(raw);
  });

  // --- Rule 3: persistence stays idempotence-delegating, not self-deduping. -
  test('a duplicate block on the wire is forwarded to persistBlock twice, unchanged and in order — dedup is the DB layer\'s job, not the proxy\'s', async () => {
    const encoder = new TextEncoder();
    const persisted: Array<{ id: number | null; data: string[] }> = [];
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('id: 7\ndata: {"a":1}\n\nid: 7\ndata: {"a":1}\n\n'));
        controller.close();
      },
    });

    const proxy = createPersistedSseProxy(upstream, {
      sessionId: 'session-dup',
      persistBlock: async (block) => {
        persisted.push(block);
      },
    });

    const reader = proxy.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }

    expect(persisted).toEqual([
      { id: 7, data: ['{"a":1}'] },
      { id: 7, data: ['{"a":1}'] },
    ]);
  });

  // --- Rule 1: the CRLF adjudication. ----------------------------------------
  // The OLD hand-rolled splitter looked for a literal '\n\n' boundary and did
  // its CR-stripping (`.replace(/\r/g, '')`) only AFTER finding one. A stream
  // terminated purely by '\r\n\r\n' (CRLF CRLF — valid per the SSE spec, and
  // what a CR-normalizing intermediary could produce even though this repo's
  // own sandbox daemon at apps/kortix-sandbox-agent-server/src/routes/acp.ts
  // only ever emits bare '\n\n') contains NO literal '\n\n' substring at all
  // ('\r\n\r\n' has no two adjacent '\n' characters), so the old splitter
  // never found a mid-stream boundary. Every event piled into one buffer
  // until stream end, where a single synthetic '\n\n' was appended and the
  // ENTIRE run was persisted as one merged "block" — multiple `id:`/`data:`
  // pairs glued together. `persistSseBlock` (apps/api/src/projects/routes/acp.ts)
  // then joined every `data:` line from every event with '\n' and called
  // `JSON.parse` once, which threw on the concatenated multi-object payload —
  // so EVERY event in that run was silently dropped (caught, `console.warn`,
  // no row written), while the byte-level tee to the browser stayed correct.
  //
  // Empirically verified against the pre-swap `acp-sse-proxy.ts` (git blob
  // 9073b595380b3ba7e9c93c1465e700a909900a3f, see the report) with this exact
  // fixture:
  //   BLOCKS: ["id: 1\ndata: {\"a\":1}\n\nid: 2\ndata: {\"a\":2}\n"]
  // — one merged block, not two — confirming the defect, not just reasoning
  // about the code. This is a bug FIX, not a pure refactor: the persisted-log
  // implication for any historical CRLF-framed run is "zero rows for that
  // block window", which the reducer's dedupe/ordinal backstops
  // (`packages/sdk/src/acp/reduce.ts` dedupeKey `${direction}:${streamEventId}`,
  // openRequestOrdinals) do not need to paper over, because there is nothing
  // malformed left behind to tolerate — the rows simply never existed.
  test('a CRLF-terminated stream now frames as two distinct deliverable blocks, not one merged/dropped block', async () => {
    const encoder = new TextEncoder();
    const persisted: Array<{ id: number | null; data: string[] }> = [];
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode('id: 1\r\ndata: {"a":1}\r\n\r\nid: 2\r\ndata: {"a":2}\r\n\r\n'),
        );
        controller.close();
      },
    });

    const proxy = createPersistedSseProxy(upstream, {
      sessionId: 'session-crlf',
      persistBlock: async (block) => {
        persisted.push(block);
      },
    });

    const reader = proxy.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }

    expect(persisted).toEqual([
      { id: 1, data: ['{"a":1}'] },
      { id: 2, data: ['{"a":2}'] },
    ]);
  });

  test('a CRLF terminator split across two upstream chunks, mid-terminator, still frames both blocks (CR-holdback parity with the client parser)', async () => {
    const encoder = new TextEncoder();
    const persisted: Array<{ id: number | null; data: string[] }> = [];
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Split lands between the first CRLF and the second CR of the
        // terminator's four characters — the exact case sse-core.ts's own
        // holdback test covers, and the case the old splitter could never
        // even try to handle (it never recognized '\r\n\r\n' as a boundary
        // at all, see the test above).
        controller.enqueue(encoder.encode('id: 1\r\ndata: {"a":1}\r'));
        controller.enqueue(encoder.encode('\n\r\nid: 2\r\ndata: {"a":2}\r\n\r\n'));
        controller.close();
      },
    });

    const proxy = createPersistedSseProxy(upstream, {
      sessionId: 'session-crlf-split',
      persistBlock: async (block) => {
        persisted.push(block);
      },
    });

    const reader = proxy.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }

    expect(persisted).toEqual([
      { id: 1, data: ['{"a":1}'] },
      { id: 2, data: ['{"a":2}'] },
    ]);
  });

  test('non-deliverable blocks (keepalive comments, id-less blocks) are never handed to persistBlock', async () => {
    const encoder = new TextEncoder();
    const persisted: Array<{ id: number | null; data: string[] }> = [];
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(': keepalive\n\nid: 1\ndata: {"a":1}\n\n'));
        controller.close();
      },
    });

    const proxy = createPersistedSseProxy(upstream, {
      sessionId: 'session-keepalive',
      persistBlock: async (block) => {
        persisted.push(block);
      },
    });

    const reader = proxy.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }

    expect(persisted).toEqual([{ id: 1, data: ['{"a":1}'] }]);
  });
});
