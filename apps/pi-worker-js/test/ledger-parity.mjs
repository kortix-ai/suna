// THE SAME IDEMPOTENCY GUARANTEE ON BOTH BACKENDS.
//
// The daemon has an op ledger, and it is what makes a retried tool call safe
// there. The Platinum path had nothing: /exec and /files are plain calls, so a
// turn replayed after a crash re-ran whatever the tool call did — the exact
// failure the design exists to prevent, on the path that is the product.
//
// These claims are written once and run against BOTH backends, because parity
// is the property being tested. A guarantee that holds only where it was
// convenient to implement is not a guarantee.
// Read by test/all.sh. The suite's own tail line catches a section that ran
// and produced nothing; it cannot catch an exit partway through, which skips
// the tail entirely. This is the number that check compares against.
// EXPECTED_PASSES=55

import { spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { piTools, piToolsPlatinum } from "../src/pitools.js";
import { watchClaims } from "../../tools/crash-reporter.mjs";

const HERE = new URL(".", import.meta.url).pathname;
process.env.TOKEN = "parity-token";
process.env.WORK_ROOT = "/tmp/parity-daemon";
const DPORT = 7161, PPORT = 7162;
const PROOT = "/tmp/parity-platinum";
await rm(process.env.WORK_ROOT, { recursive: true, force: true });
await rm(PROOT, { recursive: true, force: true });
await mkdir(`${process.env.WORK_ROOT}/sess`, { recursive: true });
await mkdir(`${PROOT}/w`, { recursive: true });

const { createDaemon } = await import("../daemon/server.js");
const daemon = createDaemon();
await new Promise((r) => daemon.listen(DPORT, "127.0.0.1", r));
const stub = spawn(process.execPath, [`${HERE}platinum-stub.mjs`], {
  env: { ...process.env, PORT: String(PPORT), SANDBOX_KEY: "pt_parity", SANDBOX_ID: "sbx_parity", WORK_ROOT: PROOT },
  stdio: "ignore",
});
await new Promise((r) => setTimeout(r, 500));

let bad = 0, claims = 0;
const check = watchClaims((n, c, d = "") => { claims++; if (c) console.log(`  ok    ${n}`); else { console.log(`  FAIL  ${n}${d ? `\n          ${d}` : ""}`); bad++; } });

/** A cell's ops table, the real one, so the claims run against real SQL. */
function freshLedger() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE ops (id TEXT PRIMARY KEY, kind TEXT, detail TEXT, status TEXT, out TEXT,
           started_at INTEGER, ended_at INTEGER, replayed INTEGER DEFAULT 0, result TEXT)`);
  return {
    db,
    sql: {
      exec: (q, ...a) => {
        const st = db.prepare(q);
        return /^SELECT/i.test(q) ? st.all(...a) : (st.run(...a), []);
      },
    },
  };
}

const BACKENDS = [
  {
    name: "daemon",
    env: { TOOL_DAEMON_URL: `http://127.0.0.1:${DPORT}`, TOOL_DAEMON_TOKEN: "parity-token" },
    tools: (env, sql) => piTools(env, "sess", sql),
    marker: `${process.env.WORK_ROOT}/sess/counted.txt`,
  },
  {
    name: "platinum",
    env: { PT_API_URL: `http://127.0.0.1:${PPORT}`, PT_SANDBOX_KEY: "pt_parity", PT_WORKSPACE_ID: "sbx_parity", PT_WORKSPACE_CWD: `${PROOT}/w` },
    tools: (env, sql) => piToolsPlatinum(env, "sess", sql),
    marker: `${PROOT}/w/counted.txt`,
  },
];

const runs = async (marker) => (await readFile(marker, "utf8").catch(() => "")).split("\n").filter(Boolean).length;

