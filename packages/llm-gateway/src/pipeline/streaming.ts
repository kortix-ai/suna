import { type ExtractedUsage, IncrementalSseScanner, type SseErrorFrame } from '../usage';

export interface StreamRelayOptions {
  upstreamBody: ReadableStream<Uint8Array>;
  requestId: string;
  logger: { warn: (...args: unknown[]) => void; debug?: (...args: unknown[]) => void };
  settle: (usage: ExtractedUsage | null, streamError?: SseErrorFrame | null) => Promise<void>;
  signal?: AbortSignal;
  heartbeatMs?: number;
  inactivityTimeoutMs?: number;
}

const HEARTBEAT = new TextEncoder().encode(': keep-alive\n\n');
const DEFAULT_HEARTBEAT_MS = 10_000;
const DEFAULT_INACTIVITY_MS = 90 * 60_000;

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

/** Relays one provider stream without retaining the response body. */
export function relayStream(options: StreamRelayOptions): ReadableStream<Uint8Array> {
  const reader = options.upstreamBody.getReader();
  const scanner = new IncrementalSseScanner();
  const decoder = new TextDecoder();
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const inactivityMs = options.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_MS;
  let lastByteAt = Date.now();
  let tail = '';
  let settled = false;
  let pendingRead: ReturnType<typeof reader.read> | null = null;

  const settle = async (error: SseErrorFrame | null = null): Promise<void> => {
    if (settled) return;
    settled = true;
    try {
      await options.settle(scanner.usage, error ?? scanner.error);
    } catch (settlementError) {
      options.logger.warn('[gateway] usage settlement failed', settlementError);
    }
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (options.signal?.aborted) {
        await reader.cancel('client aborted').catch(() => undefined);
        await settle({ message: 'client aborted', code: 'client_aborted' });
        controller.close();
        return;
      }

      let timer: ReturnType<typeof setTimeout> | undefined;
      pendingRead ??= reader.read();
      const currentRead = pendingRead;
      const read = currentRead.then((value) => ({ kind: 'read' as const, value }));
      const beat = new Promise<{ kind: 'beat' }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'beat' }), heartbeatMs);
      });

      try {
        const next = await Promise.race([read, beat]);
        if (timer) clearTimeout(timer);
        if (next.kind === 'beat') {
          if (Date.now() - lastByteAt >= inactivityMs) {
            await reader.cancel('provider inactivity timeout').catch(() => undefined);
            const error = {
              message: `provider sent no bytes for ${inactivityMs}ms`,
              code: 'upstream_inactivity_timeout',
            };
            await settle(error);
            controller.error(new Error(error.message));
            return;
          }
          if (!tail || tail.endsWith('\n\n')) controller.enqueue(HEARTBEAT);
          return;
        }

        const { done, value } = next.value;
        pendingRead = null;
        if (done) {
          await settle();
          controller.close();
          return;
        }
        if (!value) return;
        lastByteAt = Date.now();
        const text = decoder.decode(value, { stream: true });
        scanner.push(text);
        tail = (tail + text).slice(-2);
        controller.enqueue(value);
      } catch (error) {
        if (timer) clearTimeout(timer);
        const streamError = { message: messageOf(error), code: 'upstream_stream_error' };
        await settle(streamError);
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
      await settle({ message: 'client cancelled response', code: 'client_aborted' });
    },
  });
}
