/**
 * Detection for the 200-then-silence SSE failure (prod, 2026-08-26).
 *
 * The ingress cache (`backend.ts`, 5-minute TTL) is invalidated only on an
 * upstream 502/503 or a lifecycle event. A cached ingress URL that still
 * ACCEPTS connections after the box moved answers `200 text/event-stream` and
 * never writes a byte — no error status is ever observed, nothing invalidates
 * the cache, and every client-heartbeat reconnect (60s cadence) lands on the
 * same dead address for the rest of the TTL. Nothing logs it either: the api
 * suppresses long-lived 200 `/global/event` requests as healthy noise.
 *
 * A zero-byte SSE stream is that failure's exact signature. opencode writes
 * an event immediately on a real connection (`server.connected`), and the
 * sandbox daemon additionally injects a keepalive event within 20s of silence
 * (`apps/kortix-sandbox-agent-server/src/sse-keepalive.ts`) — so a stream
 * that closed without EVER delivering a byte did not reach a live opencode.
 * This module records that outcome per `sandboxId:port`, and the proxy's next
 * `/global/event` connect for that sandbox consumes the mark to bypass the
 * ingress cache and re-resolve. One provider call per silent stream, none on
 * the healthy path.
 */

/** How long a silent-stream mark stays actionable. Longer than the client's
 *  reconnect cadence (60s heartbeat + backoff) with slack; far shorter than a
 *  tab's lifetime, so a mark from a box that has since been torn down cannot
 *  trigger provider calls indefinitely. */
export const SSE_SILENT_MARK_MAX_AGE_MS = 10 * 60 * 1000;

/** Registry bound — silent marks are per sandbox:port, so this is far above
 *  any honest concurrent-sandbox count and exists only as a leak backstop. */
const MAX_TRACKED = 1_000;

const silentStreamMarks = new Map<string, number>();

function pruneIfNeeded(nowMs: number): void {
  if (silentStreamMarks.size <= MAX_TRACKED) return;
  for (const [key, markedAtMs] of silentStreamMarks) {
    if (nowMs - markedAtMs > SSE_SILENT_MARK_MAX_AGE_MS) silentStreamMarks.delete(key);
    if (silentStreamMarks.size <= MAX_TRACKED) return;
  }
  // Still over the cap with only fresh marks (pathological): drop oldest-first
  // insertion order until bounded.
  for (const key of silentStreamMarks.keys()) {
    silentStreamMarks.delete(key);
    if (silentStreamMarks.size <= MAX_TRACKED) return;
  }
}

/** Record how an SSE stream for `key` (`sandboxId:port`) ended. Zero bytes
 *  marks the sandbox; any delivered byte clears a prior mark — the path is
 *  proven and older evidence is obsolete. */
export function recordSseStreamEnd(key: string, deliveredBytes: number, nowMs = Date.now()): void {
  if (deliveredBytes > 0) {
    silentStreamMarks.delete(key);
    return;
  }
  silentStreamMarks.set(key, nowMs);
  pruneIfNeeded(nowMs);
}

/** Consume-once read of the silent mark for `key`. True means the caller
 *  should invalidate the cached ingress before resolving — once, for the
 *  connect that follows the silent stream; consuming keeps every FURTHER
 *  reconnect from turning into a provider call. */
export function shouldBypassIngressCache(key: string, nowMs = Date.now()): boolean {
  const markedAtMs = silentStreamMarks.get(key);
  if (markedAtMs === undefined) return false;
  silentStreamMarks.delete(key);
  return nowMs - markedAtMs <= SSE_SILENT_MARK_MAX_AGE_MS;
}

/** Test seam: this registry is module state by design (one per api process). */
export function resetSseStallRegistryForTests(): void {
  silentStreamMarks.clear();
}

/**
 * Byte-counting passthrough for an SSE response body. Forwards chunks
 * untouched, preserves backpressure (one upstream read per `pull`), and calls
 * `onEnd(deliveredBytes)` exactly once — on upstream close, upstream error,
 * or downstream cancel (the browser navigating away counts: a stream the
 * client held for a while that never delivered a byte is still silent).
 */
export function trackSseBytes(
  upstream: ReadableStream<Uint8Array>,
  onEnd: (deliveredBytes: number) => void,
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  let deliveredBytes = 0;
  let ended = false;

  const end = () => {
    if (ended) return;
    ended = true;
    try {
      onEnd(deliveredBytes);
    } catch {
      // The observer must never break the stream.
    }
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let result: Awaited<ReturnType<typeof reader.read>>;
      try {
        result = await reader.read();
      } catch (err) {
        end();
        try {
          controller.error(err);
        } catch {
          // Already closed/errored.
        }
        return;
      }
      if (result.done) {
        end();
        try {
          controller.close();
        } catch {
          // Already closed.
        }
        return;
      }
      const chunk = result.value;
      if (chunk && chunk.length > 0) {
        deliveredBytes += chunk.length;
        try {
          controller.enqueue(chunk);
        } catch {
          // Consumer gone mid-pull; `cancel` cleans up the reader.
        }
      }
    },
    cancel(reason) {
      end();
      return reader.cancel(reason);
    },
  });
}