for (const b of BACKENDS) {
  console.log(`\n  ── ${b.name} ──`);
  const { sql, db } = freshLedger();
  const bash = () => b.tools(b.env, sql).find((t) => t.name === "bash");
  const call = async (id, command) => {
    // The WHOLE result: details.replayed is the part that says where the
    // answer came from, and it is not in content[0].text.
    try { const r = await bash().execute(id, { command }, undefined, undefined, undefined);
          return { text: r.content?.[0]?.text ?? "", result: r }; }
    catch (e) { return { threw: String(e?.message ?? e) }; }
  };
  const CMD = "echo x >> counted.txt; echo RAN";

  // ── a retry is answered, not re-run ───────────────────────────────────────
  const first = await call("c_once", CMD);
  check(`${b.name}: the call runs and returns its output`, /RAN/.test(first.text ?? ""), JSON.stringify(first).slice(0, 120));
  check(`${b.name}: it executed once`, (await runs(b.marker)) === 1, `${await runs(b.marker)} executions`);
  const again = await call("c_once", CMD);
  check(`${b.name}: A RETRY IS ANSWERED FROM THE LEDGER`, /RAN/.test(again.text ?? ""), JSON.stringify(again).slice(0, 120));
  check(`${b.name}: AND IT DID NOT RUN AGAIN`, (await runs(b.marker)) === 1, `${await runs(b.marker)} executions`);
  check(`${b.name}: the replay is marked as one`, again.result?.details?.replayed === true, JSON.stringify(again.result?.details ?? null));

  // ── a different call is not confused with it ──────────────────────────────
  const other = await call("c_other", "echo OTHER");
  check(`${b.name}: a different call gets its own output`, /OTHER/.test(other.text ?? "") && !/RAN/.test(other.text ?? ""),
    JSON.stringify(other).slice(0, 120));

  // ── in flight when the cell died: MAY have run ────────────────────────────
  //
  // The shared property is "never a second execution". HOW it is honoured
  // differs, and it should: the daemon keeps its own ledger, so the cell asks
  // it rather than guessing. Platinum has nothing to ask, so the cell refuses.
  // Treating both the same would either re-run on Platinum or permanently
  // refuse work the daemon could resolve.
  db.prepare("INSERT INTO ops(id, kind, status, started_at) VALUES ('c_inflight', 'bash', 'running', ?)").run(Date.now());
  const before = await runs(b.marker);
  if (b.name === "platinum") {
    const unknown = await call("c_inflight", CMD);
    check(`${b.name}: an op in flight when the session stopped is reported unknown`,
      /unknown/i.test(unknown.threw ?? ""), JSON.stringify(unknown).slice(0, 140));
    check(`${b.name}: and it is NOT re-run, because nothing here can know`,
      (await runs(b.marker)) === before, `${await runs(b.marker)} vs ${before}`);
  } else {
    // The daemon never saw this op, so the command never reached it and running
    // it is both safe and correct.
    const resolved = await call("c_inflight", CMD);
    check(`${b.name}: an op the daemon never saw is resolved by asking it`,
      /RAN/.test(resolved.text ?? ""), JSON.stringify(resolved).slice(0, 140));
    // The daemon's own "in flight when I died" path is proved where it can be
    // set up honestly — daemon-persist.mjs restarts the daemon, which is what
    // makes a planted row visible; this daemon has its ledger in memory and
    // would not see one. What belongs HERE is the rule that sends the question
    // down at all, asserted below on both envs.
  }

  // ── a failure is REPLAYED, not re-run ─────────────────────────────────────
  // A failed call is still a completed call. The cell cannot tell "exited
  // non-zero" from "ran, and the reply was lost", and re-running the second
  // repeats its side effects. This is exactly where the backends diverged
  // before the ledger moved into the cell.
  const failMarker = await runs(b.marker);
  await call("c_fail", `echo x >> counted.txt; exit 9`);
  const ranOnce = await runs(b.marker);
  const retryFail = await call("c_fail", `echo x >> counted.txt; exit 9`);
  check(`${b.name}: a retried failure returns the same failure`, /exit|code 9/i.test(retryFail.threw ?? ""),
    JSON.stringify(retryFail).slice(0, 120));
  check(`${b.name}: and the failing command is NOT run a second time`, (await runs(b.marker)) === ranOnce,
    `${await runs(b.marker)} vs ${ranOnce} (started at ${failMarker})`);

  // ── two concurrent identical calls execute once ───────────────────────────
  //
  // NOTE WHICH MECHANISM THIS TESTS. `call()` builds a fresh tool set each time,
  // and every piTools() gets its OWN in-flight map — so the single-flight join
  // cannot fire here. What stops the second and third is the 'running' row the
  // first wrote: the ledger gate, not the join. Both are real, and the join has
  // its own claim below because this one cannot reach it. Found by
  // npm run conditions, where disabling `if (joined)` broke nothing.
  const n0 = await runs(b.marker);
  await Promise.all([call("c_race", CMD), call("c_race", CMD), call("c_race", CMD)]);
  check(`${b.name}: three concurrent retries execute the command once (via the ledger gate)`, (await runs(b.marker)) === n0 + 1,
    `${(await runs(b.marker)) - n0} executions`);
  db.close();
}

