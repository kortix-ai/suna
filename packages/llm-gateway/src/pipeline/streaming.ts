import {
  type ExtractedUsage,
  IncrementalSseScanner,
  type SseErrorFrame,
  sseErrorFrame,
  sseHasContent,
  sseMayContainSoftFailure,
  sseSoftFailureFrame,
} from '../usage';
import { gatewayErrorBody } from './error-response';

export interface StreamRelayOptions {
  /** Fresh upstream body — mutually exclusive with `primed`. */
  upstreamBody?: ReadableStream<Uint8Array>;
  /** A reader already advanced by `probeStream`, plus the chunks it consumed (must be replayed first). */
  primed?: {
    reader: ReadableStreamDefaultReader<Uint8Array>;
    chunks: Uint8Array[];
    /**
     * A read the probe left in flight (commit-on-timeout path). Adopted as the
     * relay's first pending read — issuing a fresh one instead would queue
     * behind it and drop the chunk it resolves with.
     */
    pendingRead?: ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>;
  };
  captureBodies: boolean;
  requestId: string;
  logger: { warn: (...args: unknown[]) => void; debug?: (...args: unknown[]) => void };
  settle: (
    usage: ExtractedUsage | null,
    response: unknown,
    streamError?: SseErrorFrame | null,
  ) => Promise<void>;
  errorContext?: {
    provider: string;
    requestedModel: string;
    resolvedModel: string;
    requestId: string;
  };
  /** Keep-alive interval in ms (overridable for tests). */
  heartbeatMs?: number;
  /**
   * Inbound (client-facing) request's abort signal. When it fires — the
   * caller's tab closed, they hit stop, the TCP connection dropped — the
   * upstream reader is cancelled immediately instead of being drained to
   * completion for no one, so a disconnected client also stops the upstream
   * from generating (and us from being billed for) tokens nobody will see.
   */
  signal?: AbortSignal;
  /**
   * Total time upstream may go completely silent (no bytes at all, not even
   * a heartbeat-worthy gap) before the stream is treated as stalled and
   * aborted. Generous by default so a slow-thinking reasoning model is never
   * mistaken for a dead connection — this only fires when NOTHING has been
   * read for the whole window, not merely a gap between tokens (that's what
   * the heartbeat is for). Overridable for tests.
   */
  inactivityTimeoutMs?: number;
  /**
   * Cap (bytes, pre-JSON-escaping) on the response preview retained for the
   * trace when `captureBodies` is on. Independent of the stream's actual
   * duration/size — the preview stops growing once it hits this cap instead
   * of retaining the full stream text for the whole completion.
   */
  maxCapturedBodyBytes?: number;
}

// How long upstream may go silent before we emit a keep-alive. A reasoning model
// (or a slow first token) can pause longer than the socket idle timeouts on the
// gateway, the API reverse proxy, AND opencode — any of which would otherwise
// drop the connection and surface to opencode as "Connection reset by server".
const HEARTBEAT_MS = 10_000;
// SSE comment line — ignored by every SSE/OpenAI client, so it's invisible
// payload that just resets each hop's idle timer.
const HEARTBEAT_FRAME = new TextEncoder().encode(': keep-alive\n\n');
// Total silence budget before a stalled-but-never-closed upstream connection
// (accepted the request, sent a 200, then never sent another byte and never
// closed) is treated as dead rather than propped up by heartbeats forever.
//
// This is a GAP budget, not a duration budget: it measures time since the last
// byte and resets on every chunk, so it never truncates a long-but-productive
// stream. Sizing therefore only has to clear the largest legitimate SILENCE,
// not the largest legitimate response — a Claude Fable 5 turn emitting its full
// 128,000-token ceiling at 50 tok/s runs 2,560s (42m40s) end to end and is
// never at risk from a gap budget, because every token resets the clock.
//
// 90 minutes is deliberately far beyond any gap a working upstream produces.
// The only thing it delays is declaring a wedged-but-open socket dead, and that
// case is already bounded from both ends: the client can abort at any time, and
// heartbeats keep every intermediate hop's socket alive meanwhile.
const INACTIVITY_TIMEOUT_MS = 90 * 60 * 1000;
// Default cap on the retained response preview when `captureBodies` is on —
// matches the gateway's default `maxCapturedBodyBytes`.
const DEFAULT_PREVIEW_CAP_BYTES = 256 * 1024;

class StreamInactivityTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`upstream stream inactivity timeout exceeded (${timeoutMs}ms with no bytes)`);
    this.name = 'StreamInactivityTimeoutError';
  }
}

