// THE TRANSCRIPT, IN THE IDS THE WIRE USED.
//
// The web client paints a message when it arrives on the stream and again
// when it reads the transcript, and it tells the two apart by id. The stream
// names a user message by the `messageID` the client sent and an assistant
// message by the id the adapter minted (`msg_cell_00000001`, parts `-p0`,
// `-p1`); the transcript read used the row NUMBER. Measured on dev 2026-09-09,
// session 5192652f: the poll answered `user 1`, `assistant 2` for messages the
// stream had painted as `msg_0879…` and `msg_cell_00000001` — so every message
// showed twice.
//
// The same read exposed pi's `thinking` block as a part of type `thinking`.
// The wire maps it to `reasoning`, which the SDK hides unless asked
// (packages/sdk/src/transcript.ts); a `thinking` part is not hidden, so the
// model's reasoning was painted as an answer on this path too.
//
// Pure over rows, so both are asserted without a cell.

/** A stored content block, as the client expects to see it. */
export function partType(blockType) {
  if (blockType === "thinking" || blockType === "reasoning") return "reasoning";
  if (blockType == null || blockType === "text") return "text";
  return String(blockType);
}

/** The id a message is known by on the wire, else the row number as text. */
export function messageIdFor(row) {
  const wire = typeof row?.wire_id === "string" ? row.wire_id.trim() : "";
  return wire || String(row.i);
}

/**
 * Rows `{ i, role, json, ts, wire_id? }` → OpenCode `{ info, parts }[]`.
 * Part ids follow the adapter's scheme (`<messageId>-p<index>`) so a part the
 * stream already painted is the same part here.
 */
export function transcriptMessages(rows, sessionId) {
  const out = [];
  for (const r of rows ?? []) {
    let parsed = {};
    try { parsed = JSON.parse(r.json); } catch { /* a row we cannot read is still a row */ }
    const id = messageIdFor(r);
    const content = Array.isArray(parsed?.content) ? parsed.content : [];
    out.push({
      info: { id, role: r.role, sessionID: sessionId, time: { created: r.ts } },
      parts: content.map((c, k) => ({
        id: `${id}-p${k}`,
        messageID: id,
        sessionID: sessionId,
        type: partType(c?.type),
        ...(c?.text != null ? { text: c.text } : {}),
        // A thinking block carries its text under `thinking`; the wire's
        // reasoning part carries text under `text`. Same field on the way out.
        ...(c?.text == null && typeof c?.thinking === "string" ? { text: c.thinking } : {}),
      })),
    });
  }
  return out;
}
