import { type ExtractedUsage, IncrementalSseScanner, type SseErrorFrame } from '../usage';

export interface StreamRelayOptions {
  upstreamBody: ReadableStream<Uint8Array>;
  requestId: string;
  upstreamProvider?: string;
  upstreamModel?: string;
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
  /**
   * Re-dispatches the SAME logical request to a fresh upstream candidate
   * (next pooled key/endpoint, or the same one again) after the current
   * upstream ended without ever telling us why — no `finish_reason`, no
   * `[DONE]`, and no in-band error frame. Only ever consulted while
   * `bytesForwarded === 0`, i.e. nothing has reached the client yet, which is
   * what makes the retry transparent. Returns the new upstream body, or
   * `null`/rejects when no further candidate exists — either ends the
   * transparent-retry attempt and falls through to the explicit terminal
   * error frame.
   */
  redispatch?: () => Promise<ReadableStream<Uint8Array> | null>;
  /** Extra attempts beyond the first, bounded. Default 2. */
  maxRedispatchAttempts?: number;
  /** Backoff before each redispatch attempt, indexed by attempt number (1-based, clamped to the last entry). */
  redispatchDelaysMs?: number[];
  /** Injectable for tests. Defaults to a real `setTimeout`-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Is this genuinely an SSE completion stream (an upstream 2xx that agreed
   * to stream)? Default `true`. The caller must pass `false` for a non-2xx
   * upstream whose "body" is an arbitrary error payload, not `data:` framed
   * SSE — completion/terminal-marker detection and transparent retry both
   * assume SSE framing and must never reinterpret or drop bytes from an
   * ordinary error body a client is going to read as plain text/JSON. In that
   * mode the relay still repairs SSE event boundaries (harmless on non-SSE
   * text) but never classifies "no finish_reason seen" as incomplete.
   */
  treatAsSse?: boolean;
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
const DEFAULT_MAX_REDISPATCH_ATTEMPTS = 2;
const DEFAULT_REDISPATCH_DELAYS_MS = [250, 750];
// The relay must hold an incomplete line to decide whether the next complete
// JSON chunk needs an event boundary. Bound that hold for a provider that never
// sends a newline; an 8 MiB single SSE line is already outside normal model
// output and cannot be safely rewritten for a managed model.
const MAX_SSE_LINE_CHARS = 8 * 1024 * 1024;

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

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Well-formed OpenAI-compat terminal frame for a stream that ended without
 * ever saying why. `type` mirrors `code` — OpenAI-shaped clients read
 * `error.type`, Anthropic-shaped clients (via the ingress translation, which
 * reads this exact `error.code`/`.message` pair) read `error.code` — so both
 * classify it the same way: a well-formed, retryable upstream failure, never
 * a parse error and never a silent stop.
 */
function incompleteStreamFrame(encoder: TextEncoder, reason: SseErrorFrame): Uint8Array {
  const body = { error: { message: reason.message, code: reason.code, type: reason.code } };
  return encoder.encode(`data: ${JSON.stringify(body)}\n\ndata: [DONE]\n\n`);
}

/** Relays one provider stream without retaining the response body. */
export function relayStream(options: StreamRelayOptions): ReadableStream<Uint8Array> {
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const inactivityMs = options.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_MS;
  const treatAsSse = options.treatAsSse ?? true;
  const maxRedispatchAttempts = Math.max(0, options.maxRedispatchAttempts ?? DEFAULT_MAX_REDISPATCH_ATTEMPTS);
  const redispatchDelaysMs = options.redispatchDelaysMs ?? DEFAULT_REDISPATCH_DELAYS_MS;
  const sleep = options.sleep ?? realSleep;
  const encoder = new TextEncoder();
  const startedAtMs = Date.now();

  let reader = options.upstreamBody.getReader();
  let scanner = new IncrementalSseScanner();
  let decoder = new TextDecoder();
  let lastByteAt = Date.now();
  let tail = '';
  // Upstream text after the last newline, held back until its line completes.
  let carry = '';
  let previousDataLineEnding = '';
  let framingRepairLogged = false;
  // Real content bytes enqueued so far (never counts the synthetic
  // heartbeat). Zero means nothing has reached the client yet, which is what
  // makes a transparent retry safe.
  let bytesForwarded = 0;
  let redispatchAttempts = 0;
  let settled = false;
  let pendingRead: ReturnType<typeof reader.read> | null = null;
  // Set the moment the client goes away, BEFORE the provider read is
  // cancelled: cancelling resolves the pending read as `done`, and that branch
  // must settle as a client stop, not as a clean end of stream.
  let clientStop: SseErrorFrame | null = null;

  const reportFramingRepair = (): void => {
    if (framingRepairLogged) return;
    framingRepairLogged = true;
    options.logger.warn('[gateway] repaired missing SSE event boundary', {
      event: 'gateway.sse_framing_repaired',
      requestId: options.requestId,
      provider: options.upstreamProvider,
      model: options.upstreamModel,
    });
  };
  const emit = (controller: ReadableStreamDefaultController<Uint8Array>, text: string): void => {
    const bytes = encoder.encode(options.rewriteLines ? options.rewriteLines(text) : text);
    bytesForwarded += bytes.byteLength;
    controller.enqueue(bytes);
    tail = (tail + text).slice(-2);
  };
  const relay = (controller: ReadableStreamDefaultController<Uint8Array>, text: string): boolean => {
    const buffered = carry + text;
    const cut = buffered.lastIndexOf('\n') + 1;
    carry = buffered.slice(cut);
    if (carry.length > MAX_SSE_LINE_CHARS) {
      throw new Error(`provider SSE line exceeded ${MAX_SSE_LINE_CHARS} characters`);
    }
    if (cut === 0) return false;
    const lines = buffered.slice(0, cut);
    let output = '';
    let start = 0;
    for (let end = lines.indexOf('\n'); end >= 0; end = lines.indexOf('\n', start)) {
      const line = lines.slice(start, end + 1);
      if (line.length > MAX_SSE_LINE_CHARS) {
        throw new Error(`provider SSE line exceeded ${MAX_SSE_LINE_CHARS} characters`);
      }
      const complete = completeJsonDataLine(line);
      if (complete && previousDataLineEnding) {
        // OpenAI chat-completion chunks are independent SSE events. Some
        // providers send consecutive complete `data:` JSON lines without the
        // blank line that dispatches the first event. EventSourceParser then
        // joins them with a newline and JSON.parse rejects the whole event.
        output += previousDataLineEnding;
        reportFramingRepair();
      }
      output += line;
      if (complete) previousDataLineEnding = line.endsWith('\r\n') ? '\r\n' : '\n';
      else if (line === '\n' || line === '\r\n' || line.startsWith('data:')) previousDataLineEnding = '';
      start = end + 1;
    }
    emit(controller, output);
    return true;
  };
  /**
   * Flushes the held carry at EOF. A complete-but-unterminated JSON/`[DONE]`
   * line gets its closing blank line (as before #7679). A carry that LOOKS
   * like an SSE data line but is not complete — the truncated-mid-JSON-line
   * case — is DROPPED instead of forwarded: never hand the client a partial
   * JSON fragment it cannot parse. A carry that is not `data:`-shaped at all
   * (an ordinary non-SSE body — see `treatAsSse`) is forwarded unchanged, so
   * a plain-text error response is never mangled by this SSE-specific logic.
   */
  const flushCarry = (controller: ReadableStreamDefaultController<Uint8Array>): void => {
    if (!carry) {
      if (previousDataLineEnding) {
        emit(controller, previousDataLineEnding);
        reportFramingRepair();
        previousDataLineEnding = '';
      }
      return;
    }
    const complete = completeJsonDataLine(carry);
    if (!complete && carry.startsWith('data:')) {
      // A genuinely truncated `data:` line — the upstream was cut mid-write.
      // Drop it silently; scanner.isTerminal will be false and the caller
      // classifies this as an incomplete stream.
      carry = '';
      previousDataLineEnding = '';
      return;
    }
    const repairedBoundary = complete && Boolean(previousDataLineEnding);
    // EventSourceParser does not dispatch an unterminated final event. A
    // complete OpenAI chunk at EOF needs the same blank line as every other
    // event, including when the provider omitted its final newline entirely.
    const output = (repairedBoundary ? previousDataLineEnding : '') + carry + (complete ? '\n\n' : '');
    if (complete) reportFramingRepair();
    emit(controller, output);
    carry = '';
    previousDataLineEnding = '';
  };

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

  /**
   * The upstream ended (cleanly or via an exception) without ever reaching a
   * well-defined completion. Decides between a transparent retry (nothing
   * forwarded yet, a redispatch candidate exists) and an explicit terminal
   * error frame (bytes already forwarded, or no more candidates).
   *
   * Returns `'retried'` when a fresh upstream has been swapped in — the
   * caller must `continue` its read loop without enqueueing or closing.
   * Returns `'terminated'` once the terminal frame has been enqueued,
   * `settle()` has run, and the controller has been closed.
   */
  async function handleIncompleteTermination(
    controller: ReadableStreamDefaultController<Uint8Array>,
    reason: SseErrorFrame,
  ): Promise<'retried' | 'terminated'> {
    if (bytesForwarded === 0 && options.redispatch && redispatchAttempts < maxRedispatchAttempts) {
      redispatchAttempts += 1;
      const delayMs =
        redispatchDelaysMs[Math.min(redispatchAttempts - 1, redispatchDelaysMs.length - 1)] ?? 0;
      if (delayMs > 0) await sleep(delayMs);
      let nextBody: ReadableStream<Uint8Array> | null = null;
      try {
        nextBody = await options.redispatch();
      } catch (redispatchError) {
        options.logger.warn('[gateway] transparent stream-cut retry failed to redispatch', {
          requestId: options.requestId,
          attempt: redispatchAttempts,
          error: redispatchError instanceof Error ? redispatchError.message : String(redispatchError),
        });
        nextBody = null;
      }
      if (nextBody) {
        options.logger.warn(
          '[gateway] upstream stream ended with no bytes sent — retrying transparently',
          { requestId: options.requestId, attempt: redispatchAttempts, reason: reason.code },
        );
        reader = nextBody.getReader();
        scanner = new IncrementalSseScanner();
        decoder = new TextDecoder();
        carry = '';
        previousDataLineEnding = '';
        framingRepairLogged = false;
        tail = '';
        lastByteAt = Date.now();
        pendingRead = null;
        return 'retried';
      }
      // Redispatch declined or failed — fall through to the terminal frame.
    }

    const detail: Record<string, unknown> = {
      bytesForwarded,
      durationMs: Date.now() - startedAtMs,
      redispatchAttempts,
      reason: reason.code,
    };
    const frame: SseErrorFrame = {
      message: reason.message,
      code: 'upstream_incomplete_stream',
      detail,
    };
    try {
      controller.enqueue(incompleteStreamFrame(encoder, frame));
    } catch {
      // The controller may already be unwritable in edge cases (e.g. the
      // client disconnected in the same tick) — settle() still must run.
    }
    await settle(frame);
    try {
      controller.close();
    } catch {
      // Already closed/errored.
    }
    return 'terminated';
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      // NOTE: the try/catch is INSIDE the loop (per-iteration), not wrapping
      // it — `continue`/`return` from a retry decision made in the catch
      // block must be lexically inside the loop it continues, or it's a
      // SyntaxError (`continue` needs a surrounding iteration statement).
      for (;;) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
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
              const inactivityError = {
                message: `provider sent no bytes for ${inactivityMs}ms`,
                code: 'upstream_inactivity_timeout',
              };
              if (!treatAsSse) {
                await settle(inactivityError);
                controller.error(new Error(inactivityError.message));
                return;
              }
              const outcome = await handleIncompleteTermination(controller, inactivityError);
              if (outcome === 'retried') continue;
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
            if (clientStop || !treatAsSse) {
              await settle(clientStop);
              controller.close();
              return;
            }
            if (scanner.isTerminal) {
              if (!scanner.hasExplicitDone) {
                // The upstream sent an in-band error frame but dropped the
                // connection before its own `[DONE]` — append it so a client
                // that waits specifically for the sentinel doesn't hang.
                try {
                  emit(controller, 'data: [DONE]\n\n');
                } catch {
                  // Already closed/errored.
                }
              }
              await settle();
              controller.close();
              return;
            }
            const outcome = await handleIncompleteTermination(controller, {
              message: 'upstream stream ended without a finish_reason or [DONE]',
              code: 'upstream_incomplete_stream',
            });
            if (outcome === 'retried') continue;
            return;
          }
          if (!value) continue;
          lastByteAt = Date.now();
          const text = decoder.decode(value, { stream: true });
          scanner.push(text);
          if (relay(controller, text)) return;
        } catch (error) {
          if (timer) clearTimeout(timer);
          // A gateway-side GUARD RAIL (a single SSE line past the memory
          // bound) is not "the upstream told us nothing" — it is this
          // process refusing to keep buffering. Preserve the original hard
          // failure (reject the response body) rather than reframing it as a
          // retryable/well-formed incomplete-stream error.
          const isLineLimitGuard = error instanceof Error && error.message.includes('SSE line exceeded');
          if (!treatAsSse || isLineLimitGuard) {
            const streamError = { message: messageOf(error), code: 'upstream_stream_error' };
            await settle(streamError);
            controller.error(error);
            return;
          }
          carry = '';
          previousDataLineEnding = '';
          const outcome = await handleIncompleteTermination(controller, {
            message: messageOf(error),
            code: 'upstream_stream_error',
          });
          if (outcome === 'retried') continue;
          return;
        }
      }
    },
    async cancel(reason) {
      clientStop ??= { message: 'client cancelled response', code: 'client_aborted' };
      await reader.cancel(reason).catch(() => undefined);
      await settle(clientStop);
    },
  });
}