// A candidate that opens a stream, sends nothing usable, and closes cleanly (the
// empty-completion bug) fails fast — real models produce their first token well
// within this budget. The chunk/byte budget bounds valid but content-free
// frames.
const PROBE_MAX_CHUNKS = 64;
const PROBE_MAX_BYTES = 64 * 1024;

/**
 * How long the probe waits for a byte before it stops holding the response back
 * and COMMITS the candidate to the relay (see handler.ts).
 *
 * This is a commit deadline, NOT a failure deadline. Exceeding it no longer
 * fails the turn: the stream is handed to relayStream, which starts heart-
 * beating downstream immediately and waits out the real work under the (much
 * larger) INACTIVITY_TIMEOUT_MS gap budget. The only thing this bound costs is
 * the ability to fail over to another candidate, which is the correct trade —
 * a slow candidate is not a broken one.
 *
 * WHY THIS IS NOT SIZE-SCALED ANY MORE. It used to be
 * `30_000 + ceil((requestBytes - 64KiB) / 1MiB) * 15_000`, capped at 120_000.
 * Any request body between 3,211,776 and 4,259,840 bytes therefore resolved to
 * exactly 90,000 — and a Claude Fable 5 turn on a ~3.5MiB context routinely
 * spends longer than that in prefill + thinking before its first reasoning
 * delta, because the transport emits no bytes for the AI SDK's `start` /
 * `start-step` parts. The result was a deterministic, repeating
 * `upstream stream probe timeout exceeded (90000ms with no bytes)` on a
 * perfectly healthy upstream: the bigger the context, the longer the model
 * needs, and the ladder handed it a bigger budget while the model needed a
 * bigger one still. Scaling the budget could only ever move the cliff; it
 * could not remove it. Committing instead of failing removes it.
 *
 * It must also stay well under the downstream first-byte deadline: nothing has
 * been written to the client yet while the probe runs, and the edge will serve
 * a 524 if the origin takes too long to respond. Measured on the live
 * kortix.com zone (2026-08-16): `proxy_read_timeout = 125` seconds, and
 * `editable: false` on the Free plan, so it cannot be raised. 30s leaves ~95s
 * of headroom. Raising this budget past ~125s cannot work — the client would
 * get a Cloudflare 524 before the gateway ever reached its own deadline.
 */
const PROBE_COMMIT_DEADLINE_MS = 30_000;

export interface StreamProbeTimeoutInput {
  requestBytes: number;
  provider: string;
  model: string;
  /** Exact operator override. Omit it to use the default commit deadline. */
  configuredTimeoutMs?: number;
}

/**
 * Resolve the first-byte commit deadline for a newly opened upstream stream.
 *
 * One value for every provider, model, and request size. See
 * PROBE_COMMIT_DEADLINE_MS for why this is deliberately not adaptive.
 */
export function resolveStreamProbeTimeoutMs(input: StreamProbeTimeoutInput): number {
  if (input.configuredTimeoutMs !== undefined && input.configuredTimeoutMs > 0) {
    return input.configuredTimeoutMs;
  }
  return PROBE_COMMIT_DEADLINE_MS;
}

export interface StreamProbeOptions {
  /**
   * Maximum time to wait for a chunk while no usable output exists. On expiry
   * the probe returns `stream_probe_timeout` with the reader STILL OPEN and its
   * in-flight read handed back as `pendingRead`, so the caller can commit the
   * stream to the relay. Every other content-free outcome cancels the reader.
   */
  inactivityTimeoutMs?: number;
}

/** Exactly what `reader.read()` returns, so no structural mismatch can creep in. */
type PendingRead = ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>;

export interface StreamProbeResult {
  hasContent: boolean;
  // First structured upstream error frame seen during the probe, if any. An
  // otherwise-200 stream that carries `data: {"error":{...}}` and no content is a
  // definitive upstream failure (Anthropic `overloaded_error`, an OpenAI
  // `response.failed`, a request-too-large rejection) — not the transient
  // "empty stop" hiccup that same-candidate retries target. The caller surfaces
  // this real error instead of retrying into a generic empty-completion.
  errorFrame?: SseErrorFrame | null;
  readError?: SseErrorFrame | null;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  chunks: Uint8Array[];
  /**
   * The read that was still in flight when the commit deadline expired. Set
   * ONLY on the `stream_probe_timeout` outcome. The relay must adopt it as its
   * first pending read rather than issuing a fresh `reader.read()`: a second
   * read queues BEHIND this one, so the chunk this promise eventually resolves
   * with would be delivered to an orphaned promise and silently dropped.
   */
  pendingRead?: PendingRead;
}

