import { type ExtractedUsage, extractUsageFromSseBuffer } from '../usage';

export interface StreamRelayOptions {
  upstreamBody: ReadableStream<Uint8Array>;
  captureBodies: boolean;
  requestId: string;
  logger: { warn: (...args: unknown[]) => void };
  settle: (usage: ExtractedUsage | null, response: unknown) => Promise<void>;
}

export function relayStream(opts: StreamRelayOptions): ReadableStream<Uint8Array> {
  const { upstreamBody, captureBodies, requestId, logger, settle } = opts;
  const transform = new TransformStream<Uint8Array, Uint8Array>();
  const writer = transform.writable.getWriter();
  const decoder = new TextDecoder();
  let sseBuffer = '';

  void (async () => {
    const reader = upstreamBody.getReader();
    let downstreamAlive = true;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        sseBuffer += decoder.decode(value, { stream: true });
        if (downstreamAlive) {
          try {
            await writer.write(value);
          } catch {
            downstreamAlive = false;
          }
        }
      }
    } catch (err) {
      logger.warn(`[llm-gateway] stream read error ${requestId}:`, err);
    } finally {
      try {
        await writer.close();
      } catch {
        // writer already closed / downstream gone — nothing to do here.
      }
      await settle(extractUsageFromSseBuffer(sseBuffer), captureBodies ? sseBuffer : null);
    }
  })();

  return transform.readable;
}