// ── the daemon still protects a call the CELL has forgotten ─────────────────
// npm run conditions found `if (meta.replayed)` unreachable by any claim, and
// working out WHY is the interesting part: the cell's own ledger now answers a
// retry before the env is ever called, so the env's replay signal only matters
// when the cell has forgotten a call the daemon remembers.
//
// /reset is exactly that. It clears the conversation and the op ledger — and it
// must NOT make an already-executed command runnable again. The daemon's ledger
// is the thing standing between a reset and a second `rm -rf`.
{
  const { sql, db } = freshLedger();
  const b = BACKENDS[0];                       // the daemon: the only backend with a ledger of its own
  const bash = () => b.tools(b.env, sql).find((t) => t.name === "bash");
  const CMD = "echo x >> reset-guard.txt; echo RAN";
  const marker = `${process.env.WORK_ROOT}/sess/reset-guard.txt`;
  const call = async (id) => {
    try { const r = await bash().execute(id, { command: CMD }, undefined, undefined, undefined);
          return { text: r.content?.[0]?.text ?? "", details: r.details ?? {} }; }
    catch (e) { return { threw: String(e?.message ?? e) }; }
  };

  const first = await call("c_reset");
  const ranOnce = await runs(marker);
  check("the call runs once", /RAN/.test(first.text ?? "") && ranOnce === 1, `${ranOnce} executions`);

  // The cell forgets: /reset clears ops.
  db.prepare("DELETE FROM ops").run();
  check("the cell's ledger is empty after a reset", db.prepare("SELECT COUNT(*) AS n FROM ops").get().n === 0);

  const after = await call("c_reset");
  check("A RESET DOES NOT MAKE THE COMMAND RUNNABLE AGAIN — the daemon still holds it",
    (await runs(marker)) === ranOnce, `${await runs(marker)} executions, was ${ranOnce}`);
  check("and the answer comes back marked as a replay, so the transcript can say so",
    after.details?.replayed === true, JSON.stringify(after).slice(0, 140));
  db.close();
}

