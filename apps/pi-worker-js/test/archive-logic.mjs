// COMPACTION MUST NOT DESTROY THE RECORD.
//
// Compaction answers "what should the model be sent?" It was answering "what
// happened?" at the same time, by DELETING the messages it summarised. After a
// long session /history showed a summary and a tail, and what the agent
// actually did was gone — including every tool result it had reported.
//
// The transcript is now kept and the context is a WINDOW over it. These claims
// are about the seam: the model must see only the window, /history must be able
// to show everything, and the archive must not grow without bound.
// Read by test/all.sh. The suite's own tail line catches a section that ran
// and produced nothing; it cannot catch an exit partway through, which skips
// the tail entirely. This is the number that check compares against.
// EXPECTED_PASSES=24

import { installWorkerGlobals, makeCell } from "./cell-harness.mjs";
import { watchClaims } from "../../tools/crash-reporter.mjs";

let bad = 0, claims = 0;
const check = watchClaims((n, c, d = "") => { claims++; if (c) console.log(`  ok    ${n}`); else { console.log(`  FAIL  ${n}${d ? `\n          ${d}` : ""}`); bad++; } });

installWorkerGlobals();
const { AgentCell } = await import("../dist/worker.js");

// A tiny context window, so compaction triggers on a handful of turns rather
// than on 200k tokens of fixture.
const cell = makeCell(AgentCell, {
  SCRIPT: JSON.stringify([{ text: "ok" }]),
  CONTEXT_WINDOW: "3000",
});
const get = async (p) => await (await cell.fetch(p)).json();
const say = async (c, text) => await (await cell.fetch(`/prompt?c=${c}`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ text, contextWindow: 3000 }),
})).json();

// Enough turns to force at least one compaction.
// Sized from the e2e's own compaction claim: ~960 characters a turn is what
// reaches a 3000-token window in about a dozen turns.
const FILLER = "padding ".repeat(120);
// The peak matters more than the total: /context reports on what the MODEL is
// handed, so if the window were ignored this number would only ever climb.
let peakTokens = 0;
for (let i = 0; i < 16; i++) {
  await say("s", `turn ${i} ${FILLER}`);
  const c = await get("/context?c=s&window=3000");
  if (c.tokens > peakTokens) peakTokens = c.tokens;
}
await cell.drain();

const active = await get("/history?c=s");
const full = await get("/history?c=s&all=1");

check("compaction ran", active.archived > 0, `archived=${active.archived} contextFrom=${active.contextFrom}`);
check("THE ARCHIVED MESSAGES ARE STILL THERE — the record survives",
  full.messages.length > active.messages.length, `${full.messages.length} archived-inclusive vs ${active.messages.length} active`);
check("the active context is the smaller window", active.messages.length < full.messages.length);
check("the archive holds the ORIGINAL first turn, verbatim",
  JSON.stringify(full.messages[0]).includes("turn 0"), JSON.stringify(full.messages[0] ?? null).slice(0, 140));
check("and the active context does NOT — that is the point of compacting",
  !JSON.stringify(active.messages).includes("turn 0"), JSON.stringify(active.messages).slice(0, 120));
check("the active window begins with the compaction summary",
  active.messages[0]?.role === "compactionSummary", JSON.stringify(active.messages[0]?.role));

// WHAT THE MODEL IS HANDED must be the window, not the archive. /context is
// computed from the same load the turn uses, so it is the one place that can
// tell the difference — /history would look identical either way, which is
// exactly how a version that loaded everything passed every other claim here.
{
  const c = await get("/context?c=s&window=3000");
  check("the loaded context SHRANK after compacting, rather than only appearing to",
    c.tokens < peakTokens, `now ${c.tokens}, peak ${peakTokens}`);
  check("and it is inside the window it was given", c.tokens < 3000, `${c.tokens} tokens`);
}

// What the MODEL is handed must be the window, not the archive. If loadMessages
// ignored the watermark, compaction would have bounded nothing and the context
// would grow forever while looking compacted from outside.
const beforeCount = active.messages.length;
await say("s", "one more");
await cell.drain();
const after = await get("/history?c=s");
check("a later turn continues from the window, not from the whole archive",
  after.messages.length <= beforeCount + 4, `${after.messages.length} vs ${beforeCount}`);

// ── ALL OF IT MUST SURVIVE THE CELL BEING REBUILT ───────────────────────────
// Every claim above reads from the SAME INSTANCE that wrote it, which is the
// hollow-claim pattern: it holds even if none of this were in SQLite at all. An
// idle cell is evicted and rebuilt constantly, so "the record survives" is only
// meaningful across that.
//
// The watermark is the sharp end. context_from lives in the `meta` table, and if
// it were instance state a rebuilt cell would load the WHOLE ARCHIVE into
// context — silently unbounding both the context and the bill, while /history
// still looked perfectly correct.
{
  const beforeCtx = await get("/context?c=s&window=3000");
  const beforeAll = await get("/history?c=s&all=1");
  const again = cell.rebuild();
  const g2 = async (p) => await (await again.fetch(p)).json();

  const afterAll = await g2("/history?c=s&all=1");
  check("the archive is still on disk after a rebuild",
    afterAll.messages.length === beforeAll.messages.length,
    `${afterAll.messages.length} vs ${beforeAll.messages.length}`);

  const afterActive = await g2("/history?c=s");
  check("and the window is still the window, not the whole archive",
    afterActive.messages.length < afterAll.messages.length,
    `${afterActive.messages.length} active of ${afterAll.messages.length}`);
  check("THE WATERMARK SURVIVED — a rebuilt cell does not reload the archive into context",
    afterActive.contextFrom === beforeAll.contextFrom && afterActive.contextFrom > 0,
    `${afterActive.contextFrom} vs ${beforeAll.contextFrom}`);

  const afterCtx = await g2("/context?c=s&window=3000");
  check("so the loaded context costs the same after a rebuild as before it",
    afterCtx.tokens === beforeCtx.tokens, `${afterCtx.tokens} vs ${beforeCtx.tokens}`);
  check("and the rebuilt cell reports the same archived count",
    afterActive.archived === beforeAll.archived, `${afterActive.archived} vs ${beforeAll.archived}`);
}

