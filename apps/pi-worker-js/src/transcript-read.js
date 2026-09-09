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

// The wire-id clock (apps/api projects/wire-message-id.ts): milliseconds,
// backdated and scaled, 48 bits, hex. Repeated here rather than imported so
// this module stays importable under plain node for its claims.
const WIRE_ID_BACKDATE_MS = 2 * 60 * 1000;
const WIRE_ID_TIME_SCALE = 0x1000n;
const WIRE_ID_TIME_MASK = 0xffffffffffffn;
const LEGACY_CELL_ID = /^msg_cell_(\d{1,8})$/;

/**
 * A legacy `msg_cell_<seq>` id, re-expressed where it happened in time.
 *
 * Those ids were minted from a counter and sort after every client id
 * (`msg_<time>…`), so a transcript that holds them reads user, user,
 * assistant, assistant. The rows keep their stored id; the READ names them by
 * the row's own timestamp, in the same 12-hex clock the client sorts on, with
 * the sequence folded into a fixed tail so the mapping is stable and unique.
 * Nothing live can still reference a legacy id — the stream that used it is
 * long closed — so renaming on read changes no correlation.
 */
export function sortableLegacyId(wireId, ts) {
  const m = LEGACY_CELL_ID.exec(wireId ?? "");
  if (!m || !Number.isFinite(ts)) return null;
  const encoded = ((BigInt(Math.trunc(ts) - WIRE_ID_BACKDATE_MS) * WIRE_ID_TIME_SCALE) & WIRE_ID_TIME_MASK)
    .toString(16).padStart(12, "0");
  return `msg_${encoded}cell${m[1].padStart(10, "0")}`;
}

/** The id a message is known by on the wire, else the row number as text. */
export function messageIdFor(row) {
  const wire = typeof row?.wire_id === "string" ? row.wire_id.trim() : "";
  return sortableLegacyId(wire, row?.ts) ?? (wire || String(row.i));
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
    // THE TRANSCRIPT HIDES WHAT THE STREAM HIDES. The bus drops reasoning
    // (wire.js isReasoning) because the product does not show it; a transcript
    // that returns it — even typed `reasoning` — is painted by the chat as an
    // assistant bubble. Measured on dev 2026-09-09, session 3efeb3f1: the user
    // saw their own words inside an assistant answer, which was the model's
    // 'The user said "yooooo"…' reasoning block. The part keeps its index so
    // `<id>-p<k>` still matches what the stream named.
    out.push({
      info: { id, role: r.role, sessionID: sessionId, time: { created: r.ts } },
      parts: content.map((c, k) => [c, k]).filter(([c]) => partType(c?.type) !== "reasoning").map(([c, k]) => ({
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
