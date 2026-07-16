import {
  type ExtractedUsage,
  IncrementalSseScanner,
  type SseErrorFrame,
  sseErrorFrame,
  sseHasContent,
} from '../usage';
import { gatewayErrorBody } from './error-response';

export interface StreamRelayOptions {
  /** Fresh upstream body — mutually exclusive with `primed`. */
  upstreamBody?: ReadableStream<Uint8Array>;
  /** A reader already advanced by `probeStream`, plus the chunks it consumed (must be replayed first). */
  primed?: { reader: ReadableStreamDefaultReader<Uint8Array>; chunks: Uint8Array[] };
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
// Generous — well beyond any legitimate single-turn reasoning pause.
const INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000;
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
// within this budget. Bounding the probe by chunk/byte count (not a wall-clock
// timer racing the in-flight read) means we never abandon a pending read() and
// risk silently dropping a chunk once real relaying resumes.
const PROBE_MAX_CHUNKS = 64;
const PROBE_MAX_BYTES = 64 * 1024;

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
}

// Reads from the upstream body until real content/tool-call/reasoning output is
// seen, a structured upstream error frame is seen, the stream ends, or the probe
// budget is exhausted — whichever comes first. Every chunk consumed is captured
// in `chunks` so the caller can replay them verbatim (via `primed`) without
// losing a single byte, regardless of which outcome is reached.
export async function probeStream(body: ReadableStream<Uint8Array>): Promise<StreamProbeResult> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  const decoder = new TextDecoder();
  let buffer = '';
  let bytes = 0;

  for (;;) {
    if (chunks.length >= PROBE_MAX_CHUNKS || bytes >= PROBE_MAX_BYTES) {
      return { hasContent: true, reader, chunks };
    }
    let done: boolean;
    let value: Uint8Array | undefined;
    try {
      ({ done, value } = await reader.read());
    } catch (err) {
      const message = boundedErrorMessage(err);
      return {
        hasContent: sseHasContent(buffer),
        errorFrame: sseErrorFrame(buffer),
        readError: { message, code: 'upstream_stream_error' },
        reader,
        chunks,
      };
    }
    if (done)
      return {
        hasContent: sseHasContent(buffer),
        errorFrame: sseErrorFrame(buffer),
        reader,
        chunks,
      };
    if (!value) continue;
    chunks.push(value);
    bytes += value.byteLength;
    buffer += decoder.decode(value, { stream: true });
    // Content wins over an error frame in the same buffer: real output already
    // streamed, so relay it and let the relay path record any trailing error.
    if (sseHasContent(buffer)) return { hasContent: true, reader, chunks };
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
      const clientAbort = opts.signal
        ? new Promise<'aborted'>((resolve) => {
            if (opts.signal!.aborted) {
              resolve('aborted');
              return;
            }
            opts.signal!.addEventListener('abort', () => resolve('aborted'), { once: true });
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
        let pending = reader.read();
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
