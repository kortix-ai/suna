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
  /**
   * Called exactly once when the stream ends, however it ends. `observed`
   * carries what the relay saw of the output, so a stream that ended before
   * its usage frame can still be settled (see usage/estimate.ts).
   */
  settle: (
    usage: ExtractedUsage | null,
    streamError?: SseErrorFrame | null,
    observed?: StreamObservation,
  ) => Promise<void>;
  signal?: AbortSignal;
  heartbeatMs?: number;
  inactivityTimeoutMs?: number;
  /** Rewrites complete relayed lines. Usage and error scanning read the upstream text. */
  rewriteLines?: (text: string) => string;
}

export interface StreamObservation {
  /** Generated output characters the provider streamed before the end. */
  outputChars: number;
  /** The client stopped reading (Stop, abort, closed socket). */
  clientStopped: boolean;
}

const HEARTBEAT = new TextEncoder().encode(': keep-alive\n\n');
const DEFAULT_HEARTBEAT_MS = 10_000;
const DEFAULT_INACTIVITY_MS = 90 * 60_000;

function completeJsonDataLine(line: string): boolean {
  if (!line.startsWith('data:')) return false;
  const payload = line.slice(5).trim();
  if (payload === '[DONE]') return true;
  if (!payload.startsWith('{') || !payload.endsWith('}')) return false;
  try {
    const value: unknown = JSON.parse(payload);
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  } catch {
    return false;
  }
}

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
  // Upstream text after the last newline, held back until its line completes.
  let carry = '';
  let previousDataLineEnding = '';
  let framingRepairLogged = false;
  const encoder = new TextEncoder();
  const relay = (controller: ReadableStreamDefaultController<Uint8Array>, text: string): boolean => {
    const buffered = carry + text;
    const cut = buffered.lastIndexOf('\n') + 1;
    carry = buffered.slice(cut);
    if (cut === 0) return false;
    const lines = buffered.slice(0, cut);
    let output = '';
    let start = 0;
    for (let end = lines.indexOf('\n'); end >= 0; end = lines.indexOf('\n', start)) {
      const line = lines.slice(start, end + 1);
      const complete = completeJsonDataLine(line);
      if (complete && previousDataLineEnding) {
        // OpenAI chat-completion chunks are independent SSE events. Some
        // providers send consecutive complete `data:` JSON lines without the
        // blank line that dispatches the first event. EventSourceParser then
        // joins them with a newline and JSON.parse rejects the whole event.
        output += previousDataLineEnding;
        if (!framingRepairLogged) {
          options.logger.warn('[gateway] repaired missing SSE event boundary', { requestId: options.requestId });
          framingRepairLogged = true;
        }
      }
      output += line;
      if (complete) previousDataLineEnding = line.endsWith('\r\n') ? '\r\n' : '\n';
      else if (line === '\n' || line === '\r\n' || line.startsWith('data:')) previousDataLineEnding = '';
      start = end + 1;
    }
    controller.enqueue(encoder.encode(options.rewriteLines ? options.rewriteLines(output) : output));
    tail = (tail + output).slice(-2);
    return true;
  };
  const flushCarry = (controller: ReadableStreamDefaultController<Uint8Array>): void => {
    if (!carry) {
      if (previousDataLineEnding) {
        controller.enqueue(encoder.encode(previousDataLineEnding));
        if (!framingRepairLogged) {
          options.logger.warn('[gateway] repaired missing SSE event boundary', { requestId: options.requestId });
          framingRepairLogged = true;
        }
        previousDataLineEnding = '';
      }
      return;
    }
    const complete = completeJsonDataLine(carry);
    const repairedBoundary = complete && Boolean(previousDataLineEnding);
    // EventSourceParser does not dispatch an unterminated final event. A
    // complete OpenAI chunk at EOF needs the same blank line as every other
    // event, including when the provider omitted its final newline entirely.
    const output = (repairedBoundary ? previousDataLineEnding : '') + carry + (complete ? '\n\n' : '');
    if (complete && !framingRepairLogged) {
      options.logger.warn('[gateway] repaired missing SSE event boundary', { requestId: options.requestId });
      framingRepairLogged = true;
    }
    controller.enqueue(encoder.encode(options.rewriteLines ? options.rewriteLines(output) : output));
    tail = (tail + output).slice(-2);
    carry = '';
    previousDataLineEnding = '';
  };
  let settled = false;
  let pendingRead: ReturnType<typeof reader.read> | null = null;
  // Set the moment the client goes away, BEFORE the provider read is
  // cancelled: cancelling resolves the pending read as `done`, and that branch
  // must settle as a client stop, not as a clean end of stream.
  let clientStop: SseErrorFrame | null = null;

  const settle = async (error: SseErrorFrame | null = null): Promise<void> => {
    if (settled) return;
    settled = true;
    try {
      await options.settle(scanner.usage, error ?? scanner.error, {
        outputChars: scanner.outputChars,
        clientStopped: error?.code === 'client_aborted',
      });
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
      // No sweeper retries it: the API client retries a refused or 5xx-answered
      // settlement (idempotent per request id), and this line is what is left
      // when those retries are exhausted.
      options.logger.error('[gateway] usage settlement failed — spend not recorded', {
        error: settlementError instanceof Error ? settlementError.message : String(settlementError),
        requestId: options.requestId,
      });
    }
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        for (;;) {
          if (options.signal?.aborted) {
            clientStop ??= { message: 'client aborted', code: 'client_aborted' };
            await reader.cancel('client aborted').catch(() => undefined);
            await settle(clientStop);
            controller.close();
            return;
          }
          pendingRead ??= reader.read();
          const currentRead = pendingRead;
          const read = currentRead.then((value) => ({ kind: 'read' as const, value }));
          const beat = new Promise<{ kind: 'beat' }>((resolve) => {
            timer = setTimeout(() => resolve({ kind: 'beat' }), heartbeatMs);
          });

          const next = await Promise.race([read, beat]);
          if (timer) clearTimeout(timer);
          timer = undefined;
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
            if (!tail || tail.endsWith('\n\n')) {
              controller.enqueue(HEARTBEAT);
              return;
            }
            continue;
          }

          const { done, value } = next.value;
          pendingRead = null;
          if (done) {
            // Flush the decoder and scanner's carry before settling usage.
            const trailing = decoder.decode();
            if (trailing) {
              scanner.push(trailing);
              relay(controller, trailing);
            }
            flushCarry(controller);
            scanner.finish();
            await settle(clientStop);
            controller.close();
            return;
          }
          if (!value) continue;
          lastByteAt = Date.now();
          const text = decoder.decode(value, { stream: true });
          scanner.push(text);
          if (relay(controller, text)) return;
        }
      } catch (error) {
        if (timer) clearTimeout(timer);
        const streamError = { message: messageOf(error), code: 'upstream_stream_error' };
        await settle(streamError);
        controller.error(error);
      }
    },
    async cancel(reason) {
      clientStop ??= { message: 'client cancelled response', code: 'client_aborted' };
      await reader.cancel(reason).catch(() => undefined);
      await settle(clientStop);
    },
  });
}