// ── the archive is bounded ──────────────────────────────────────────────────
// Kept forever it would grow without limit in storage that flushes to S3 on
// every change. Newest archived messages are the ones worth keeping.
const rowsBefore = cell.rows("SELECT COUNT(*) AS n FROM msgs")[0].n;
const dropped = cell.cell.pruneArchive(200);
const rowsAfter = cell.rows("SELECT COUNT(*) AS n FROM msgs")[0].n;
check("a tight archive budget drops the OLDEST archived messages", dropped > 0 && rowsAfter < rowsBefore,
  `dropped=${dropped} ${rowsBefore} -> ${rowsAfter}`);
const stillActive = await get("/history?c=s");
check("AND IT NEVER TOUCHES THE ACTIVE CONTEXT",
  stillActive.messages.length === after.messages.length, `${stillActive.messages.length} vs ${after.messages.length}`);

// ── reset clears the watermark with the rows ────────────────────────────────
// Left behind it points past every row in an empty table, and the session loads
// nothing, forever.
await cell.fetch("/reset?c=s", { method: "POST" });
const cleared = await get("/history?c=s");
check("reset clears the context watermark, not only the rows",
  cleared.contextFrom === 0 && cleared.messages.length === 0, JSON.stringify(cleared).slice(0, 120));
await say("s", "after reset");
await cell.drain();
const revived = await get("/history?c=s");
check("and the session works again after a reset", revived.messages.some((m) => JSON.stringify(m).includes("after reset")),
  JSON.stringify(revived.messages).slice(0, 140));

// ── pruning that has nothing to do must do nothing ──────────────────────────
// Two early returns in pruneArchive look like they cannot matter, and SQLite is
// the reason: `WHERE i < 0` matches nothing because rowids start at 1, and
// `WHERE i <= NULL` is never true, so removing either guard changes no ROW.
// Measured, not assumed — five rows, `i < 0` matches 0, and a DELETE bound to
// NULL removes 0.
//
// What changes is the WORK. This SQLite is flushed to object storage on every
// change and pruneArchive runs after every compaction, so a guard that skips a
// scan of the whole table is not decoration. Claimed by counting statements,
// which is the only way an early return whose absence deletes nothing can fail.
{
  const fresh = makeCell(AgentCell, { SCRIPT: JSON.stringify([{ text: "ok" }]), CONTEXT_WINDOW: "3000" });
  const ask = async (text) => await (await fresh.fetch("/prompt?c=s", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, contextWindow: 3000 }),
  })).json();
  await ask("one");

  // Nothing compacted yet: context_from is 0, so there is no archive to scan.
  const before = fresh.sqlLog.length;
  const droppedNone = fresh.cell.pruneArchive(200);
  const issued = fresh.sqlLog.slice(before);
  check("pruning a cell that has never compacted drops nothing", droppedNone === 0, String(droppedNone));
  check("and reads the watermark ONLY — no scan of a table with no archive in it",
    issued.length === 1 && /^SELECT v FROM meta/i.test(issued[0]), JSON.stringify(issued).slice(0, 180));

  // Now force a real archive, the way the claims above this one do.
  for (let i = 0; i < 16; i++) await ask(`turn ${i} ${FILLER}`);
  await fresh.drain();
  const archived = (await (await fresh.fetch("/history?c=s")).json()).archived;
  check("and once compaction has run there IS an archive to prune", archived > 0, `archived=${archived}`);

  const before2 = fresh.sqlLog.length;
  const droppedFits = fresh.cell.pruneArchive(10_000_000);
  const issued2 = fresh.sqlLog.slice(before2);
  check("an archive well inside its budget drops nothing", droppedFits === 0, String(droppedFits));
  check("and costs the watermark read plus one scan — not a COUNT and a DELETE that match nothing",
    issued2.length === 2 && issued2.every((q) => /^SELECT/i.test(q)), JSON.stringify(issued2).slice(0, 220));
  check("in particular no DELETE is issued, which is what an unguarded null would have run",
    !issued2.some((q) => /^DELETE/i.test(q)), JSON.stringify(issued2).slice(0, 220));
}

console.log(bad ? `\n  ${bad} failure(s) of ${claims}` : `\n  the record survives compaction: ${claims} claims`);
process.exit(bad ? 1 : 0);
