// Inline attachment bytes out of transcript reads, exactly as kortixd does
// (harness/shared/inline-attachments.ts): a `file` part whose data URL is
// larger than 8 KiB is answered with a `/kortix/part/<session>/<msg>/<part>`
// reference the client fetches on its own, so a transcript page stays small.

export const INLINE_ATTACHMENT_MAX_BYTES = 8 * 1024;

export function stripInlineAttachmentBytes(payload, makeRef, maxBytes = INLINE_ATTACHMENT_MAX_BYTES) {
  let stripped = 0;
  let savedBytes = 0;
  const walk = (node, messageId) => {
    if (Array.isArray(node)) return node.map((item) => walk(item, messageId));
    if (!node || typeof node !== "object") return node;
    const next = typeof node.info?.id === "string" ? node.info.id : typeof node.messageID === "string" ? node.messageID : messageId;
    if (node.type === "file" && typeof node.id === "string" && next && typeof node.url === "string" && node.url.startsWith("data:") && node.url.length > maxBytes) {
      stripped += 1;
      savedBytes += node.url.length;
      return { ...node, url: makeRef(next, node.id) };
    }
    const out = {};
    for (const [key, value] of Object.entries(node)) out[key] = walk(value, next);
    return out;
  };
  return { value: walk(payload, null), stripped, savedBytes };
}

/** `data:<mime>;base64,<bytes>` decoded, or null. */
export function decodeDataUrl(url) {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(String(url ?? ""));
  if (!m) return null;
  return { mime: m[1], bytes: Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0)) };
}