// ── what /ops says a call actually WAS ──────────────────────────────────────
// The ledger's `detail` is what an operator reads during an incident to find
// out which command the agent ran. Found unclaimed by npm run conditions: both
// branches of detailOf could go without breaking anything, and the failure is
// silent — /ops keeps answering, with "undefined" or "[object Object]" where
// the command should be.
{
  const { sql, db } = freshLedger();
  const b = BACKENDS[0];
  const tools = b.tools(b.env, sql);
  const run = async (name, id, args) => {
    try { await tools.find((t) => t.name === name).execute(id, args, undefined, undefined, undefined); } catch { /* the detail is written either way */ }
    return db.prepare("SELECT kind, detail FROM ops WHERE id = ?").get(id) ?? {};
  };

  const bash = await run("bash", "d_bash", { command: "echo hello && ls -la /tmp" });
  check("a bash op records the COMMAND, so /ops says what ran",
    bash.detail === "echo hello && ls -la /tmp", JSON.stringify(bash));

  const write = await run("write", "d_write", { path: "notes/a.txt", content: "x" });
  check("a write op records the path", write.detail === "notes/a.txt", JSON.stringify(write));

  await run("write", "d_seed", { path: "edit-me.txt", content: "one\ntwo\n" });
  const edit = await run("edit", "d_edit", { path: "edit-me.txt", edits: [{ oldText: "one", newText: "1" }] });
  check("an edit op records the path AND how many edits, singular when it is one",
    edit.detail === "edit-me.txt (1 edit)", JSON.stringify(edit));
  const edit2 = await run("edit", "d_edit2", { path: "edit-me.txt", edits: [{ oldText: "two", newText: "2" }, { oldText: "1", newText: "one" }] });
  check("and plural when it is more", edit2.detail === "edit-me.txt (2 edits)", JSON.stringify(edit2));

  // The ledger records enough to recognise a call, never the whole payload: it
  // lives in the cell's SQLite and is flushed to object storage on every change.
  const long = await run("bash", "d_long", { command: `echo ${"x".repeat(900)}` });
  check("a long command is truncated rather than stored whole",
    long.detail.length === 400, `${long.detail.length} chars`);

  // The shape of the failure this exists to catch.
  for (const row of [bash, write, edit, edit2, long]) {
    check(`detail is readable text, not "${String(row.detail).slice(0, 18)}…"`,
      typeof row.detail === "string" && row.detail.length > 0 &&
        !/\[object|undefined/.test(row.detail), JSON.stringify(row));
  }
  db.close();
}

// ── the single-flight join, which needs ONE tool set to exist at all ────────
// A real turn builds its tool set once, so every tool in it shares an in-flight
// map. pi issuing the same toolCallId twice concurrently within that turn is
// what the join is for: the second caller waits for the first and gets its
// RESULT, rather than being refused as an unknown outcome.
//
// The claim above cannot reach this, because it constructs a tool set per call.
{
  const { sql } = freshLedger();
  const b = BACKENDS[0];
  const tools = b.tools(b.env, sql);          // ONE set, as a turn has
  const bash = tools.find((t) => t.name === "bash");
  const marker = `${process.env.WORK_ROOT}/sess/joined.txt`;
  const one = async () => {
    try { const r = await bash.execute("c_joined", { command: "echo x >> joined.txt; sleep 0.3; echo JOINED" }, undefined, undefined, undefined);
          return (r.content?.[0]?.text ?? "").trim(); }
    catch (e) { return `THREW ${String(e?.message ?? e).slice(0, 60)}`; }
  };
  const before = await runs(marker);
  const [a, b2, c] = await Promise.all([one(), one(), one()]);
  check("all three concurrent callers get the RESULT, not a refusal",
    [a, b2, c].every((r) => /JOINED/.test(r)), JSON.stringify([a, b2, c]).slice(0, 160));
  check("and the command ran exactly once", (await runs(marker)) === before + 1,
    `${(await runs(marker)) - before} executions`);
}

// ── the result-size backstop ────────────────────────────────────────────────
// A result too large to store is kept as NULL rather than truncated, because a
// truncated replay is a WRONG answer where no replay is an honest one. The
// branch is unreachable with today's tool limits — measured 2026-09-03, the
// largest result any tool produces is 102,857 bytes against a 200,000 cap — so
// it is exercised directly here, and the relationship that keeps it unreachable
// is pinned below.
{
  const { MAX_STORED_RESULT } = await import("../src/pitools.js");
  const { sql, db } = freshLedger();
  const b = BACKENDS[0];
  const bash = () => b.tools(b.env, sql).find((t) => t.name === "bash");
  const marker = `${process.env.WORK_ROOT}/sess/oversize.txt`;
  // A completed call whose result was too large to keep: status done, result NULL.
  db.prepare("INSERT INTO ops(id, kind, status, started_at, ended_at, result) VALUES ('c_big', 'bash', 'done', ?, ?, NULL)")
    .run(Date.now(), Date.now());
  let out;
  try { out = await bash().execute("c_big", { command: `echo x >> oversize.txt; echo RAN` }, undefined, undefined, undefined); }
  catch (e) { out = { threw: String(e?.message ?? e) }; }
  check("a completed call whose result was not retained is REFUSED, not re-run",
    /too large to retain/.test(out.threw ?? ""), JSON.stringify(out).slice(0, 140));
  const ran = await readFile(marker, "utf8").catch(() => "");
  check("and the command did not execute", ran === "", JSON.stringify(ran));
  db.close();

  // TRUNCATE OR DROP: the decision itself, tested where a tool cannot reach it.
  // A truncated result replays as a WRONG answer — valid-looking JSON that is
  // half a command's output — where a dropped one replays as an honest refusal.
  {
    const { ledger } = await import("../src/pitools.js");
    const { sql: s2, db: db2 } = freshLedger();
    const log = ledger(s2);
    log.begin("c_huge", "bash", "big");
    const huge = { content: [{ type: "text", text: "y".repeat(MAX_STORED_RESULT + 5_000) }] };
    log.finish("c_huge", "done", "big", huge);
    const row = db2.prepare("SELECT status, result FROM ops WHERE id = 'c_huge'").get();
    check("an oversized result is stored as NULL, not truncated",
      row.status === "done" && row.result === null, JSON.stringify({ status: row.status, len: row.result?.length ?? null }));
    // And one just under the cap IS kept, so the guard is a threshold rather
    // than a blanket refusal to store anything large.
    log.begin("c_fits", "bash", "fits");
    log.finish("c_fits", "done", "fits", { content: [{ type: "text", text: "y".repeat(1_000) }] });
    const kept = db2.prepare("SELECT result FROM ops WHERE id = 'c_fits'").get();
    check("a result under the cap is kept, so the guard is a threshold not a blanket",
      typeof kept.result === "string" && kept.result.length > 0, String(kept.result?.length));
    db2.close();
  }

  // THE RELATIONSHIP, pinned. If the daemon's 50k stdout cap or Platinum's is
  // raised past this, a session would start refusing retries it used to answer
  // — and the failure would look like nothing at all until someone retried.
  const DAEMON_STDOUT_CAP = 50_000, DAEMON_STDERR_CAP = 20_000;
  const worstCase = DAEMON_STDOUT_CAP + DAEMON_STDERR_CAP + 8_192; // + envelope
  check("the store cap comfortably exceeds the largest result any tool can produce",
    MAX_STORED_RESULT > worstCase * 2, `cap ${MAX_STORED_RESULT} vs worst case ${worstCase}`);
}

// ── list and grep when the workspace says no ────────────────────────────────
// Found by mutate-guards: removing either throw in fstools.js broke no claim.
// Both failure paths were unexecuted, and the tempting wrong behaviour is to
// return an empty result — a `list` that reports "(empty)" for a directory it
// could not read tells the model the opposite of the truth.
{
  const { sql } = freshLedger();
  for (const b of BACKENDS) {
    const tools = b.tools(b.env, sql);
    const call = async (name, id, args) => {
      try { const r = await tools.find((t) => t.name === name).execute(id, args, undefined, undefined, undefined);
            return { text: r.content?.[0]?.text ?? "" }; }
      catch (e) { return { threw: String(e?.message ?? e) }; }
    };
    const listed = await call("list", `l_fail_${b.name}`, { path: "no/such/directory/anywhere" });
    check(`${b.name}: listing a directory that does not exist FAILS, it does not report empty`,
      /list/.test(listed.threw ?? "") && !/\(empty\)/.test(listed.text ?? ""),
      JSON.stringify(listed).slice(0, 140));
  }
}

// ── grep when the workspace is unreachable ─────────────────────────────────
// The sibling of the list claim above, and it needed a different setup: grep
// runs through exec, and a non-zero exit is an ANSWER there (no matches), not a
// failure. Its throw only fires when the transport itself fails — so the
// backend is pointed at a port nothing is listening on.
//
// The wrong behaviour this pins is "(no matches)": a grep that cannot reach the
// workspace reporting no matches tells the model the file it is looking for
// does not exist.
{
  const { sql } = freshLedger();
  const dead = piTools({ TOOL_DAEMON_URL: "http://127.0.0.1:7199", TOOL_DAEMON_TOKEN: "x" }, "sess", sql);
  let out;
  try { out = await dead.find((t) => t.name === "grep").execute("g_dead", { pattern: "anything" }, undefined, undefined, undefined); }
  catch (e) { out = { threw: String(e?.message ?? e) }; }
  check("grep against an unreachable workspace FAILS rather than reporting no matches",
    /grep:/.test(out.threw ?? "") && !/no matches/.test(JSON.stringify(out)),
    JSON.stringify(out).slice(0, 140));
}

// ── the rule that decides who answers "did it run?" ─────────────────────────
// The cell re-dispatches an in-flight call only to a backend that keeps its own
// ledger. Get this wrong in one direction and Platinum runs side effects twice;
// wrong in the other and the daemon path refuses work it could have resolved.
{
  const { executionEnvFor } = await import("../src/pitools.js");
  const d = executionEnvFor(BACKENDS[0].env, "sess", "probe");
  const p = executionEnvFor(BACKENDS[1].env, "sess", "probe");
  check("the daemon backend advertises its own ledger", d.idempotent === true, String(d.idempotent));
  check("the Platinum backend advertises that it has none", p.idempotent === false, String(p.idempotent));
}

// ── the same tools, on both ─────────────────────────────────────────────────
// The model's abilities must not depend on which backend a deployment happens
// to use. This was four tools on the daemon and six on Platinum.
{
  const names = (b) => b.tools(b.env, freshLedger().sql).map((t) => t.name).sort().join(",");
  const [d, p] = BACKENDS.map(names);
  check("both backends expose exactly the same tool set", d === p, `daemon=[${d}] platinum=[${p}]`);
  check("and it is pi's four plus list and grep", d === "bash,edit,grep,list,read,write", d);
}

// ── list and grep behave the same on both ───────────────────────────────────
for (const b of BACKENDS) {
  const { sql } = freshLedger();
  const tools = b.tools(b.env, sql);
  const run = async (name, id, args) => {
    try { const r = await tools.find((t) => t.name === name).execute(id, args, undefined, undefined, undefined);
          return r.content?.[0]?.text ?? ""; }
    catch (e) { return `THREW ${String(e?.message ?? e)}`; }
  };
  await run("write", `w_${b.name}`, { path: "pkg/mod.py", content: "import os\nTOKEN_MARKER = 2\n" });
  const listed = await run("list", `l_${b.name}`, { path: "pkg" });
  check(`${b.name}: list shows the file with a kind prefix`, /- mod\.py/.test(listed), JSON.stringify(listed).slice(0, 120));
  const hit = await run("grep", `g_${b.name}`, { pattern: "TOKEN_MARKER" });
  check(`${b.name}: grep finds the match with a path and line number`, /mod\.py:2:/.test(hit), JSON.stringify(hit).slice(0, 140));
  const none = await run("grep", `g2_${b.name}`, { pattern: "NOTHING_MATCHES_THIS" });
  check(`${b.name}: no matches is an answer, not an error`, none === "(no matches)", JSON.stringify(none).slice(0, 120));
}

daemon.close();
stub.kill();
console.log(bad ? `\n  ${bad} failure(s) of ${claims}` : `\n  both backends carry the same guarantee: ${claims} claims`);
process.exit(bad ? 1 : 0);
