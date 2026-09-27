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
   * SSE — line-buffering, completion detection, and transparent retry all
   * assume SSE framing and must never rewrite or truncate an ordinary error
   * body a client is going to read as plain text/JSON. In that mode this
   * behaves exactly like a byte-for-byte pipe: every chunk read is forwarded
   * immediately, and the stream settles the instant the upstream body ends,
   * whatever it contains.
   */
  treatAsSse?: boolean;
}

const HEARTBEAT = new TextEncoder().encode(': keep-alive\n\n');
const DEFAULT_HEARTBEAT_MS = 10_000;
const DEFAULT_INACTIVITY_MS = 90 * 60_000;
const DEFAULT_MAX_REDISPATCH_ATTEMPTS = 2;
const DEFAULT_REDISPATCH_DELAYS_MS = [250, 750];

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
function incompleteStreamFrame(reason: SseErrorFrame): Uint8Array {
  const body = {
    error: {
      message: reason.message,
      code: reason.code,
      type: reason.code,
    },
  };
  return new TextEncoder().encode(`data: ${JSON.stringify(body)}\n\ndata: [DONE]\n\n`);
}

/** Relays one provider stream without retaining the full body in memory. */
export function relayStream(options: StreamRelayOptions): ReadableStream<Uint8Array> {
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const inactivityMs = options.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_MS;
  const maxRedispatchAttempts = Math.max(0, options.maxRedispatchAttempts ?? DEFAULT_MAX_REDISPATCH_ATTEMPTS);
  const redispatchDelaysMs = options.redispatchDelaysMs ?? DEFAULT_REDISPATCH_DELAYS_MS;
  const sleep = options.sleep ?? realSleep;
  const treatAsSse = options.treatAsSse ?? true;
  const encoder = new TextEncoder();
  const startedAtMs = Date.now();

  let reader = options.upstreamBody.getReader();
  let scanner = new IncrementalSseScanner();
  let decoder = new TextDecoder();
  let lastByteAt = Date.now();
  // Last 2 raw upstream characters seen (independent of what has been
  // forwarded) — used only to decide whether it's currently safe to inject a
  // heartbeat comment without landing it inside an in-progress SSE frame.
  let tail = '';
  // Bytes of a line the upstream has not yet terminated with `\n`. NEVER
  // forwarded to the client — only complete lines are. Dropped outright on
  // any termination path (requirement: never forward a partial SSE line).
  let outCarry = '';
  let bytesForwarded = 0;
  let redispatchAttempts = 0;
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

  /** Forwards only complete lines from `text`, holding an incomplete tail in `outCarry`. */
  function bufferForForwarding(controller: ReadableStreamDefaultController<Uint8Array>, text: string): void {
    outCarry += text;
    const lastNl = outCarry.lastIndexOf('\n');
    if (lastNl < 0) return;
    const complete = outCarry.slice(0, lastNl + 1);
    outCarry = outCarry.slice(lastNl + 1);
    if (!complete) return;
    const bytes = encoder.encode(complete);
    bytesForwarded += bytes.byteLength;
    controller.enqueue(bytes);
  }

  /**
   * The upstream ended (cleanly or via an exception) without ever reaching a
   * well-defined completion. Decides between a transparent retry (nothing
   * forwarded yet, a redispatch candidate exists) and an explicit terminal
   * error frame (bytes already forwarded, or no more candidates) — see the
   * class-level doc comment on `StreamRelayOptions.redispatch`.
   *
   * Returns `'retried'` when a fresh upstream has been swapped in — the
   * caller must return from `pull()` immediately without enqueueing or
   * closing, so the stream machinery calls `pull()` again to read the new
   * attempt. Returns `'terminated'` once the terminal frame has been
   * enqueued, `settle()` has run, and the controller has been closed.
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
          {
            requestId: options.requestId,
            attempt: redispatchAttempts,
            reason: reason.code,
          },
        );
        reader = nextBody.getReader();
        scanner = new IncrementalSseScanner();
        decoder = new TextDecoder();
        outCarry = '';
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
      controller.enqueue(incompleteStreamFrame(frame));
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
    // A loop, not a single pass: the underlying runtime does NOT re-invoke
    // `pull()` on its own just because a previous call returned having
    // enqueued nothing (verified against Bun 1.3.14 — a `pull()` that returns
    // without enqueue/close/error is never called again, and the response
    // hangs forever). A transparent redispatch, or a read that produced bytes
    // with no newline in them yet, both need to keep reading WITHOUT handing
    // control back to the stream machinery until there is real work to
    // report: an enqueue, a close, or an error.
    async pull(controller) {
      for (;;) {
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
            // Mid-frame — unsafe to inject a heartbeat right now. Keep
            // waiting on the same pending read rather than handing control
            // back with nothing done.
            continue;
          }

          const { done, value } = next.value;
          pendingRead = null;
          if (done) {
            // Flush the decoder and the scanner's carry: a provider whose
            // last line has no trailing newline keeps its usage frame in the
            // carry, and without this that turn is billed as zero tokens.
            const trailing = decoder.decode();
            if (trailing) scanner.push(trailing);
            scanner.finish();
            if (!treatAsSse) {
              await settle();
              controller.close();
              return;
            }
            // Never forward the trailing partial line/chunk — drop it,
            // whether it's a truncated JSON line or anything else the
            // upstream never finished writing.
            outCarry = '';
            if (scanner.isTerminal) {
              if (!scanner.hasExplicitDone) {
                // The upstream sent an in-band error frame but dropped the
                // connection before its own `[DONE]` — append it so a client
                // that waits specifically for the sentinel doesn't hang.
                try {
                  controller.enqueue(encoder.encode('data: [DONE]\n\n'));
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
          if (!treatAsSse) {
            bytesForwarded += value.byteLength;
            controller.enqueue(value);
            return;
          }
          const text = decoder.decode(value, { stream: true });
          scanner.push(text);
          tail = (tail + text).slice(-2);
          const forwardedBefore = bytesForwarded;
          bufferForForwarding(controller, text);
          if (bytesForwarded > forwardedBefore) return;
          // No complete line yet — keep reading rather than returning empty-
          // handed (see the loop's doc comment above).
        } catch (error) {
          if (timer) clearTimeout(timer);
          if (!treatAsSse) {
            const streamError = { message: messageOf(error), code: 'upstream_stream_error' };
            await settle(streamError);
            controller.error(error);
            return;
          }
          outCarry = '';
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
      await reader.cancel(reason).catch(() => undefined);
      await settle({ message: 'client cancelled response', code: 'client_aborted' });
    },
  });
}
