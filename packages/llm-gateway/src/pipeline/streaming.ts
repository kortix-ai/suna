import { type ExtractedUsage, extractUsageFromSseBuffer, sseHasContent } from '../usage';

export interface StreamRelayOptions {
  /** Fresh upstream body — mutually exclusive with `primed`. */
  upstreamBody?: ReadableStream<Uint8Array>;
  /** A reader already advanced by `probeStream`, plus the chunks it consumed (must be replayed first). */
  primed?: { reader: ReadableStreamDefaultReader<Uint8Array>; chunks: Uint8Array[] };
  captureBodies: boolean;
  requestId: string;
  logger: { warn: (...args: unknown[]) => void; debug?: (...args: unknown[]) => void };
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

// A candidate that opens a stream, sends nothing usable, and closes cleanly (the
// empty-completion bug) fails fast — real models produce their first token well
// within this budget. Bounding the probe by chunk/byte count (not a wall-clock
// timer racing the in-flight read) means we never abandon a pending read() and
// risk silently dropping a chunk once real relaying resumes.
const PROBE_MAX_CHUNKS = 64;
const PROBE_MAX_BYTES = 64 * 1024;

export interface StreamProbeResult {
  hasContent: boolean;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  chunks: Uint8Array[];
}

// Reads from the upstream body until either real content/tool-call/reasoning
// output is seen, the stream ends, or the probe budget is exhausted — whichever
// comes first. Every chunk consumed is captured in `chunks` so the caller can
// replay them verbatim (via `primed`) without losing a single byte, regardless
// of which outcome is reached.
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
    } catch {
      // A read error mid-probe is not this function's concern to report — whatever
      // content (if any) arrived before the error is all there is to judge on.
      return { hasContent: sseHasContent(buffer), reader, chunks };
    }
    if (done) return { hasContent: sseHasContent(buffer), reader, chunks };
    if (!value) continue;
    chunks.push(value);
    bytes += value.byteLength;
    buffer += decoder.decode(value, { stream: true });
    if (sseHasContent(buffer)) return { hasContent: true, reader, chunks };
  }
}

export function relayStream(opts: StreamRelayOptions): ReadableStream<Uint8Array> {
  const { captureBodies, requestId, logger, settle } = opts;
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const transform = new TransformStream<Uint8Array, Uint8Array>();
  const writer = transform.writable.getWriter();
  const decoder = new TextDecoder();
  let sseBuffer = '';

  const startMs = Date.now();
  const debug = (event: string, fields?: Record<string, unknown>): void =>
    logger.debug?.(`[gateway] · ${requestId} ${event}`, { requestId, event, ...fields });

  void (async () => {
    const reader = opts.primed?.reader ?? opts.upstreamBody?.getReader();
    if (!reader) throw new Error('relayStream requires either `primed` or `upstreamBody`');
    let downstreamAlive = true;
    let firstByteAt = 0;
    let bytes = 0;
    let chunks = 0;
    let heartbeats = 0;

    const writeChunk = async (value: Uint8Array): Promise<void> => {
      if (!firstByteAt) {
        firstByteAt = Date.now();
        debug('stream_first_byte', { ttfbMs: firstByteAt - startMs });
      }
      chunks += 1;
      bytes += value.byteLength;
      sseBuffer += decoder.decode(value, { stream: true });
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

      // Keep exactly one read in flight; race it against a heartbeat timer so a
      // long token gap emits a keep-alive without ever issuing a second read.
      let pending = reader.read();
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
    } catch (err) {
      logger.warn(`[llm-gateway] stream read error ${requestId}:`, err);
      debug('stream_error', {
        error: err instanceof Error ? err.message : String(err),
        bytes,
        chunks,
      });
    } finally {
      try {
        await writer.close();
      } catch {
        // writer already closed / downstream gone — nothing to do here.
      }
      debug('stream_end', {
        totalMs: Date.now() - startMs,
        ttfbMs: firstByteAt ? firstByteAt - startMs : null,
        bytes,
        chunks,
        heartbeats,
        downstreamAlive,
      });
      // Settlement (usage extraction + recordUsage + trace) must never throw out
      // of this detached async task — a failure here would otherwise be an
      // unhandled rejection and silently lose billing/trace for the stream.
      try {
        await settle(extractUsageFromSseBuffer(sseBuffer), captureBodies ? sseBuffer : null);
      } catch (err) {
        logger.warn(`[llm-gateway] stream settle failed ${requestId}:`, err);
      }
    }
  })();

  return transform.readable;
}
