
// Read by test/all.sh. The suite's own tail line catches a section that ran
// and produced nothing; it cannot catch an exit partway through, which skips
// the tail entirely. This is the number that check compares against.
// EXPECTED_PASSES=17

import { watchClaims } from "../../tools/crash-reporter.mjs";// COMPACTION LOGIC, with nothing running.
//
// The cut is the part that can corrupt a transcript rather than merely fail:
// cutting mid-turn leaves a toolResult whose toolCall is inside the summary, and
// the model then reads a result for a call it cannot see. pi avoids that on its
// session-tree path with findCutPoint; this asserts the message-array version
// does the same.
import {
  compactionState,
  isCompactionSummary,
  maybeCompact,
  planCut,
} from "../src/compaction.js";
import { estimateTokens } from "@earendil-works/pi-agent-core";

let bad = 0;
const check = watchClaims((name, cond, detail = "") => {
  if (cond) console.log(`  ok    ${name}`);
  else { console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`); bad++; }
});

const user = (t) => ({ role: "user", content: [{ type: "text", text: t }] });
const asst = (t) => ({ role: "assistant", content: [{ type: "text", text: t }], usage: { input: 0, output: 0 } });
const call = (id) => ({ role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: { command: "true" } }], usage: { input: 0, output: 0 } });
const result = (id) => ({ role: "toolResult", toolCallId: id, content: [{ type: "text", text: "out" }] });

// A transcript of complete turns: user, call, result, assistant.
const turns = (n, pad = "") => {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(user(`ask ${i} ${pad}`), call(`c${i}`), result(`c${i}`), asst(`reply ${i} ${pad}`));
  }
  return out;
};

// ── the cut ─────────────────────────────────────────────────────────────────
const msgs = turns(12, "x".repeat(200));
const cut = planCut(msgs, 2000);
check("the kept tail begins at a user message",
  cut.tail.length > 0 && cut.tail[0].role === "user",
  `tail starts with ${cut.tail[0]?.role}`);
check("nothing is both summarised and kept",
  cut.older.length + cut.tail.length === msgs.length,
  `${cut.older.length} + ${cut.tail.length} != ${msgs.length}`);

// The corruption case: no orphan tool result at the head of the tail.
const orphan = cut.tail.findIndex((m, i) => m.role === "toolResult" && !cut.tail.slice(0, i).some(
  (p) => (p.content ?? []).some((b) => b.type === "toolCall" && b.id === m.toolCallId)));
check("no toolResult in the tail whose toolCall was summarised away",
  orphan === -1,
  orphan >= 0 ? `orphan at tail index ${orphan}` : "");

check("something is always kept",
  planCut(turns(3), 1).tail.length > 0,
  "an impossibly small budget still keeps a tail");
check("something is always summarised when the budget is tiny",
  planCut(turns(8), 1).older.length > 0);

// ── the two boundaries inside planCut ───────────────────────────────────────
// planCut decides what the model still sees and what is summarised away, and
// three of its four comparisons could be moved by one with every claim above
// still green. The boundary auditor found them; an off-by-one here silently
// drops a turn, or spends a model call summarising nothing.
//
// `i >= 0` -> `i > 0` never visits message[0]. A transcript that fits entirely
// inside the budget then cuts anyway: measured, olderCount goes 0 -> 2.
check("A TRANSCRIPT THAT FITS ENTIRELY IN THE BUDGET IS NOT CUT AT ALL",
  planCut(turns(1), 1e9).olderCount === 0,
  `olderCount ${planCut(turns(1), 1e9).olderCount}`);

// `budget <= 0` -> `budget < 0` keeps the message that exactly exhausts the
// budget instead of summarising it. Three user messages so the turn-boundary
// advance cannot mask the difference, and the budget is measured rather than
// guessed — estimateTokens belongs to pi-agent-core and is not ours to assume.
{
  const three = [user("aaa"), user("bbb"), user("ccc")];
  const exact = estimateTokens(three[2]);
  const cutExact = planCut(three, exact);
  check("a message that EXACTLY exhausts the budget is summarised, not kept",
    cutExact.tail.length === 1 && cutExact.tail[0].content[0].text === "ccc",
    `tail ${JSON.stringify(cutExact.tail.map((m) => m.content[0].text))} at budget ${exact}`);
}

// ── the decision ────────────────────────────────────────────────────────────
const small = compactionState(turns(1), 200_000);
check("a short transcript is not compacted", small.should === false, `tokens=${small.tokens}`);

const big = compactionState(turns(40, "y".repeat(400)), 2_000);
check("a transcript past the window is compacted", big.should === true, `tokens=${big.tokens}`);

// ── the run ─────────────────────────────────────────────────────────────────
let summarised = null;
const res = await maybeCompact({
  messages: turns(40, "z".repeat(400)),
  contextWindow: 2_000,
  summarise: async (older) => { summarised = older; return "SUMMARY OF EARLIER WORK"; },
});
check("compaction ran and returned a new transcript", !!res && res.messages.length > 0);
check("the summariser saw the older messages, not the tail",
  summarised && summarised.length > 0 && summarised.length < 160,
  `${summarised?.length} messages`);
check("the result is smaller than what it replaced",
  res && res.tokensAfter < res.tokensBefore,
  res ? `${res.tokensBefore} -> ${res.tokensAfter}` : "");
check("the new transcript starts with a compaction summary",
  res && isCompactionSummary(res.messages[0]),
  res ? JSON.stringify(res.messages[0]?.content?.[0]?.text ?? "").slice(0, 70) : "");
check("the summary text is carried into the transcript",
  res && JSON.stringify(res.messages[0]).includes("SUMMARY OF EARLIER WORK"));

// A short transcript must not spend a model call.
let called = false;
const none = await maybeCompact({
  messages: turns(1), contextWindow: 200_000,
  summarise: async () => { called = true; return "x"; },
});
check("no model call when compaction is not needed", none === null && called === false);

// ── nothing older to summarise means no model call ─────────────────────────
// planCut can leave the older half empty — one huge turn, for instance, where
// everything is inside keepRecentTokens. Summarising then spends a model call
// to produce a transcript LONGER than the one it started with: a summary of
// nothing, prepended to everything.
//
// Claimed by whether summarise was CALLED, because the return value is null
// either way and only the spend moves.
{
  let calls = 0;
  const huge = [{ role: "user", content: [{ type: "text", text: "x".repeat(40_000) }] }];
  const res = await maybeCompact({
    messages: huge,
    contextWindow: 1000,
    summarise: async () => { calls++; return "SUMMARY"; },
  });
  check("a single turn bigger than the window compacts to nothing", res === null, JSON.stringify(res)?.slice(0, 80));
  check("and does NOT spend a model call to summarise an empty half",
    calls === 0, `${calls} summarise call(s)`);
}

console.log(bad ? `\n  ${bad} failure(s)` : "\n  compaction logic holds");
process.exit(bad ? 1 : 0);
