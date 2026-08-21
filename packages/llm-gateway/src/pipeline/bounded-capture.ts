/**
 * Two primitives for handling bodies WITHOUT holding a copy of them.
 *
 * Both exist because of a real outage. On 2026-08-21 the dev API was
 * OOM-killed three times in eleven minutes (`exit 137`,
 * "OutOfMemoryError: container killed due to memory usage") during an
 * image-heavy agent session, and the browser was handed Cloudflare's
 * "Bad Gateway" page. The gateway runs IN-PROCESS inside the API
 * (`apps/api/src/index.ts` → `mountLlmGateway`), so a single request held,
 * simultaneously:
 *
 *   1. `rawBody` as a UTF-16 JS string             (~2x the wire bytes)
 *   2. `new TextEncoder().encode(rawBody)`         (a full second copy, made
 *                                                   only to measure length)
 *   3. the `JSON.parse` object graph               (another full copy)
 *   4. an UNBOUNDED `preview` string that grew with every streamed chunk
 *      for the whole life of the response
 *
 * Memory was therefore `O(payload x concurrency)` with payload unbounded —
 * which is precisely the shape autoscaling cannot control. Autoscaling sets
 * concurrency; it has no lever on the size of one request. Bounding these two
 * terms is what makes the service scalable at all.
 */

/**
 * UTF-8 byte length WITHOUT allocating the encoded bytes.
 *
 * Replaces `new TextEncoder().encode(s).byteLength`, which built a whole
 * Uint8Array copy of every request body purely to read `.byteLength` off it
 * and then discard it. Same answer, no allocation.
 *
 * Surrogate handling matches `TextEncoder` exactly, including the lone-surrogate
 * case: an unpaired surrogate is encoded as U+FFFD, which is 3 bytes — the same
 * width as the surrogate's own code point would occupy here, so counting it as
 * 3 needs no special case.
 */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      // A well-formed surrogate PAIR is one 4-byte code point; consume both
      // halves. An unpaired high surrogate falls through to 3 (U+FFFD).
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

export interface BoundedCaptureOptions {
  /** Characters retained from the START of the body. */
  headChars: number;
  /** Characters retained from the END of the body. */
  tailChars: number;
}

/**
 * A capture buffer that keeps the head and the tail of a body and forgets the
 * middle, retaining `headChars + tailChars + marker` no matter how much passes
 * through it.
 *
 * WHY A CAP AT ALL — this deliberately overturns a previous decision, so it
 * owes an argument. The old code kept the response in full, with the note:
 * "Not capped: a log that shows less than what the gateway actually relayed to
 * the client is a log that lies." The intent is right; the mechanism defeated
 * it. An unbounded capture does not produce a complete log — it produces a
 * dead container, and a dead container loses the trace it was protecting along
 * with every other request in flight. A bounded capture that states the true
 * total and exactly how much it omitted tells the reader strictly more than a
 * trace that was never written.
 *
 * Head AND tail, not just head: for an SSE relay the final frames carry the
 * finish reason and the usage totals, which is normally the part a reader is
 * looking for.
 */
export class BoundedCapture {
  private head = '';
  private tail = '';
  private readonly headChars: number;
  private readonly tailChars: number;
  /** Total characters pushed, including everything dropped. */
  totalChars = 0;

  constructor(options: BoundedCaptureOptions) {
    this.headChars = Math.max(0, Math.trunc(options.headChars));
    this.tailChars = Math.max(0, Math.trunc(options.tailChars));
  }

  /** Did anything get dropped? */
  get truncated(): boolean {
    return this.totalChars > this.head.length + this.tail.length;
  }

  push(chunk: string): void {
    if (!chunk) return;
    this.totalChars += chunk.length;

    let rest = chunk;
    if (this.head.length < this.headChars) {
      const room = this.headChars - this.head.length;
      this.head += rest.slice(0, room);
      rest = rest.slice(room);
      if (!rest) return;
    }
    if (this.tailChars > 0) {
      // Sliding window: only the last `tailChars` can ever survive, so the
      // concatenation below is bounded by `tailChars + chunk.length` and is
      // immediately trimmed back down.
      this.tail = (this.tail + rest).slice(-this.tailChars);
    }
  }

  /**
   * The retained body. Byte-for-byte exact when nothing was dropped; otherwise
   * head + an explicit marker naming the true total + tail.
   */
  value(): string {
    if (!this.truncated) return this.head + this.tail;
    const omitted = this.totalChars - this.head.length - this.tail.length;
    const marker =
      `\n…[kortix-gateway] response truncated for the trace: ` +
      `${omitted} of ${this.totalChars} characters omitted; ` +
      `head ${this.head.length} + tail ${this.tail.length} retained…\n`;
    return this.head + marker + this.tail;
  }
}

/**
 * Defaults for the streamed-response trace.
 *
 * 64 KiB of head is far more than the diagnostic value of an SSE stream's
 * opening (role, first content frames, tool-call names), and 16 KiB of tail
 * comfortably covers the finish reason and usage totals. Together with the
 * marker this is a few tens of KiB per in-flight request instead of the full
 * response — the difference between memory that tracks concurrency and memory
 * that tracks how much the model felt like saying.
 */
export const CAPTURED_RESPONSE_HEAD_CHARS = 64 * 1024;
export const CAPTURED_RESPONSE_TAIL_CHARS = 16 * 1024;
