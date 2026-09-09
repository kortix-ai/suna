// THE SEQUENCED BUS BEHIND /kortix/opencode/events.
//
// Every claim here is about a decision that is invisible from outside: which
// frames reach the bus, what number they carry, and when a reconnecting client
// is owed a replay rather than a resync. Getting any of them wrong produces a
// stream that LOOKS healthy — the UI's flapping green light — while the text
// is doubled, missing, or silently starting mid-conversation.
import { WireBus, replayPlan, encodeFrame } from "../src/wire.js";

let bad = 0;
const check = (claim, ok, detail = "") => {
  if (ok) console.log(`  ok    ${claim}`);
  else { bad++; console.log(`  FAIL  ${claim}\n          ${detail}`); }
};

const collect = () => {
  const lines = [];
  return { w: { write: (l) => lines.push(l) }, lines };
};

{
  const bus = new WireBus({ epoch: "e1" });
  const { w, lines } = collect();
  bus.listeners.add(w);
  bus.publish([{ type: "message.part.delta", properties: { delta: "he" } }]);
  bus.publish([{ type: "message.part.delta", properties: { delta: "llo" } }]);
  const ids = [...lines.join("").matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
  check("every frame carries the next sequence number", ids.join(",") === "1,2", ids.join(","));
  const bodies = [...lines.join("").matchAll(/^data: (.+)$/gm)].map((m) => JSON.parse(m[1]));
  check("and the body repeats it, so a consumer reading only data has the cursor",
    bodies.map((b) => b.seq).join(",") === "1,2", JSON.stringify(bodies.map((b) => b.seq)));
  check("the event NAME is the frame type, which is what the API forwards on",
    /^event: message\.part\.delta$/m.test(lines[0]), lines[0]);
}

{
  // The double-count guard. The snapshot REPLACES a part's text and the delta
  // APPENDS to it; both on the bus renders every character twice.
  const bus = new WireBus({ epoch: "e1" });
  const { w, lines } = collect();
  bus.listeners.add(w);
  const n = bus.publish([
    { type: "message.part.updated", transcriptOnly: true, properties: { part: { text: "hello" } } },
    { type: "message.part.delta", properties: { delta: "llo" } },
  ]);
  check("a transcriptOnly snapshot never reaches the bus", n === 1 && !lines.join("").includes("message.part.updated"),
    `published ${n}: ${lines.join("").slice(0, 80)}`);
  check("and it does not consume a sequence number either", bus.seq === 1, String(bus.seq));
}

{
  const bus = new WireBus({ epoch: "e1" });
  const opening = bus.opening({});
  check("an attach opens with kortix.hello", opening.startsWith("event: kortix.hello\n"), opening.slice(0, 40));
  const hello = JSON.parse(opening.match(/^data: (.+)$/m)[1]);
  check("and the hello names the boot the cursor belongs to", hello.epoch === "e1" && hello.seq === 0,
    JSON.stringify(hello));
  check("the hello is NOT sequenced — it would advance a cursor over no content",
    !/^id: /m.test(opening), opening);
}

{
  const bus = new WireBus({ epoch: "e2" });
  bus.publish([{ type: "a" }, { type: "b" }, { type: "c" }]);
  const out = bus.opening({ since: 1, epoch: "e2" });
  check("a replay carries only what the client has not seen",
    !out.includes("event: a") && out.includes("event: b") && out.includes("event: c"), out);
  const ahead = bus.opening({ since: 99, epoch: "e2" });
  check("a cursor AHEAD of the head is a resync, not silence", ahead.includes("kortix.resync"), ahead);
}

{
  // The one that matters after an eviction: the isolate is rebuilt, the epoch
  // changes, and every seq the client holds belongs to a boot that is gone.
  // The cursor is deliberately one this epoch COULD serve — in range, with
  // frames after it — so only the epoch check stands between the client and a
  // replay of somebody else's boot. A `since` past the head would resync for
  // the wrong reason and the claim would pass without the rule it names.
  const bus = new WireBus({ epoch: "new-boot" });
  bus.publish([{ type: "a" }, { type: "b" }, { type: "c" }]);
  const out = bus.opening({ since: 1, epoch: "old-boot" });
  check("a cursor from another boot is answered with a resync, never a replay",
    out.includes("kortix.resync") && !out.includes("event: b") && !out.includes("event: c"), out);
  const reason = JSON.parse(out.match(/kortix\.resync[\s\S]*?^data: (.+)$/m)[1]);
  check("and the resync says why, and where the stream now starts",
    reason.reason === "epoch_changed" && reason.head_seq === 3, JSON.stringify(reason));
}

{
  const bus = new WireBus({ epoch: "e1", ringMax: 3 });
  bus.publish([{ type: "a" }, { type: "b" }, { type: "c" }, { type: "d" }, { type: "e" }]);
  check("the ring is bounded — an old frame is dropped, not kept forever",
    bus.ring.length === 3 && bus.firstSeq === 3, `len ${bus.ring.length} first ${bus.firstSeq}`);
  const gap = bus.opening({ since: 1, epoch: "e1" });
  check("and a cursor older than the ring is a resync, not a stream that starts mid-answer",
    gap.includes("kortix.resync") && gap.includes('"reason":"gap"'), gap.slice(0, 200));
  check("a cursor exactly at the ring's edge still replays",
    bus.opening({ since: 2, epoch: "e1" }).includes("event: c"), "");
}

{
  const fresh = new WireBus({ epoch: "e1" });
  check("since=0 on a cell that has said nothing is live, not a resync",
    !fresh.opening({ since: 0, epoch: "e1" }).includes("resync"), fresh.opening({ since: 0 }));
  check("and a plain attach with no cursor is live",
    replayPlan({ since: null, epoch: null, ourEpoch: "e1", firstSeq: 1, headSeq: 0 }).kind === "live", "");
}

{
  const bus = new WireBus({ epoch: "e1" });
  const dead = { write: () => { throw new Error("closed"); } };
  const { w, lines } = collect();
  bus.listeners.add(dead); bus.listeners.add(w);
  bus.publish([{ type: "a" }]);
  check("a listener whose socket is gone is dropped, not retried on every frame",
    !bus.listeners.has(dead) && lines.length === 1, `${bus.listeners.size} left`);
}

{
  check("a frame with no type is not publishable — it would name no event",
    new WireBus({ epoch: "e1" }).publish([null, {}, { type: 42 }]) === 0, "");
  check("encodeFrame writes the three lines the SSE contract needs",
    encodeFrame({ type: "x", a: 1 }, 9) === 'event: x\nid: 9\ndata: {"type":"x","a":1,"seq":9}\n\n',
    JSON.stringify(encodeFrame({ type: "x", a: 1 }, 9)));
}


{
  // A REASONING PART IS NOT AN ANSWER. The model thinks out loud, the adapter
  // makes that a `reasoning` part, and the SDK's own transcript formatter hides
  // it by default — so streaming it painted the thinking as a first answer and
  // the reply as a second. Measured on a one-word reply: p0 reasoning ("The
  // user asked to reply with exactly one word…"), p1 text ("streamcheck").
  const bus = new WireBus({ epoch: "e1" });
  const { w, lines } = collect();
  bus.listeners.add(w);
  const n = bus.publish([
    { type: "message.part.updated", properties: { part: { id: "p0", type: "reasoning", text: "" } } },
    { type: "message.part.delta", properties: { partID: "p0", field: "text", delta: "thinking out loud" } },
    { type: "message.part.updated", properties: { part: { id: "p1", type: "text", text: "" } } },
    { type: "message.part.delta", properties: { partID: "p1", field: "text", delta: "the answer" } },
  ]);
  const body = lines.join("");
  check("a reasoning part never reaches the live stream", !body.includes("reasoning"), body.slice(0, 90));
  check("nor do its deltas — the thinking would have been painted as text",
    !body.includes("thinking out loud"), body.slice(0, 120));
  check("but the answer does, untouched",
    body.includes("the answer") && n === 2, `published ${n}`);
  check("and the dropped frames consume no sequence numbers",
    bus.seq === 2, String(bus.seq));
}

{
  // WHEN DOES THE USER'S EMPTY BUBBLE GET SOMETHING IN IT?
  //
  // The turn timer used to stop on the first wire frame of any kind. The first
  // frame is `message.updated`, which the adapter emits when the assistant
  // message OPENS — before the model has produced a character. Measured on dev
  // 2026-09-09 that mark read 2 ms on a turn that took 1602 ms, and a report
  // built on it blamed the model for a wait the model had not begun.
  const bus = new WireBus({ epoch: "e1" });
  check("the message opening is not text — timing to it measures nothing",
    !bus.carriesVisibleText({ type: "message.updated", properties: { info: { id: "m1" } } }), "");
  check("nor is the empty part that opens before any token",
    !bus.carriesVisibleText({ type: "message.part.updated", properties: { part: { id: "p1", type: "text", text: "" } } }), "");
  check("a text delta is text",
    bus.carriesVisibleText({ type: "message.part.delta", properties: { partID: "p1", delta: "hi" } }), "");
  check("a snapshot that already carries text is text",
    bus.carriesVisibleText({ type: "message.part.updated", properties: { part: { id: "p1", type: "text", text: "hi" } } }), "");
  // The reasoning case is the one that makes this a predicate and not a
  // type check: a reasoning delta looks exactly like a text delta.
  bus.publish([{ type: "message.part.updated", properties: { part: { id: "p0", type: "reasoning", text: "" } } }]);
  check("a reasoning delta is NOT the bubble filling — it is never shown",
    !bus.carriesVisibleText({ type: "message.part.delta", properties: { partID: "p0", delta: "thinking" } }), "");
}

console.log(bad ? `\n  ${bad} failed` : "");
process.exit(bad ? 1 : 0);
