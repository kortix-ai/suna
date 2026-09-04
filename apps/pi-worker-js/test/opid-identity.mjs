// WHOSE OUTPUT IS THIS? OP IDS ACROSS TURNS.
//
// The whole idempotency design rests on one sentence: the op id IS the tool
// call id. The daemon caches by op id, so a retry of the same call is answered
// from the ledger instead of running twice.
//
// pi's tools do not know about op ids. They call env.exec(command) and nothing
// else, so the ExecutionEnv has to supply one — and if it invents ids from a
// counter that restarts with each env, two DIFFERENT calls collide and the
// second is answered with the first one's output. That is worse than a double
// execution: it is a fabricated result the model has no way to doubt.
//
// The worker builds a fresh tool set per turn (toolsFor is called inside the
// turn), so "each env starts its counter at zero" is the real configuration,
// not a hypothetical one. These claims drive it exactly that way.
// Read by test/all.sh. The suite's own tail line catches a section that ran
// and produced nothing; it cannot catch an exit partway through, which skips
// the tail entirely. This is the number that check compares against.
// EXPECTED_PASSES=17

import { createBashTool } from "@earendil-works/pi-agent-core";
import { mkdir, rm } from "node:fs/promises";
import { piTools } from "../src/pitools.js";
import { watchClaims } from "../../tools/crash-reporter.mjs";

process.env.TOKEN = "opid-token";
process.env.WORK_ROOT = "/tmp/opid-work";
const PORT = 7131;
await rm(process.env.WORK_ROOT, { recursive: true, force: true });
await mkdir(process.env.WORK_ROOT, { recursive: true });
const { createDaemon } = await import("../daemon/server.js");
const server = createDaemon();
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

let bad = 0, claims = 0;
const check = watchClaims((n, c, d = "") => { claims++; if (c) console.log(`  ok    ${n}`); else { console.log(`  FAIL  ${n}${d ? `\n          ${d}` : ""}`); bad++; } });

// The cell's ops table, as pitools writes it.
const rows = new Map();
// Every statement, so a claim can be about how many DISPATCHES happened rather
// than only about what came back.
const issued = [];
const sql = { exec: (q, ...a) => {
  issued.push(String(q).trim());
  // The ledger reads its own prior state before every call, so this double
  // has to answer a SELECT, not only record writes.
  if (/^SELECT/i.test(q)) { const r = rows.get(a[0]); return r ? [r] : []; }

  if (/^INSERT OR IGNORE INTO ops/.test(q)) { if (!rows.has(a[0])) rows.set(a[0], { id: a[0], kind: a[1], detail: a[2], status: "running" }); }
  else if (/^UPDATE ops SET status/.test(q)) { const r = rows.get(a[a.length - 1]); if (r) { r.status = a[0]; r.out = a[1]; r.result = a[2]; } }
  else if (/^UPDATE ops SET replayed/.test(q)) { const r = rows.get(a[a.length - 1]); if (r) r.replayed = !!a[0]; }
} };

// The URL is mutable so a revived daemon can listen on a fresh port. Reusing
// the port hands the new server a socket from fetch's keep-alive pool that
// belonged to the dead one, which fails as "fetch failed" rather than anything
// about the ledger.
const CELL_ENV = { TOOL_DAEMON_URL: `http://127.0.0.1:${PORT}`, TOOL_DAEMON_TOKEN: "opid-token" };
const bashOf = (tools) => tools.find((t) => t.name === "bash");
// A TURN: the worker builds the tool set fresh, so any per-env counter resets here.
const turn = () => bashOf(piTools(CELL_ENV, "sess", sql));
const run = async (tool, callId, command) => {
  let out = "";
  try { const r = await tool.execute(callId, { command }, undefined, undefined, undefined); out = JSON.stringify(r); }
  catch (e) { out = `THREW ${String(e?.message ?? e)}`; }
  return out;
};
const daemonOps = async () => (await (await fetch(`http://127.0.0.1:${PORT}/_ops`, { headers: { authorization: "Bearer opid-token" } })).json()).ops;
const totalRuns = async () => (await daemonOps()).reduce((n, o) => n + o.runs, 0);

// ── the collision ───────────────────────────────────────────────────────────
// Turn 1 asks for ALPHA. Turn 2 is a different call asking for BETA. If op ids
// come from a per-env counter, both are "<session>-exec-0" and turn 2 is served
// ALPHA from the ledger — a wrong answer, delivered confidently.
const t1 = await run(turn(), "call_alpha", "echo ALPHA");
check("turn 1 gets its own output", t1.includes("ALPHA"), t1.slice(0, 140));

const t2 = await run(turn(), "call_beta", "echo BETA");
check("A DIFFERENT TOOL CALL IN A LATER TURN IS NOT SERVED THE EARLIER CALL'S OUTPUT",
  t2.includes("BETA") && !t2.includes("ALPHA"), t2.slice(0, 140));

check("both commands actually ran", (await totalRuns()) >= 2, `${await totalRuns()} runs`);

// ── the property that must survive the fix ──────────────────────────────────
// Same call id, retried: answered from the ledger, executed once.
const beforeRetry = await totalRuns();
const tool = turn();
const first = await run(tool, "call_once", "echo ONCE >> counted.txt; echo ONCE");
const retry = await run(turn(), "call_once", "echo ONCE >> counted.txt; echo ONCE");
check("retrying the same tool call still returns the same output", first.includes("ONCE") && retry.includes("ONCE"));
check("and it executed exactly once", (await totalRuns()) === beforeRetry + 1, `${(await totalRuns()) - beforeRetry} runs`);

