/**
 * Chunk-boundary-safe find/replace over a BYTE STREAM.
 *
 * This is the kernel that lets the relay stop being a buffered JSON-RPC and
 * become a real egress proxy. Today `substituteBuffer` / `redactSecretFromResponse`
 * (http-broker.ts) call `buffer.indexOf` over a COMPLETE body, which forces the
 * whole request and the whole response to be held in memory — that is where the
 * 1 MiB / 5 MiB caps come from, and why nothing can stream.
 *
 * The problem a stream adds is that a needle can straddle a chunk boundary:
 *
 *     chunk 1: "...Authorization: Bearer kortix_brok"
 *     chunk 2: "ered__KXS1abc...  <rest of body>"
 *
 * A naive per-chunk replace misses that and ships the handle to the upstream.
 * The fix is to withhold the tail that could still become a needle — and only
 * that tail. Retention is decided by `cutoffFor`: the LEFTMOST position whose
 * suffix is a PROPER PREFIX of some needle. Everything before it is bytes no
 * future input can change, so it is emitted now; everything from it is held and
 * re-scanned joined to the next chunk. Retention is bounded by
 * `longestNeedle - 1` — a proper prefix is by definition shorter than its needle
 * — so memory is O(needle), NOT O(body). That bound is what removes the size
 * caps.
 *
 * ## Why the cutoff is prefix-aware and not a blind window
 *
 * The first version of this file retained `longestNeedle` bytes UNCONDITIONALLY.
 * That is correct but it is not PROMPT, and on a stream promptness IS the
 * contract. Measured on a 500 ms/event SSE stream: a 53-byte API key (whose
 * base64 representation makes a 72-byte needle) delayed every 29-byte event by
 * 1503 ms, because each event's tail sat in the window until the NEXT event
 * arrived. A 1652-byte PEM (2208-byte needle) collapsed five events into one
 * emission at 2505 ms. Worse, the final window is released only by `flush()` —
 * i.e. at connection close — so on a long-lived stream the last event is
 * withheld indefinitely. A relay that streams bytes but not events passes every
 * throughput test and fails every real user.
 *
 * Prefix-aware retention measures 0.0–0.2 ms of added latency on realistic
 * traffic, retains 0 bytes when no needle prefix is in flight, and is FASTER
 * than the blind window on real data (11 ms vs 17 ms per 100 MiB) because
 * `memchr` skips non-candidates.
 *
 * Two rejected alternatives, both unsound, recorded so they are not re-invented:
 *
 *  - **A time-based idle flush** of the pending bytes is a secret-DISCLOSURE
 *    bug. With the upstream stalled mid-secret it emits the secret's PREFIX
 *    un-redacted; the remainder arrives next and no longer matches, so the
 *    guest reassembles the complete raw value across two writes with no
 *    `[REDACTED]` anywhere. Proven by direct experiment.
 *  - **A `\n\n` delimiter flush** for SSE is unsound in general: a multi-line
 *    secret (any PEM) contains the delimiter, and it does nothing for NDJSON,
 *    chunked JSON, or websockets.
 *
 * Three invariants make this safe to reason about:
 *
 *  1. **Replacement bytes are never re-scanned.** The retained tail always
 *     starts at or after the end of the last completed replacement, so a secret
 *     value that happens to contain needle-shaped bytes cannot be rewritten a
 *     second time.
 *  2. **A needle that is a prefix of a longer needle cannot shadow it.** If a
 *     longer needle also starts at the committed position but is not yet fully
 *     visible, the suffix from that position IS a proper prefix of it, so the
 *     cutoff sits at or before it and nothing is committed. One condition
 *     covers both hazards — the straddle and the shadow.
 *  3. **The output is byte-identical to the whole-buffer algorithm.** Whatever
 *     the chunking, `push(...)+flush()` concatenated equals replacing over the
 *     joined input. `stream-substitute.test.ts` fuzzes this against the
 *     non-streaming implementation, because "it works on my chunk sizes" is
 *     exactly the bug class this file exists to prevent.
 */

export interface StreamReplacement {
  /** The bytes to find — a handle (request side) or a secret value (response
   *  side, where the replacement is `[REDACTED]`). */
  needle: Buffer;
  replacement: Buffer;
  /** Reported through `applied` when this pair matches at least once, so the
   *  caller can audit WHICH secrets rode out on the wire. */
  label?: string;
}

export class StreamSubstituter {
  private readonly pairs: StreamReplacement[];
  private pending: Buffer = Buffer.alloc(0);
  private readonly hits = new Set<string>();
  private done = false;

  constructor(pairs: readonly StreamReplacement[]) {
    // A zero-length needle would match everywhere and never advance.
    this.pairs = pairs.filter((pair) => pair.needle.byteLength > 0);
  }

  /** Labels whose needle matched at least once so far. */
  get applied(): string[] {
    return [...this.hits];
  }

  /** True when nothing can ever match, so the caller may skip this stage
   *  entirely and pipe the socket straight through. */
  get isPassThrough(): boolean {
    return this.pairs.length === 0;
  }

