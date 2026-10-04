import {
  REDACTED,
  SAFE_RESPONSE_HEADERS,
  SecretBrokerError,
  secretRepresentations,
  encodeSecretRepresentation,
  type SecretSubstitution,
} from './http-broker';
import type { StreamSubstituter, StreamReplacement } from './stream-substitute';

/**
 * The largest guest body still handled with the buffered, EXACT-LENGTH path.
 *
 * 64 KiB keeps today's behaviour byte-for-byte for the overwhelmingly common
 * small JSON POST: an exact `content-length` (which SigV4-style signers and a
 * few chunked-hostile origins require), a replayable body (so an ordinary
 * redirect still works), and the full body available to the handle-refusal
 * classifier. Above it, framing switches to chunked and the body streams.
 *
 * Raising this raises memory per in-flight request; it does NOT re-introduce a
 * cap, because the streaming path above it has none.
 */
export const RELAY_EXACT_LENGTH_MAX = 65_536;

/**
 * Read at most `limit` bytes, refusing the instant byte `limit + 1` arrives.
 *
 * `new Response(stream).arrayBuffer()` CANNOT be used here. It buffers whatever
 * the guest actually sends, and the guest's declared `meta.body.length` — the
 * only reason this branch believes the body is small — is an assertion by the
 * caller, not a fact. Measured on bun 1.3.14 there is no ambient ceiling to
 * fall back on either: `Bun.serve` applies no `maxRequestBodySize` to a chunked
 * (no `content-length`) request body, `index.ts` sets none, and this route is
 * exempt from both the 25 s request deadline (`request-deadline.ts`) and Bun's
 * per-request timeout (`server.timeout(req, 0)`). So an unbounded read here has
 * neither a memory nor a time budget, and one request could OOM the shared API
 * pod. The counter is the only guard, exactly as on the transport's own loops.
 */
export async function readAtMost(stream: ReadableStream<Uint8Array>, limit: number): Promise<Buffer> {
  const reader = stream.getReader();
  const parts: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > limit) {
        throw new SecretBrokerError(
          'relay_request_too_large',
          `request body exceeds its declared length of ${limit} bytes`,
          413,
        );
      }
      // COPY: the reader may reuse the backing ArrayBuffer, and this buffer
      // outlives the read loop. Cheap — this branch is bounded at 64 KiB.
      parts.push(Buffer.from(value));
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The stream is already gone; nothing to release.
    }
    reader.releaseLock();
  }
  return Buffer.concat(parts);
}

/**
 * How much of a STREAMED request body is kept for the handle-refusal
 * classifier.
 *
 * 64 KiB, matching the buffered branch's threshold, so the forensic surface is
 * the same size on every branch. It is a PREFIX and not the whole body on
 * purpose: the point of this route is that a body has no size ceiling, and a
 * classifier that had to see all of it would put one back.
 */
export const RELAY_CLASSIFY_PREFIX_MAX = 65_536;

/**
 * Tee a bounded PREFIX out of a passing stream, without holding the body.
 *
 * The handle-refusal classifier is a detection control: it is what writes the
 * `secret.handle.refused` audit line when an agent presents a handle it was
 * never granted. It used to be fed only the URL, the headers, and — on the
 * buffered branch alone — the body. Both streaming branches left the body
 * unscanned, and the attacker CHOOSES the branch (declare `length: null`, or
 * target a host it holds no handle for). A detection control an attacker can
 * switch off is not a detection control. Substitution stays fail-closed either
 * way; this restores the forensic line.
 */
export function tapPrefix(
  limit: number,
  onEnd: (prefix: Buffer) => void,
): TransformStream<Uint8Array, Uint8Array> {
  const parts: Buffer[] = [];
  let total = 0;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (total < limit && chunk.byteLength > 0) {
        const take = Math.min(limit - total, chunk.byteLength);
        // COPY: this outlives the chunk, whose backing buffer may be reused.
        parts.push(Buffer.from(chunk.subarray(0, take)));
        total += take;
      }
      controller.enqueue(chunk);
    },
    flush() {
      onEnd(Buffer.concat(parts));
    },
  });
}

/**
 * Turn substitutions into stream find/replace pairs.
 *
 * The same four representations `substituteBuffer` uses, in the same order, so
 * the streaming and buffered bodies substitute identically. `primary` resolves
 * the ambiguity a handle's URL-safe alphabet creates: raw / url / json collapse
 * to the same bytes, and which one we WRITE BACK depends on the surface.
 */