// Two distinct calls issuing the SAME command both run: the model asked twice.
const beforeSame = await totalRuns();
await run(turn(), "call_dup_a", "echo SAME");
await run(turn(), "call_dup_b", "echo SAME");
check("two distinct calls running the same command both execute", (await totalRuns()) === beforeSame + 2, `${(await totalRuns()) - beforeSame} runs`);

// ── the op id is derived from the call id, visibly ──────────────────────────
const ids = (await daemonOps()).map((o) => o.id);
check("the daemon's op ids carry the tool call id", ids.some((i) => i.startsWith("call_alpha")) && ids.some((i) => i.startsWith("call_beta")),
  ids.slice(0, 6).join(", "));

// ── a replay is recorded, not silently identical ────────────────────────────
// The transcript has to be able to say "this result came from the ledger".
// Without it a retry and a re-execution look the same after the fact, and the
// e2e claim that nothing re-ran has nothing to read.
check("a replayed call is marked in the cell's op ledger", rows.get("call_once")?.replayed === true,
  JSON.stringify(rows.get("call_once") ?? null).slice(0, 160));
check("a first execution is NOT marked replayed", rows.get("call_alpha")?.replayed !== true,
  JSON.stringify(rows.get("call_alpha") ?? null).slice(0, 160));

// ── filesystem ops collide the same way ─────────────────────────────────────
// exec is the loud case; a write answered from another call's ledger entry is
// the quiet one. Same id scheme, same claim.
const wr = async (callId, path, content) => {
  try { await piTools(CELL_ENV, "sess", sql).find((t) => t.name === "write").execute(callId, { path, content }, undefined, undefined, undefined); } catch {}
};
await wr("call_wa", "a.txt", "AAA");
await wr("call_wb", "b.txt", "BBB");
const { readFile } = await import("node:fs/promises");
const readW = async (p) => (await readFile(`${process.env.WORK_ROOT}/sess/${p}`, "utf8").catch(() => "<missing>"));
check("a second write in a later turn writes ITS OWN content", (await readW("b.txt")) === "BBB", `b.txt = ${await readW("b.txt")}`);
check("and the first write is untouched", (await readW("a.txt")) === "AAA", `a.txt = ${await readW("a.txt")}`);

// ── the same call, twice AT ONCE ────────────────────────────────────────────
// Everything above retries sequentially, so the ledger row is already written
// when the second attempt arrives. Concurrently it is not: both attempts read
// the ops table before either has finished writing, both find nothing, and both
// dispatch. That is what the in-flight map is for, and nothing drove it —
// removing the join broke no claim.
//
// It matters most on the backend that cannot help: the daemon single-flights by
// op id too, so a double dispatch there is absorbed. The Platinum backend keeps
// no ledger (idempotent === false), and there a second dispatch is a second
// side effect.
{
  const tool = turn();
  const before = issued.filter((q) => /^INSERT OR IGNORE INTO ops/.test(q)).length;
  const runsBefore = await totalRuns();
  const [a, b] = await Promise.all([
    run(tool, "call_concurrent", "echo CONCURRENT >> twice.txt; wc -l < twice.txt"),
    run(tool, "call_concurrent", "echo CONCURRENT >> twice.txt; wc -l < twice.txt"),
  ]);
  const dispatches = issued.filter((q) => /^INSERT OR IGNORE INTO ops/.test(q)).length - before;
  check("two concurrent calls with the SAME id dispatch ONCE, not twice",
    dispatches === 1, `${dispatches} dispatches`);
  check("and the command ran once",
    (await totalRuns()) - runsBefore === 1, `${(await totalRuns()) - runsBefore} runs`);
  check("both callers get the SAME answer — the second joins the first rather than racing it",
    a === b, `${a.slice(0, 70)} vs ${b.slice(0, 70)}`);
  check("and it is a real answer, not an error either of them invented",
    a.includes("1"), a.slice(0, 120));
}

// ── an unknown outcome is never a silent empty success ──────────────────────
// The daemon answers an op that was in flight when a previous daemon died with
// HTTP 200 and no result. Passed through, that reads to the model as a command
// that printed nothing and worked. It has to be an error.
{
  const { DatabaseSync } = await import("node:sqlite");
  const plant = new DatabaseSync(`${process.env.WORK_ROOT}/.ledger.sqlite`);
  plant.prepare("INSERT INTO ops(id, status, started_at) VALUES ('call_inflight-exec-0', 'running', ?)").run(Date.now());
  plant.close();
  await new Promise((r) => server.close(r));
  const revived = createDaemon();
  await new Promise((r) => revived.listen(PORT + 1, "127.0.0.1", r));
  CELL_ENV.TOOL_DAEMON_URL = `http://127.0.0.1:${PORT + 1}`;
  const out = await run(turn(), "call_inflight", "echo SHOULD_NOT_APPEAR");
  check("an op with an unknown outcome reaches the model as an error, not empty output",
    /unknown/i.test(out) && !out.includes("SHOULD_NOT_APPEAR"), out.slice(0, 160));
  check("and the ledger records it as an error, not done", rows.get("call_inflight")?.status === "error",
    JSON.stringify(rows.get("call_inflight") ?? null).slice(0, 140));
  await new Promise((r) => revived.close(r));
}

console.log(bad ? `\n  ${bad} failure(s) of ${claims}` : `\n  op ids are tool call ids: ${claims} claims`);
process.exit(bad ? 1 : 0);