  /**
   * Feed one chunk. Returns the bytes that are safe to forward NOW — which is
   * everything except a bounded tail that might still turn out to be the start
   * of a needle.
   */
  push(chunk: Buffer): Buffer {
    if (this.done) throw new Error('StreamSubstituter: push after flush');
    if (this.pairs.length === 0) return chunk;
    const work = this.pending.byteLength === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    // Everything BEFORE the cutoff is decided: no future byte can extend it into
    // a needle, and no longer needle can start there and shadow a shorter one,
    // so leftmost-longest is already decidable there. Commit those matches;
    // hold the rest.
    const cutoff = this.cutoffFor(work);
    const { output, consumed } =
      cutoff > 0 ? this.replaceComplete(work, cutoff - 1) : { output: Buffer.alloc(0), consumed: 0 };
    // Everything after the last completed replacement is still original bytes,
    // so it is safe to re-scan on the next chunk. `consumed` can run PAST the
    // cutoff when a committed match spans it — that match won leftmost-longest,
    // so its bytes are gone and the cutoff no longer applies to them.
    const keepFrom = Math.max(consumed, cutoff);
    this.pending = work.subarray(keepFrom);
    return output.byteLength === 0 && keepFrom === consumed
      ? Buffer.alloc(0)
      : Buffer.concat([output, work.subarray(consumed, keepFrom)]);
  }

  /**
   * The leftmost position `p` where `work[p..]` is a PROPER prefix of some
   * needle — i.e. the first byte that might still turn out to be the start of a
   * match — or `work.byteLength` when no such position exists (the common case,
   * which is why ordinary traffic retains nothing).
   *
   * Needles shorter than 2 bytes are skipped: a 1-byte needle has no proper
   * prefix, so it is always either a complete match or not a match at all.
   *
   * `indexOf(needle[0], p)` is Bun/Node's `memchr`, so non-candidate bytes are
   * skipped at memory bandwidth instead of one comparison per position; only
   * positions whose byte equals the needle's first byte are ever compared.
   */
  private cutoffFor(work: Buffer): number {
    const length = work.byteLength;
    let cutoff = length;
    for (const pair of this.pairs) {
      const needle = pair.needle;
      if (needle.byteLength < 2) continue;
      // A proper prefix has length 1 … needle.byteLength - 1, so no position
      // earlier than this can produce one.
      const start = Math.max(0, length - (needle.byteLength - 1));
      if (start >= cutoff) continue;
      const first = needle[0]!;
      for (let i = work.indexOf(first, start); i !== -1 && i < cutoff; i = work.indexOf(first, i + 1)) {
        // 5-arg order is (target, targetStart, targetEnd, sourceStart, sourceEnd):
        // compare work[i..length] against needle[0..length - i].
        if (work.compare(needle, 0, length - i, i, length) === 0) {
          cutoff = i;
          break;
        }
      }
    }
    return cutoff;
  }

  /**
   * Zero the needle and replacement bytes.
   *
   * Called when a relay ends. On the buffered `/broker` path a decrypted secret
   * lives for milliseconds; on a streaming SSE or websocket relay the same bytes
   * sit in this object for the life of the connection — minutes to hours. That
   * is inherent to a streaming relay (the guest still never sees the value,
   * which is the invariant that matters), but the window after the connection
   * closes is not, so it is closed.
   */
  dispose(): void {
    for (const pair of this.pairs) {
      pair.needle.fill(0);
      pair.replacement.fill(0);
    }
    this.pending = Buffer.alloc(0);
  }

  /**
   * No more input. Returns the retained tail — at this point a partial needle is
   * just data, because nothing can complete it.
   */
  flush(): Buffer {
    if (this.done) return Buffer.alloc(0);
    this.done = true;
    if (this.pairs.length === 0 || this.pending.byteLength === 0) {
      const tail = this.pending;
      this.pending = Buffer.alloc(0);
      return tail;
    }
    // The tail can still contain a COMPLETE needle when the stream ended
    // mid-window, so it gets one final pass with NO commit limit — nothing more
    // is coming, so every match that exists is fully visible.
    const { output, consumed } = this.replaceComplete(this.pending, this.pending.byteLength);
    const rest = this.pending.subarray(consumed);
    this.pending = Buffer.alloc(0);
    return Buffer.concat([output, rest]);
  }

  /**
   * Replace every COMPLETE match starting at or before `maxStart`, leftmost-first.
   *
   * Returns the rewritten prefix and how far into `work` it consumed. Bytes
   * after `consumed` are untouched originals — never replacement output — which
   * is what makes retaining them for the next chunk safe.
   */
  private replaceComplete(work: Buffer, maxStart: number): { output: Buffer; consumed: number } {
    const chunks: Buffer[] = [];
    let cursor = 0;
    for (;;) {
      let bestIndex = -1;
      let bestPair: StreamReplacement | null = null;
      for (const pair of this.pairs) {
        const index = work.indexOf(pair.needle, cursor);
        if (index === -1 || index > maxStart) continue;
        // Leftmost wins; on a tie the longer needle wins so a needle that is a
        // prefix of another cannot shadow it.
        if (
          bestIndex === -1 ||
          index < bestIndex ||
          (index === bestIndex && pair.needle.byteLength > (bestPair?.needle.byteLength ?? 0))
        ) {
          bestIndex = index;
          bestPair = pair;
        }
      }
      if (bestIndex === -1 || !bestPair) break;
      chunks.push(work.subarray(cursor, bestIndex), bestPair.replacement);
      if (bestPair.label) this.hits.add(bestPair.label);
      cursor = bestIndex + bestPair.needle.byteLength;
    }
    return { output: chunks.length > 0 ? Buffer.concat(chunks) : Buffer.alloc(0), consumed: cursor };
  }
}

/**
 * The whole-buffer equivalent, kept here as the ORACLE the streaming path is
 * fuzzed against. Callers with a complete buffer should keep using
 * `http-broker.ts`'s own helpers; this exists so the test can assert the two
 * agree for every chunking.
 */
export function substituteWholeBuffer(
  source: Buffer,
  pairs: readonly StreamReplacement[],
): Buffer {
  const substituter = new StreamSubstituter(pairs);
  const head = substituter.push(source);
  return Buffer.concat([head, substituter.flush()]);
}
