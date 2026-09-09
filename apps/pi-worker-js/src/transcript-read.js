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

const LEGACY_CELL_ID = /^msg_cell_(\d{1,8})$/;
const WIRE_ID_CLOCK = /^msg_([0-9a-f]{12})[A-Za-z0-9]{14}$/;
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * A legacy `msg_cell_<seq>` id, re-expressed RIGHT AFTER the real id before it.
 *
 * Those ids were minted from a counter and sort after every client id
 * (`msg_<12 hex clock><14 base62>`), so a transcript holding them read user,
 * user, assistant, assistant. The obvious remap — the row's own timestamp in
 * the client's clock — is wrong too: the client mints from ITS clock, lifted
 * past the newest id it knows, and measured on session a46a8c1a 2026-09-09
 * its ids ran ~113 s ahead of the cell's rows, so a wall-time remap sorted
 * every reply before the message it answered. Worse, its second and third
 * user ids were lifted to newest+1 — consecutive clock values with no integer
 * between them.
 *
 * So the clock is not derived at all: the reply borrows the 12 hex of the
 * nearest preceding real id and takes a tail that sorts after any random one
 * (nine `z`, the highest base62 char, then the sequence in base62), which
 * places it after that message and before the next clock value however tight
 * the client packed them. Well-formed by the client's regex, stable across
 * reads, unique per sequence. Nothing live can still reference a legacy id —
 * the stream that used it is long closed — so renaming on read changes no
 * correlation. With no real id before it (never, in a transcript the user
 * opened) the id is left as stored.
 */
export function legacyIdAfter(wireId, anchorId) {
  const m = LEGACY_CELL_ID.exec(wireId ?? "");
  const clock = WIRE_ID_CLOCK.exec(anchorId ?? "");
  if (!m || !clock) return null;
  let n = Number(m[1]), tail = "";
  for (let k = 0; k < 5; k++) { tail = BASE62[n % 62] + tail; n = Math.floor(n / 62); }
  return `msg_${clock[1]}zzzzzzzzz${tail}`;
}

/** The id a message is known by on the wire, else the row number as text. */
export function messageIdFor(row, anchorId = null) {
  const wire = typeof row?.wire_id === "string" ? row.wire_id.trim() : "";
  return legacyIdAfter(wire, anchorId) ?? (wire || String(row.i));
}

/**
 * Rows `{ i, role, json, ts, wire_id? }` → OpenCode `{ info, parts }[]`.
 * Part ids follow the adapter's scheme (`<messageId>-p<index>`) so a part the
 * stream already painted is the same part here.
 */
export function transcriptMessages(rows, sessionId) {
  const out = [];
  // The nearest real wire id so far, in stored (chronological) order — what a
  // legacy id is placed after. A remapped id is not itself an anchor: two
  // replies in one turn both hang off the same user message, in sequence.
  let anchor = null;
  for (const r of rows ?? []) {
    let parsed = {};
    try { parsed = JSON.parse(r.json); } catch { /* a row we cannot read is still a row */ }
    const id = messageIdFor(r, anchor);
    if (WIRE_ID_CLOCK.test(id) && !LEGACY_CELL_ID.test(String(r.wire_id ?? "")) ) anchor = id;
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
