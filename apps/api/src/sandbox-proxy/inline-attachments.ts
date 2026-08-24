/**
 * Take the file BYTES out of a session's message list.
 *
 * OpenCode's wire shape for an attachment is a file part whose `url` is a
 * `data:<mime>;base64,…` URI — our own shape too, see
 * `apps/web/src/features/session/uploaded-file-refs.ts`. That is fine for ONE
 * message on the way in. It is ruinous on the way out, because every read of
 * the transcript re-ships every byte of every attachment that session ever
 * touched.
 *
 * Measured on a live self-host (essentia, 2026-08-24), an agent run with
 * hundreds of image reads, AFTER the first page was already cut from 50
 * messages to 20:
 *
 *   message?limit=20   200    7,212 kB   23.39 s
 *   message?limit=20   200   13,494 kB   29.23 s
 *   message?limit=20   200   16,931 kB   30.08 s
 *   message?limit=20   200   19,137 kB   30.00 s
 *   message?limit=20   200   15,273 kB   30.00 s
 *   message?limit=20   503                5.29 s
 *
 * Twenty messages weighing 19 MB, several landing exactly on a 30 s deadline,
 * and a retry re-issuing the whole thing. The same read served from the
 * sandbox side in 276 ms — the entire cost is shipping the bytes to the
 * browser.
 *
 * A transcript needs to know an attachment EXISTS, its type and its name. It
 * does not need its bytes until a row is on screen. So the list keeps the part
 * and swaps the payload for a URL that serves those bytes on demand.
 */

/** Below this, inlining is cheaper than a round trip. ~8 KB of base64. */
export const INLINE_ATTACHMENT_MAX_BYTES = 8 * 1024;

export interface StripResult {
  /** The transformed value. Structurally identical apart from swapped urls. */
  value: unknown;
  /** How many parts had their bytes removed. */
  stripped: number;
  /** Bytes removed from the payload. */
  savedBytes: number;
}

function isDataUrl(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('data:');
}

/**
 * Replace oversized `data:` urls in file parts with `makeRef(messageID, partID)`.
 *
 * Deliberately shape-tolerant: it walks whatever it is given and only touches
 * objects that look like a file part with a data url. An unknown payload comes
 * back untouched rather than mangled — this sits in the proxy for EVERY
 * response on this path, so it must never be the reason a read fails.
 */
export function stripInlineAttachmentBytes(
  payload: unknown,
  makeRef: (messageId: string, partId: string) => string,
  maxBytes: number = INLINE_ATTACHMENT_MAX_BYTES,
): StripResult {
  let stripped = 0;
  let savedBytes = 0;

  const walk = (node: unknown, messageId: string | null): unknown => {
    if (Array.isArray(node)) return node.map((item) => walk(item, messageId));
    if (!node || typeof node !== 'object') return node;

    const obj = node as Record<string, unknown>;
    // `{ info: {...}, parts: [...] }` — carry the message id down to the parts.
    const info = obj.info as { id?: unknown } | undefined;
    const nextMessageId =
      info && typeof info.id === 'string'
        ? info.id
        : typeof obj.messageID === 'string'
          ? obj.messageID
          : messageId;

    if (
      obj.type === 'file' &&
      isDataUrl(obj.url) &&
      obj.url.length > maxBytes &&
      typeof obj.id === 'string' &&
      nextMessageId
    ) {
      stripped += 1;
      savedBytes += obj.url.length;
      return { ...obj, url: makeRef(nextMessageId, obj.id) };
    }

    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) out[key] = walk(value, nextMessageId);
    return out;
  };

  return { value: walk(payload, null), stripped, savedBytes };
}
