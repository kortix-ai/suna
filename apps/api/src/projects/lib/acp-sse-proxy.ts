import { createSseBlockParser, isDeliverableSseBlock, type SseBlock } from '@kortix/sdk/acp';

export type PersistedSseProxyOptions = {
  sessionId: string;
  persistBlock: (block: { id: number; data: string[] }) => Promise<void>;
};

export function createPersistedSseProxy(
  body: ReadableStream<Uint8Array>,
  options: PersistedSseProxyOptions,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const parser = createSseBlockParser();
  let clientCancelled = false;

  const isExpectedClose = (error: unknown) => {
    if (clientCancelled) return true;
    const name = (error as { name?: string } | null | undefined)?.name;
    if (name === 'AbortError') return true;
    const message = error instanceof Error ? error.message : String(error);
    return /controller is already closed|stream is closed|cancel/i.test(message);
  };

  const persistParsedBlocks = async (chunk: Uint8Array | undefined, done: boolean) => {
    const blocks: SseBlock[] = parser.push(chunk, done);
    for (const block of blocks) {
      if (isDeliverableSseBlock(block)) {
        await options.persistBlock(block);
      }
    }
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (value) {
            try {
              controller.enqueue(value);
            } catch (error) {
              if (isExpectedClose(error)) return;
              throw error;
            }
            await persistParsedBlocks(value, false);
          }
          if (done) {
            await persistParsedBlocks(undefined, true);
            try {
              controller.close();
            } catch (error) {
              if (!isExpectedClose(error)) throw error;
            }
            return;
          }
        }
      } catch (error) {
        if (isExpectedClose(error)) return;
        console.warn(`[acp] SSE proxy stopped for ${options.sessionId}:`, error);
        try {
          controller.error(error);
        } catch {}
      }
    },
    async cancel(reason) {
      clientCancelled = true;
      await reader.cancel(reason ?? new Error('ACP SSE client closed')).catch((error) => {
        if (!isExpectedClose(error)) {
          console.warn(`[acp] failed to cancel upstream SSE for ${options.sessionId}:`, error);
        }
      });
    },
  });
}
