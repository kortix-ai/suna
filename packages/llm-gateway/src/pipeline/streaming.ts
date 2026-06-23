import { type ExtractedUsage, extractUsageFromSseBuffer } from '../usage';

export interface StreamRelayOptions {
  upstreamBody: ReadableStream<Uint8Array>;
  captureBodies: boolean;
  requestId: string;
  logger: { warn: (...args: unknown[]) => void };
  settle: (usage: ExtractedUsage | null, response: unknown) => Promise<void>;
  /** Keep-alive interval in ms (overridable for tests). */
  heartbeatMs?: number;
}

// How long upstream may go silent before we emit a keep-alive. A reasoning model
// (or a slow first token) can pause longer than the socket idle timeouts on the
// gateway, the API reverse proxy, AND opencode — any of which would otherwise
// drop the connection and surface to opencode as "Connection reset by server".
const HEARTBEAT_MS = 10_000;
// SSE comment line — ignored by every SSE/OpenAI client, so it's invisible
// payload that just resets each hop's idle timer.
const HEARTBEAT_FRAME = new TextEncoder().encode(': keep-alive\n\n');

export function relayStream(opts: StreamRelayOptions): ReadableStream<Uint8Array> {
  const { upstreamBody, captureBodies, requestId, logger, settle } = opts;
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const transform = new TransformStream<Uint8Array, Uint8Array>();
  const writer = transform.writable.getWriter();
  const decoder = new TextDecoder();
  let sseBuffer = '';

  void (async () => {
    const reader = upstreamBody.getReader();
    let downstreamAlive = true;
    // Keep exactly one read in flight; race it against a heartbeat timer so a
    // long token gap emits a keep-alive without ever issuing a second read.
    let pending = reader.read();
    try {
      while (true) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const beat = new Promise<'beat'>((resolve) => {
          timer = setTimeout(() => resolve('beat'), heartbeatMs);
        });
        const next = await Promise.race([pending.then((r) => ({ read: r })), beat]);
        if (timer) clearTimeout(timer);

        if (next === 'beat') {
          // Upstream silent for HEARTBEAT_MS. Inject the comment only at an SSE
          // event boundary (buffer empty, or ends with the \n\n terminator) so we
          // never split a partial event mid-flight. `pending` stays in flight.
          if (downstreamAlive && (sseBuffer === '' || sseBuffer.endsWith('\n\n'))) {
            try {
              await writer.write(HEARTBEAT_FRAME);
            } catch {
              downstreamAlive = false;
            }
          }
          continue;
        }

        const { done, value } = next.read;
        if (done) break;
        pending = reader.read();
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
