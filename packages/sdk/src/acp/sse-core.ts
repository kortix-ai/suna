import type { AcpEnvelope, AcpResponse } from './types';

/**
 * A single complete SSE block, already split into its `id:`/`data:` fields —
 * exactly as `AcpClient`'s `consumeSse` has always parsed them:
 *   - `id` is `Number(...)` of the value after the LAST `id:` line in the
 *     block (an earlier `id:` line, if any, is overwritten — matches the
 *     original single-variable-reassignment-in-a-loop behavior), or `null`
 *     if the block has no `id:` line at all.
 *   - `data` is every `data:` line's value, in source order, with the SSE
 *     single-leading-space convention stripped (`"data: X"` -> `"X"`,
 *     `"data:X"` -> `"X"`). Lines are NOT joined here — callers join with
 *     `'\n'` when they need the raw payload, matching `consumeSse`'s
 *     `data.join('\n')` before `JSON.parse`.
 * A block with no `id:` or no `data:` lines at all (e.g. a bare `: comment`
 * keepalive line) still produces an `SseBlock`, just with `id: null` and/or
 * an empty `data` array — see `isDeliverableSseBlock`.
 */
export type SseBlock = {
  id: number | null;
  data: string[];
};

/**
 * Stateful incremental SSE block parser. Feed it raw chunks exactly as
 * delivered by `ReadableStreamDefaultReader.read()` — `chunk` may be
 * `undefined` on the terminal `done` read, matching `TextDecoder.decode`'s
 * own accepted input — and it returns every complete `\n\n`-delimited block
 * that became available from this push, having already:
 *
 *   - decoded bytes with a single `TextDecoder` instance held for the
 *     lifetime of the parser (`stream: true` between non-final reads), so a
 *     multi-byte UTF-8 codepoint split across a chunk boundary decodes
 *     correctly instead of producing replacement characters;
 *   - normalized CRLF and lone CR to LF;
 *   - held back a chunk-final lone `\r` (not normalizing it yet) so a
 *     `\r\n\r\n` block terminator split at ANY point — including split
 *     between the two `\r\n` pairs, or between the `\r` and `\n` of either
 *     pair — is never misread as extra/fewer blank lines than the sender
 *     intended;
 *   - on the terminal `done` push, synthesized a trailing `\n\n` if the
 *     buffer still holds an unterminated block (a finite response can close
 *     immediately after the last event's newline instead of sending a final
 *     blank line);
 *   - extracted `id:`/`data:` fields per block.
 *
 * This is a lossless, behavior-preserving extraction of logic that
 * previously lived inline in `AcpClient`'s module-private `consumeSse` — see
 * `packages/sdk/PROGRESS.md` / the WS3-P0-a report for the parity pins that
 * prove it. It does not interpret `id`/`data` any further (no JSON parsing,
 * no deliverability check) — see `isDeliverableSseBlock` for that.
 */
export function createSseBlockParser(): {
  push(chunk: Uint8Array | undefined, done: boolean): SseBlock[];
} {
  const decoder = new TextDecoder();
  let buffer = '';
  return {
    push(chunk, done) {
      buffer += decoder.decode(chunk, { stream: !done });
      let holdback = '';
      if (!done && buffer.endsWith('\r')) {
        holdback = '\r';
        buffer = buffer.slice(0, -1);
      }
      buffer = buffer.replace(/\r\n|\r/g, '\n');
      // A finite test/server response may close immediately after the final
      // event's terminating newline instead of sending another blank line.
      if (done && buffer.trim()) buffer += '\n\n';
      const blocks: SseBlock[] = [];
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        let id: number | null = null;
        const data: string[] = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('id:')) id = Number(line.slice(3).trim());
          else if (line.startsWith('data:')) data.push(line.startsWith('data: ') ? line.slice(6) : line.slice(5));
        }
        blocks.push({ id, data });
      }
      buffer += holdback;
      return blocks;
    },
  };
}

/**
 * Whether a parsed `SseBlock` carries a deliverable stream event: a
 * safe-integer `id` and at least one `data:` line. Mirrors the exact guard
 * `consumeSse` has always used before attempting to `JSON.parse` a block's
 * payload — blocks that fail this (keepalive comments, blocks missing
 * `id:`, blocks with `id:` but no `data:`) are silently skipped, never
 * reported via `onParseError`/`onError`. JSON validity of `data` itself is
 * NOT checked here — a block can pass this guard and still fail to parse as
 * JSON (a "poison" event); that failure is the caller's concern.
 */
export function isDeliverableSseBlock(block: SseBlock): block is { id: number; data: string[] } {
  return block.id !== null && Number.isSafeInteger(block.id) && block.data.length > 0;
}

/**
 * `AcpEnvelope` shape guard for a JSON-RPC response: carries `id` and
 * (`result` or `error`), and is NOT also a request/notification (no
 * `method`). Moved verbatim from `AcpClient`'s module-private `isResponse` —
 * same logic. `request()` uses this to distinguish a response envelope from
 * a request/notification the far end may have sent instead.
 */
export function isAcpResponseEnvelope(value: AcpEnvelope): value is AcpResponse {
  return 'id' in value && ('result' in value || 'error' in value) && !('method' in value);
}
