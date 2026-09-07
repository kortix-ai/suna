// COUNTING WHAT A CELL OWES.
//
// BILLED_UNITS_IMPLEMENTED in the control plane deliberately refuses to let any
// runtime claim 'requests', because nothing counted them. A cell is the one
// runtime for which per-request is the only honest unit: it hibernates to
// nothing, so billing it for RAM it is not holding charges a customer twice.
//
// The failures that matter in a meter are not "off by one". They are:
//   a count that resets when the thing being counted is evicted — and eviction
//   is the NORMAL way an idle cell exists, not a rare event
//   a monitor's polling inflating a customer's bill
//   the billed party being able to erase the bill
// Each of those is a claim.
// Read by test/all.sh. The suite's own tail line catches a section that ran
// and produced nothing; it cannot catch an exit partway through, which skips
// the tail entirely. This is the number that check compares against.
// EXPECTED_PASSES=17

import { installWorkerGlobals, makeCell } from "./cell-harness.mjs";
import { watchClaims } from "../../tools/crash-reporter.mjs";

let bad = 0, claims = 0;
const check = watchClaims((n, c, d = "") => { claims++; if (c) console.log(`  ok    ${n}`); else { console.log(`  FAIL  ${n}${d ? `\n          ${d}` : ""}`); bad++; } });

installWorkerGlobals();
const { AgentCell } = await import("../dist/worker.js");
const ENV = { SCRIPT: JSON.stringify([{ text: "ok" }]) };
const cell = makeCell(AgentCell, ENV);
const get = async (p) => await (await cell.fetch(p)).json();
const post = async (p, b) => await (await cell.fetch(p, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b ?? {}),
})).json();
const meter = async (k = "requests") => (await get("/meter")).meters[k] ?? 0;

// ── it counts ───────────────────────────────────────────────────────────────
const start = await meter();
await get("/history?c=s");
check("a request is counted", (await meter()) === start + 1, `${await meter()} vs ${start}`);
await get("/history?c=s");
await get("/history?c=s");
check("each request counts once, not once per handler", (await meter()) === start + 3, String(await meter()));

// ── observability does not bill ─────────────────────────────────────────────
// A monitor polling /health must not move a customer's invoice, and reading the
// meter must not change it — otherwise the act of billing inflates the bill.
const before = await meter();
await cell.fetch("/health");
await cell.fetch("/health");
await get("/meter");
await get("/meter");
await cell.fetch("/sockets?c=s");
check("HEALTH, METER AND SOCKETS DO NOT BILL — a dashboard cannot invent a bill",
  (await meter()) === before, `${await meter()} vs ${before}`);

// ── a turn bills once, whatever it does inside ──────────────────────────────
const beforeTurn = await meter();
await post("/prompt?c=s", { text: "hello" });
await cell.drain();
check("a prompt is one billable request no matter how many tools it runs",
  (await meter()) === beforeTurn + 1, `${await meter()} vs ${beforeTurn}`);

// ── the meter survives the cell being rebuilt ───────────────────────────────
// An idle cell is evicted and rebuilt constantly — that is how celld runs, not
// an edge case. A counter held in the instance would reset every time and the
// customer would be billed for a fraction of what they used, silently.
//
// BUT NOTE WHAT THIS DOES AND DOES NOT PROVE. rebuild() hands the SAME
// in-memory database to a new instance, so it catches a counter held on the
// instance and nothing else — it preserves storage by construction. A real
// eviction goes through LTX to object storage and back, and a write evicted
// before it replicated would be lost here invisibly. That is proved in
// test/eviction.sh (section 4e) against a real celld node, where the same
// mutation fails 5 -> 0.
const beforeEvict = await meter();
const rebuilt = cell.rebuild();
const rebuiltMeter = (await (await rebuilt.fetch("/meter")).json()).meters.requests ?? 0;
check("A REBUILT CELL KEEPS THE COUNT — the meter is in SQLite, not in the instance",
  rebuiltMeter === beforeEvict, `${rebuiltMeter} vs ${beforeEvict}`);

// ── the billed party cannot erase the bill ─────────────────────────────────
const beforeReset = await meter();
await post("/reset?c=s", {});
check("/reset clears the conversation but NOT the meter — a bill is not erasable by the billed",
  (await meter()) >= beforeReset, `${await meter()} vs ${beforeReset}`);
