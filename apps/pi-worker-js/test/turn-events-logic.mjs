// THE LIVE STREAM A CLIENT RENDERS, FROM pi-durable's EVENTS.
//
// A client builds a streaming block from the `message.part.updated` snapshot
// it saw first, then appends every `message.part.delta`. So the snapshot plus
// the deltas must spell the whole block. pi-durable reports `message_start`
// from the first commit that holds the partial message, which already carries
// the first chunk; the translator dropped it, and every reply on pi-js lost its
// opening characters (2026-10-06: ", let me re-read.").
//
// Pure: synthetic events in, frames out.
// EXPECTED_PASSES=6

import { watchClaims } from "../../tools/crash-reporter.mjs";

let bad = 0, claims = 0;
const check = watchClaims((n, c, d = "") => { claims++; if (c) console.log(`  ok    ${n}`); else { console.log(`  FAIL  ${n}${d ? `\n          ${d}` : ""}`); bad++; } });
const { DurableTurnEvents } = await import("../src/kortix/turn-events.js");

let n = 0;
const translator = () => new DurableTurnEvents({
  sessionID: "ses_x", workspace: "/workspace", mintMessageId: () => `msg_${++n}`, parentMessageId: () => "msg_user",
  model: () => ({ providerID: "kortix", modelID: "m" }), agent: () => "kortix",
});
/** What a client shows: the first snapshot of each part, then its deltas appended; a later snapshot without deltas replaces. */
function render(frames) {
  const parts = new Map();
  for (const f of frames) {
    if (f.transcriptOnly) continue;
    if (f.type === "message.part.updated" && (f.properties.part.type === "text" || f.properties.part.type === "reasoning")) parts.set(f.properties.part.id, f.properties.part.text);
    if (f.type === "message.part.delta") parts.set(f.properties.partID, (parts.get(f.properties.partID) ?? "") + f.properties.delta);
  }
  return [...parts.values()];
}

{
  const t = translator();
  const frames = [
    ...t.translate({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "Wait" }] } }),
    ...t.translate({ type: "message_update", changes: [{ type: "text_delta", contentIndex: 0, delta: ", let me" }] }),
    ...t.translate({ type: "message_update", changes: [{ type: "text_delta", contentIndex: 0, delta: " re-read." }] }),
  ];
  check("the first chunk, carried by message_start, reaches the client", render(frames)[0] === "Wait, let me re-read.", JSON.stringify(render(frames)));
}
{
  const t = translator();
  const frames = [
    ...t.translate({ type: "message_start", message: { role: "assistant", content: [{ type: "thinking", thinking: "Hmm" }] } }),
    ...t.translate({ type: "message_update", changes: [{ type: "thinking_delta", contentIndex: 0, delta: ", so" }] }),
  ];
  const opening = frames.find((f) => f.type === "message.part.updated" && f.properties.part.type === "reasoning");
  check("a reasoning block keeps its opening chunk too", render(frames)[0] === "Hmm, so", JSON.stringify(render(frames)));
  check("and its opening snapshot is not marked finished", opening && opening.properties.part.time.end === undefined, JSON.stringify(opening?.properties.part.time));
}
{
  const t = translator();
  const frames = t.translate({ type: "message_start", message: { role: "assistant", content: [] } });
  check("an empty partial opens the message with no empty part", frames.length === 1 && frames[0].type === "message.updated", JSON.stringify(frames.map((f) => f.type)));
  const more = [
    ...t.translate({ type: "message_update", changes: [{ type: "text_start", contentIndex: 0, block: { type: "text", text: "" } }] }),
    ...t.translate({ type: "message_update", changes: [{ type: "text_delta", contentIndex: 0, delta: "Hello" }] }),
  ];
  check("and a block that starts later streams whole", render(more)[0] === "Hello", JSON.stringify(render(more)));
}
{
  const t = translator();
  const frames = [
    ...t.translate({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "A" }] } }),
    ...t.translate({ type: "message_update", changes: [{ type: "text_delta", contentIndex: 0, delta: "B" }] }),
    ...t.translate({ type: "message_end", entry: { kind: "assistant", model: [{ role: "assistant", content: [{ type: "text", text: "AB" }], usage: {} }] } }),
  ];
  check("message_end changes nothing a client already has right", render(frames)[0] === "AB", JSON.stringify(render(frames)));
}

console.log(bad ? `\n  ${bad} failure(s) of ${claims}` : `\n  the live stream spells every block whole: ${claims} claims`);
process.exit(bad ? 1 : 0);