// Reads from the upstream body until real content/tool-call/reasoning output is
// seen, a structured upstream error frame is seen, the stream ends, or the probe
// budget is exhausted — whichever comes first. Every chunk consumed is captured
// in `chunks` so the caller can replay them verbatim (via `primed`) without
// losing a single byte, regardless of which outcome is reached.
export async function probeStream(
  body: ReadableStream<Uint8Array>,
  options: StreamProbeOptions = {},
): Promise<StreamProbeResult> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  const decoder = new TextDecoder();
  const inactivityTimeoutMs = options.inactivityTimeoutMs ?? PROBE_COMMIT_DEADLINE_MS;
  let buffer = '';
  let bytes = 0;
  // Exactly one read is kept in flight across loop turns. Hoisted out of the
  // race so a timeout can hand the still-pending read to the relay instead of
  // orphaning it — see StreamProbeResult.pendingRead.
  let pending: PendingRead | null = null;

  for (;;) {
    const mayContainSoftFailure =
      sseHasContent(buffer) && sseMayContainSoftFailure(buffer);
    if (bytes >= PROBE_MAX_BYTES && mayContainSoftFailure) {
      const message = 'suspected soft-failure stream exceeded the probe byte limit';
      await reader.cancel(message).catch(() => undefined);
      return {
        hasContent: false,
        readError: { message, code: 'soft_failure_probe_limit' },
        reader,
        chunks,
      };
    }
    if (
      bytes >= PROBE_MAX_BYTES ||
      (chunks.length >= PROBE_MAX_CHUNKS && !mayContainSoftFailure)
    ) {
      return { hasContent: true, reader, chunks };
    }
    const inFlight: PendingRead = pending ?? reader.read();
    pending = inFlight;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      inFlight.then(
        (result) => ({ kind: 'read' as const, result }),
        (error: unknown) => ({ kind: 'error' as const, error }),
      ),
      new Promise<{ kind: 'timeout' }>((resolve) => {
        timeout = setTimeout(() => resolve({ kind: 'timeout' }), inactivityTimeoutMs);
      }),
    ]);
    if (timeout) clearTimeout(timeout);

    if (outcome.kind === 'timeout') {
      const message =
        `upstream stream probe timeout exceeded (${inactivityTimeoutMs}ms with no bytes)`;
      // Deliberately NOT cancelled: the caller commits this stream to the relay
      // (handler.ts), which resumes reading from `pendingRead`. Cancelling a
      // healthy, still-prefilling upstream here is exactly the bug this path
      // used to have.
      return {
        hasContent: sseHasContent(buffer),
        errorFrame: sseErrorFrame(buffer),
        readError: { message, code: 'stream_probe_timeout' },
        reader,
        chunks,
        pendingRead: inFlight,
      };
    }
    // The awaited read settled — the next loop turn must issue a fresh one.
    pending = null;
    if (outcome.kind === 'error') {
      const err = outcome.error;
      const message = boundedErrorMessage(err);
      return {
        hasContent: sseHasContent(buffer),
        errorFrame: sseErrorFrame(buffer),
        readError: { message, code: 'upstream_stream_error' },
        reader,
        chunks,
      };
    }
    const { done, value } = outcome.result;
    if (done) {
      const softFailure = sseSoftFailureFrame(buffer);
      return {
        hasContent: softFailure ? false : sseHasContent(buffer),
        errorFrame: softFailure ?? sseErrorFrame(buffer),
        reader,
        chunks,
      };
    }
    if (!value) continue;
    chunks.push(value);
    bytes += value.byteLength;
    buffer += decoder.decode(value, { stream: true });
    const softFailure = sseSoftFailureFrame(buffer);
    if (softFailure) {
      return { hasContent: false, errorFrame: softFailure, reader, chunks };
    }
    // Content wins over an error frame in the same buffer: real output already
    // streamed, so relay it and let the relay path record any trailing error.
    // Hold only the exact prefix of the known soft-failure text.
    if (sseHasContent(buffer) && !sseMayContainSoftFailure(buffer)) {
      return { hasContent: true, reader, chunks };
    }
    const errorFrame = sseErrorFrame(buffer);
    if (errorFrame) return { hasContent: false, errorFrame, reader, chunks };
  }
}

function boundedErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return (message || 'Upstream stream failed').slice(0, 2_000);
}

export function relayStream(opts: StreamRelayOptions): ReadableStream<Uint8Array> {
  const { captureBodies, requestId, logger, settle } = opts;
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const inactivityTimeoutMs = opts.inactivityTimeoutMs ?? INACTIVITY_TIMEOUT_MS;
  const previewCapBytes = opts.maxCapturedBodyBytes ?? DEFAULT_PREVIEW_CAP_BYTES;
  const transform = new TransformStream<Uint8Array, Uint8Array>();
  const writer = transform.writable.getWriter();
  const decoder = new TextDecoder();
  // Bounded scanner replaces full-stream buffering: usage/error extraction is
  // done incrementally per-chunk (memory ~O(1) per stream, not O(total tokens)
  // streamed) instead of re-scanning one ever-growing string at the end.
  const scanner = new IncrementalSseScanner();
  // Separate, small, capped preview retained ONLY for the trace (when
  // `captureBodies` is on) — independent of the scanner above, and stops
  // growing once it hits the cap rather than retaining the full stream text.
  let preview = '';
  let previewBytes = 0;
  // Smallest possible state to reproduce the old "are we at an SSE event
  // boundary" check (`sseBuffer === '' || sseBuffer.endsWith('\n\n')`) without
  // keeping the whole buffer around — only the last couple of characters ever
  // written matter for that test.
  let tailChars = '';
  let anyBytesWritten = false;

  const startMs = Date.now();
  const debug = (event: string, fields?: Record<string, unknown>): void =>
    logger.debug?.(`[gateway] · ${requestId} ${event}`, { requestId, event, ...fields });

  void (async () => {
    const reader = opts.primed?.reader ?? opts.upstreamBody?.getReader();
    if (!reader) throw new Error('relayStream requires either `primed` or `upstreamBody`');
    let downstreamAlive = true;
    let firstByteAt = 0;
    let lastActivityAt = startMs;
    let bytes = 0;
    let chunks = 0;
    let heartbeats = 0;
    let clientAborted = false;

    const writeChunk = async (value: Uint8Array): Promise<void> => {
      if (!firstByteAt) {
        firstByteAt = Date.now();
        debug('stream_first_byte', { ttfbMs: firstByteAt - startMs });
      }
      lastActivityAt = Date.now();
      chunks += 1;
      bytes += value.byteLength;
      const decoded = decoder.decode(value, { stream: true });
      scanner.push(decoded);
      if (decoded) {
        anyBytesWritten = true;
        tailChars = (tailChars + decoded).slice(-2);
      }
      if (captureBodies && previewBytes < previewCapBytes) {
        const remaining = previewCapBytes - previewBytes;
        const slice = decoded.length <= remaining ? decoded : decoded.slice(0, remaining);
        preview += slice;
        previewBytes += slice.length;
      }
      if (downstreamAlive) {
        try {
          await writer.write(value);
        } catch {
          downstreamAlive = false;
        }
      }
    };

    debug('stream_open', {
      primed: Boolean(opts.primed),
      primedChunks: opts.primed?.chunks.length ?? 0,
    });
    try {
      // Replay whatever probeStream already consumed before this relay took over —
      // these bytes were never sent to the client, so order/content must be exact.
      if (opts.primed) {
        for (const value of opts.primed.chunks) await writeChunk(value);
      }

      // The inbound (client-facing) request's own abort signal — fires when the
      // caller disconnects (tab closed, stop hit, TCP reset). Racing it below
      // means a disconnected client stops the upstream read loop immediately
      // instead of draining an upstream that keeps generating (and billing)
      // tokens for no one.
      const signal = opts.signal;
      const clientAbort = signal
        ? new Promise<'aborted'>((resolve) => {
            if (signal.aborted) {
              resolve('aborted');
              return;
            }
            signal.addEventListener('abort', () => resolve('aborted'), { once: true });
          })
        : null;

      if (opts.signal?.aborted) {
        // Already gone before the relay even started (e.g. disconnected during
        // the probe phase) — never issue a read, just cancel and settle below.
        clientAborted = true;
        downstreamAlive = false;
      } else {
        // Keep exactly one read in flight; race it against a heartbeat timer so a
        // long token gap emits a keep-alive without ever issuing a second read,
        // and against the client-abort signal so a disconnect is noticed even
        // while a read is still pending.
        let pending = opts.primed?.pendingRead ?? reader.read();
        while (true) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const beat = new Promise<'beat'>((resolve) => {
            timer = setTimeout(() => resolve('beat'), heartbeatMs);
          });
          const race = clientAbort
            ? [pending.then((r) => ({ read: r })), beat, clientAbort]
            : [pending.then((r) => ({ read: r })), beat];
          const next = await Promise.race(race);
          if (timer) clearTimeout(timer);

          if (next === 'aborted') {
            clientAborted = true;
            downstreamAlive = false;
            break;
          }

          if (next === 'beat') {
            // Upstream has been completely silent (no bytes at all, not even a
            // heartbeat-worthy gap that later resumed) for the full inactivity
            // budget — a stalled-but-never-closed connection, not a slow
            // reasoning pause (which still eventually produces bytes and resets
            // `lastActivityAt`). Treat it as a dead stream instead of heartbeat-
            // propping it up forever.
            if (Date.now() - lastActivityAt >= inactivityTimeoutMs) {
              try {
                await reader.cancel();
              } catch {
                // already errored/closed — nothing to clean up.
              }
              throw new StreamInactivityTimeoutError(inactivityTimeoutMs);
            }
            // Inject the comment only at an SSE event boundary (buffer empty, or
            // ends with the \n\n terminator) so we never split a partial event
            // mid-flight. `pending` stays in flight.
            if (downstreamAlive && (!anyBytesWritten || tailChars === '\n\n')) {
              try {
                await writer.write(HEARTBEAT_FRAME);
                heartbeats += 1;
                debug('stream_heartbeat', { sinceStartMs: Date.now() - startMs, heartbeats });
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
          await writeChunk(value);
        }
      }

      if (clientAborted) {
        // The client is gone — cancelling the reader tells the upstream (fetch
        // implementation permitting) to stop sending/generating further tokens
        // rather than have the gateway keep draining and paying for a response
        // no one will ever see.
        try {
          await reader.cancel();
        } catch {
          // already errored/closed — nothing to clean up.
        }
      }
    } catch (err) {
      const message = boundedErrorMessage(err);
      const inactivityTimeout = err instanceof StreamInactivityTimeoutError;
      logger.warn(`[llm-gateway] stream read error ${requestId}:`, err);
      debug('stream_error', {
        error: message,
        bytes,
        chunks,
        inactivityTimeout,
      });
      // Once headers are committed, SSE is the only remaining error channel.
      // Emit the standard shape opencode understands instead of silently closing.
      if (downstreamAlive) {
        const frame = `data: ${JSON.stringify(gatewayErrorBody({
          message,
          code: inactivityTimeout ? 'stream_inactivity_timeout' : 'upstream_stream_error',
          provider: opts.errorContext?.provider ?? '',
          requestedModel: opts.errorContext?.requestedModel ?? '',
          resolvedModel: opts.errorContext?.resolvedModel ?? '',
          requestId: opts.errorContext?.requestId ?? requestId,
          suggestion: 'Retry the request. If the error continues, switch to another model.',
        }))}\n\n`;
        await writeChunk(new TextEncoder().encode(frame));
      }
    } finally {
      try {
        await writer.close();
      } catch {
        // writer already closed / downstream gone — nothing to do here.
      }
      scanner.finish();
      // An upstream that dies mid-generation (a stalled model host behind
      // OpenRouter, e.g. "Upstream idle timeout exceeded") reports it as an
      // in-stream error frame on an otherwise clean 200 stream. Surface it so
      // the trace records a failed turn instead of a silent success.
      const streamError = scanner.error;
      if (streamError) {
        logger.warn(
          `[llm-gateway] upstream error frame in stream ${requestId}: "${streamError.message}"${streamError.code !== undefined ? ` (code ${streamError.code})` : ''}`,
        );
      }
      debug('stream_end', {
        totalMs: Date.now() - startMs,
        ttfbMs: firstByteAt ? firstByteAt - startMs : null,
        bytes,
        chunks,
        heartbeats,
        downstreamAlive,
        clientAborted,
        ...(streamError ? { streamError: streamError.message } : {}),
      });
      // Settlement (usage extraction + recordUsage + trace) must never throw out
      // of this detached async task — a failure here would otherwise be an
      // unhandled rejection and silently lose billing/trace for the stream.
      try {
        await settle(scanner.usage, captureBodies ? preview : null, streamError);
      } catch (err) {
        logger.warn(`[llm-gateway] stream settle failed ${requestId}:`, err);
      }
    }
  })();

  return transform.readable;
}