check("and the conversation really was cleared", (await get("/history?c=s")).messages.length === 0);

// ── monotonic, and not reset by reading ────────────────────────────────────
const a = await meter();
const b = await meter();
const c = await meter();
check("reading the meter does not reset it — the CP takes differences",
  a === b && b === c, `${a},${b},${c}`);
await get("/history?c=s");
check("and it only ever goes up", (await meter()) > c, `${await meter()} vs ${c}`);

// ── it does not pay for a durable write per request ─────────────────────────
//
// celld makes a SQLite write durable in object storage before releasing the
// response. Measured on dev 2026-09-07 against one warm cell: entering the
// cell 2 ms, a SQLite READ 3 ms, a single durable WRITE 154 ms. Counting on
// the request path therefore put an object-storage round trip on every
// billable call — and the counter was usually the ONLY thing that wrote.
//
// These claims pin the fix in both directions: the write must not happen per
// request, and the number must still be exact wherever it is read.
{
  const c2 = makeCell(AgentCell, ENV);
  const g = async (p) => await (await c2.fetch(p)).json();
  await g("/history?c=w");                       // create the schema first
  const before = c2.sqlLog.length;
  for (let i = 0; i < 5; i++) await g("/history?c=w");
  const wrote = c2.sqlLog.slice(before).filter((q) => /INSERT INTO meter/i.test(q)).length;
  check("FIVE billable requests cause NO meter write — the durable write is off the request path",
    wrote === 0, `${wrote} meter writes for 5 requests: ${c2.sqlLog.slice(before).filter((q) => /meter/i.test(q)).join(" | ")}`);

  const seen = (await g("/meter")).meters.requests ?? 0;
  check("but reading the meter settles first, so the number is exact when anyone looks",
    seen >= 6, `reported ${seen} after 6 billable requests`);
  const afterRead = c2.sqlLog.filter((q) => /INSERT INTO meter/i.test(q)).length;
  check("and the settle is ONE statement, not one per request",
    afterRead >= 1 && afterRead <= 3, `${afterRead} meter writes in total`);

  // The threshold is what bounds the loss. Past it the cell writes without
  // being asked, so a busy cell never carries an unbounded tally.
  const c3 = makeCell(AgentCell, ENV);
  const g3 = async (p) => await (await c3.fetch(p)).json();
  await g3("/history?c=t");
  const b3 = c3.sqlLog.length;
  for (let i = 0; i < 25; i++) await g3("/history?c=t");
  const w3 = c3.sqlLog.slice(b3).filter((q) => /INSERT INTO meter/i.test(q)).length;
  check("a cell past the threshold settles ITSELF — the tally is bounded, not unbounded",
    w3 >= 1, `${w3} writes across 25 requests`);
  check("and it is still one write, not twenty-five",
    w3 <= 2, `${w3} writes across 25 requests`);
  const total = (await g3("/meter")).meters.requests ?? 0;
  check("the total is right across the threshold — nothing double-counted at the flush",
    total === 26, `reported ${total}, expected 26`);

  // `builds` rides the same flush. It used to be written inside init(), which
  // put a durable write on the FIRST request every fresh isolate ever served —
  // the most expensive request a session makes, paid once per eviction.
  const c4 = makeCell(AgentCell, ENV);
  const g4 = async (p) => await (await c4.fetch(p)).json();
  const b4 = c4.sqlLog.length;
  await g4("/ping?c=x");                       // reaches the cell, does not init
  await g4("/history?c=x");                    // inits, and used to write here
  const initWrites = c4.sqlLog.slice(b4).filter((q) => /INSERT INTO meter/i.test(q)).length;
  check("a FRESH isolate's first request writes no meter row either — init is off the durable path",
    initWrites === 0, `${initWrites} meter writes while starting up`);
  const m4 = (await g4("/meter")).meters;
  check("and the build is still counted exactly once, because the reader settles it",
    m4.builds === 1, `builds=${m4.builds}`);
}

console.log(bad ? `\n  ${bad} failure(s) of ${claims}` : `\n  the cell counts what it owes: ${claims} claims`);
process.exit(bad ? 1 : 0);