export function requestPairs(
  admitted: readonly SecretSubstitution[],
  primary: Parameters<typeof secretRepresentations>[1],
): StreamReplacement[] {
  const pairs: StreamReplacement[] = [];
  for (const substitution of admitted) {
    for (const { encoding, text } of secretRepresentations(substitution.handle, primary)) {
      pairs.push({
        needle: Buffer.from(text),
        replacement: Buffer.from(encodeSecretRepresentation(substitution.value, encoding)),
        label: substitution.identifier,
      });
    }
  }
  return pairs;
}

/**
 * Redaction pairs for the RETURN leg.
 *
 * Deliberately built from every value that COULD have ridden out, not only the
 * ones a substitution actually fired for. On a streamed body the `applied` set
 * is not final until the stream ends — long after the redactor must be built —
 * so the choice is between fail-open and a superset. It is a superset: at worst
 * a value that never left is also scrubbed on the way back, which costs
 * nothing and cannot leak.
 */
export function responsePairs(secrets: readonly string[]): StreamReplacement[] {
  const pairs: StreamReplacement[] = [];
  const seen = new Set<string>();
  for (const secret of secrets) {
    for (const { text } of secretRepresentations(secret)) {
      if (!text || seen.has(text)) continue;
      seen.add(text);
      pairs.push({ needle: Buffer.from(text), replacement: Buffer.from(REDACTED) });
    }
  }
  return pairs;
}

/**
 * Wrap a substituter as a `TransformStream`.
 *
 * `pipeThrough(new TransformStream(...))` rather than a hand-rolled
 * `new ReadableStream({ start() { …read loop… } })`: the hand-rolled version
 * reads the source as fast as it can and enqueues without consulting
 * `desiredSize`, which is the classic backpressure leak. Measured at 256 MiB,
 * the TransformStream grew the warm heap by 6 MB against the read loop's
 * 109 MB.
 */
export function substituteStream(
  substituter: StreamSubstituter,
  /**
   * Appended after the substituter's own tail, on a CLEAN end only.
   *
   * This is the end-of-stream sentinel. `flush()` runs only when the writable
   * side closes normally — measured: when the source errors, `flush()` is never
   * invoked — so the sentinel is present exactly when the body completed.
   */
  tail?: Buffer,
  /** Runs after a clean flush, with the substituter's final `applied` set. */
  onComplete?: (applied: readonly string[]) => void,
): TransformStream<Uint8Array, Uint8Array> {
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      // Zero-copy view: `Buffer.from(uint8array)` would COPY every chunk.
      const view = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      const out = substituter.push(view);
      if (out.byteLength > 0) controller.enqueue(out);
    },
    flush(controller) {
      const out = substituter.flush();
      if (out.byteLength > 0) controller.enqueue(out);
      const applied = substituter.applied;
      if (tail && tail.byteLength > 0) controller.enqueue(new Uint8Array(tail));
      // A long-lived relay holds decrypted values for the life of the
      // connection. Zero them the moment it ends. NOTE: this is not the only
      // disposal site — `flush()` does not run on an abnormal end, so the route
      // also disposes on abort and in its catch block.
      substituter.dispose();
      onComplete?.(applied);
    },
  });
}

/** The whitelisted response headers, ordered, each echo-redacted. */
export function safeResponseHeaders(
  rawHeaders: ReadonlyArray<readonly [string, string]>,
  secrets: readonly string[],
): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [name, value] of rawHeaders) {
    if (!SAFE_RESPONSE_HEADERS.has(name)) continue;
    let redacted = value;
    for (const secret of secrets) {
      for (const { text } of secretRepresentations(secret)) {
        if (text) redacted = redacted.split(text).join(REDACTED.toString('utf8'));
      }
    }
    out.push([name, redacted]);
  }
  return out;
}

// ── Disposal, tied to REQUEST LIFETIME rather than to a clean flush ────
//
// `substituteStream`'s `flush()` is the natural place to zero a
// substituter's decrypted bytes, but a `TransformStream` flush runs ONLY on
// a clean close of the writable side — measured: when the source errors it
// is never invoked. So every abnormal end (upstream idle timeout, byte
// budget, guest abort, a throw between building a substituter and handing
// it to the transport) used to leave the value un-zeroed until GC. These
// two hooks close that window; `flush()` still handles the happy path and
// `dispose()` is idempotent.
export function createRelayDisposables(requestSubstituter: StreamSubstituter, signal?: AbortSignal) {
  const disposables = new Set<StreamSubstituter>([requestSubstituter]);
  const disposeAll = () => {
    for (const substituter of disposables) substituter.dispose();
    disposables.clear();
  };
  signal?.addEventListener('abort', disposeAll, { once: true });
  return { disposables, disposeAll };
}
