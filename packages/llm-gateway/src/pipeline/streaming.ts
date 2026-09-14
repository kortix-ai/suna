import { type ExtractedUsage, IncrementalSseScanner, type SseErrorFrame } from '../usage';

export interface StreamRelayOptions {
  upstreamBody: ReadableStream<Uint8Array>;
  requestId: string;
  logger: {
    warn: (...args: unknown[]) => void;
    // Required: a failed usage settlement is unrecorded revenue and must be
    // alertable, not a warn line (see `settle` below).
    error: (...args: unknown[]) => void;
    debug?: (...args: unknown[]) => void;
  };
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
      // A settlement failure means REVENUE WAS NOT RECORDED for a turn that
      // has already been served. It cannot be thrown (the response bytes are
      // long gone) and it must not be whispered.
      //
      // This used to be a plain `logger.warn`, and that is how a drained
      // account's spend disappeared for an entire billing period without a
      // single alert: the wallet floor let the turn run, `atomic_use_credits`
      // then refused the debit, and the only trace was one warn line nobody
      // was aggregating. `error` level so it is alertable, and the account is
      // named so the lost amount is chaseable.
      //
      // The durable half of this fix lives in the API hook
      // (recordGatewayUsage): an unsettled usage_events row is left with
      // `settled_at IS NULL` and retried by the settlement sweeper, so the
      // debt survives this catch rather than depending on it.
      options.logger.error('[gateway] usage settlement failed — spend not recorded', {
        error: settlementError instanceof Error ? settlementError.message : String(settlementError),
        requestId: options.requestId,
      });
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
          // Flush the decoder and the scanner's carry: a provider whose last
          // line has no trailing newline keeps its usage frame in the carry,
          // and without this that turn is billed as zero tokens.
          const trailing = decoder.decode();
          if (trailing) scanner.push(trailing);
          scanner.finish();
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
