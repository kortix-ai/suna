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
// EXPECTED_PASSES=9

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

console.log(bad ? `\n  ${bad} failure(s) of ${claims}` : `\n  the cell counts what it owes: ${claims} claims`);
process.exit(bad ? 1 : 0);
