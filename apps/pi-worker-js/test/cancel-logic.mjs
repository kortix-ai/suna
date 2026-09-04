// CANCELLING A TURN MUST STOP THE COMMAND.
//
// pi's bash tool is handed an abort signal and honours it — for its own return
// value. That is not the same as stopping anything. Before these claims, an
// aborted `sleep 5` slept the full five seconds, ran to completion, and only
// then told the caller it had been cancelled: a user stopping a runaway build
// got no relief, the cell stayed blocked for the whole timeout, and the command
// went on touching the workspace after the agent had stopped listening.
//
// The wire is: pi names it `abortSignal` in ExecOptions (NOT `signal`, which is
// what made this a silent no-op), the env passes it to fetch, the connection
// drops, and the daemon kills the process group.
// Read by test/all.sh. The suite's own tail line catches a section that ran
// and produced nothing; it cannot catch an exit partway through, which skips
// the tail entirely. This is the number that check compares against.
// EXPECTED_PASSES=21

import { mkdir, rm, stat } from "node:fs/promises";
import { piTools } from "../src/pitools.js";
import { watchClaims } from "../../tools/crash-reporter.mjs";

process.env.TOKEN = "cancel-token";
process.env.WORK_ROOT = "/tmp/cancel-work";
const PORT = 7143;
await rm(process.env.WORK_ROOT, { recursive: true, force: true });
await mkdir(process.env.WORK_ROOT, { recursive: true });
const { createDaemon } = await import("../daemon/server.js");
const server = createDaemon();
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

let bad = 0, claims = 0;
const check = watchClaims((n, c, d = "") => { claims++; if (c) console.log(`  ok    ${n}`); else { console.log(`  FAIL  ${n}${d ? `\n          ${d}` : ""}`); bad++; } });

const ops = new Map();
const sql = { exec: (q, ...a) => {
  // The ledger reads its own prior state before every call, so this double
  // has to answer a SELECT, not only record writes.
  if (/^SELECT/i.test(q)) { const r = ops.get(a[0]); return r ? [r] : []; }

  if (/^INSERT OR IGNORE INTO ops/.test(q)) { if (!ops.has(a[0])) ops.set(a[0], { id: a[0], status: "running" }); }
  else if (/^UPDATE ops SET status/.test(q)) { const r = ops.get(a[a.length - 1]); if (r) { r.status = a[0]; r.out = a[1]; r.result = a[2]; } }
} };
const E = { TOOL_DAEMON_URL: `http://127.0.0.1:${PORT}`, TOOL_DAEMON_TOKEN: "cancel-token" };
const bash = () => piTools(E, "sess", sql).find((t) => t.name === "bash");
const run = async (id, command, signal) => {
  const t0 = Date.now();
  try { const r = await bash().execute(id, { command }, signal, undefined, undefined);
        return { ms: Date.now() - t0, text: r.content?.[0]?.text ?? "" }; }
  catch (e) { return { ms: Date.now() - t0, threw: String(e?.message ?? e) }; }
};
const there = async (p, sess = "sess") => await stat(`${process.env.WORK_ROOT}/${sess}/${p}`).then(() => true, () => false);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the caller is released promptly ─────────────────────────────────────────
const ac = new AbortController();
setTimeout(() => ac.abort(), 300);
const aborted = await run("call_abort", "sleep 5; echo LATE > late.txt", ac.signal);
check("an aborted command returns in well under its runtime, not after it",
  aborted.ms < 1500, `${aborted.ms}ms`);
check("and the caller is told it was aborted", /abort/i.test(aborted.threw ?? aborted.text), JSON.stringify(aborted).slice(0, 120));

// ── the command is actually dead ────────────────────────────────────────────
// The claim above is satisfied by merely dropping the connection. This one is
// not: if the daemon kept running it, the side effect lands after the abort.
await sleep(5500);
check("THE COMMAND ITSELF IS KILLED, not left running past the abort",
  (await there("late.txt")) === false, "late.txt was written after the abort");

// ── the whole process group goes, not just bash ─────────────────────────────
// `bash -lc` may exec a subshell; killing bash alone leaves a grandchild
// writing into the workspace with nothing left to observe it.
const ac2 = new AbortController();
setTimeout(() => ac2.abort(), 300);
await run("call_group", "( sleep 4; echo ORPHAN > orphan.txt ) & wait", ac2.signal);
await sleep(4800);
check("a grandchild process is killed with it", (await there("orphan.txt")) === false,
  "orphan.txt was written by a surviving grandchild");

// ── the ledger is not left saying 'may have run' ────────────────────────────
// 'running' is the state that means "outcome unknown", and it makes every later
// retry of that id permanently unanswerable. A cancellation is a known outcome.
check("the cell's op ledger does not strand a cancelled call at 'running'",
  ops.get("call_abort")?.status && ops.get("call_abort").status !== "running",
  JSON.stringify(ops.get("call_abort") ?? null));

// ── an un-aborted command is untouched ──────────────────────────────────────
const fine = await run("call_fine", "echo STILL_FINE");
check("a command with no abort signal still runs normally", /STILL_FINE/.test(fine.text ?? ""), JSON.stringify(fine).slice(0, 100));
const slow = await run("call_slow", "sleep 1; echo SLOW_OK");
check("and a slow one is not cancelled by its own duration", /SLOW_OK/.test(slow.text ?? ""), JSON.stringify(slow).slice(0, 100));

// ── ONE SIGNAL, MANY CALLS: the listener must not outlive its call ──────────
// pi hands the SAME AbortSignal to every tool call in a turn. Each exec adds an
// abort listener that sends /cancel for ITS op, and the finally removes it.
// Without that removal they accumulate for the whole turn, and an abort at the
// end fires a cancel for every op that already completed.
//
// THE FIRST VERSION OF THIS CLAIM WAS HOLLOW and the mutation said so: with
// `{ once: true }` the listener goes after firing, and the daemon answers a
// cancel for a finished op with `cancelled: null` — so nothing downstream
// changes and the claim passed with the cleanup removed.
//
// What IS observable is the cancels themselves. A counting server stands in for
// the daemon, so the leak is measured directly rather than through its
// (tolerated) consequences.
{
  const { createServer } = await import("node:http");
  const { remoteExecutionEnv } = await import("../src/execenv.js");
  let cancels = 0;
  const counter = createServer((q, res) => {
    if (q.url === "/cancel") cancels++;
    let body = ""; q.on("data", (c) => { body += c; });
    q.on("end", () => { res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ stdout: "ok", stderr: "", exitCode: 0 })); });
  });
  await new Promise((r) => counter.listen(PORT + 60, "127.0.0.1", r));

  const shared = new AbortController();
  for (let i = 0; i < 5; i++) {
    const env = remoteExecutionEnv({ base: `http://127.0.0.1:${PORT + 60}`, token: "t", sessionId: "s", cwd: "/w", opId: `shared_${i}` });
    await env.exec("echo ok", { abortSignal: shared.signal });
  }
  check("five completed calls send no cancels of their own", cancels === 0, `${cancels} cancels`);
  shared.abort();
  await sleep(300);
  check("ABORTING A SPENT SIGNAL CANCELS NOTHING — the listeners were removed with their calls",
    cancels === 0, `${cancels} cancels fired for calls that had already finished`);
  await new Promise((r) => counter.close(r));
}

// ── A DROPPED CONNECTION IS NOT A CANCELLATION ──────────────────────────────
// The first version of this killed the command whenever the socket closed. That
// passed every claim above and broke crash recovery, which is the opposite
// case: a cell SIGKILLed mid-command is exactly when the command should FINISH,
// so the retry carrying the same toolCallId is answered from the ledger instead
// of running again. The two are indistinguishable at the socket, so cancelling
// says so on /cancel and a disconnect means nothing.
{
  const ac3 = new AbortController();
  fetch(`http://127.0.0.1:${PORT}/exec`, {
    method: "POST",
    headers: { authorization: "Bearer cancel-token", "content-type": "application/json" },
    body: JSON.stringify({ opId: "call_dropped-exec-0", sessionId: "sess", command: "sleep 2; echo SURVIVED > survived.txt" }),
    signal: ac3.signal,
  }).catch(() => {});
  await sleep(300);
  ac3.abort();              // the caller vanishes — no /cancel is sent
  await sleep(2600);
  check("a command whose caller merely vanished RUNS TO COMPLETION",
    (await there("survived.txt")) === true, "the command was killed by a disconnect alone");
}

// ── /stop: THE ONLY THING THAT CAN TRIGGER ANY OF THE ABOVE ─────────────────
// Everything above is unreachable without a way to abort from outside the run.
// pi creates the abort signal inside agent.prompt(), so the cell has to hold the
// running agent and call abort() on it. It did not, which made a runaway
// command unstoppable for its full timeout however well the layers beneath it
// behaved.
{
  const { installWorkerGlobals, makeCell } = await import("./cell-harness.mjs");
  installWorkerGlobals();
  const { AgentCell } = await import("../dist/worker.js");
  const cell = makeCell(AgentCell, {
    TOOL_DAEMON_URL: `http://127.0.0.1:${PORT}`,
    TOOL_DAEMON_TOKEN: "cancel-token",
    SCRIPT: JSON.stringify([{ text: "idle" }]),
  });
  const post = (p, b) => cell.fetch(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });

  const idle = await (await post("/stop?c=z", {})).json();
  check("/stop on an idle cell says so instead of pretending", idle.stopped === false, JSON.stringify(idle));

  const t0 = Date.now();
  const turn = post("/prompt?c=z", {
    text: "long", script: [{ tool: "bash", id: "stop_me", args: { command: "sleep 6; echo NEVER > never.txt" } }, { text: "done" }],
  });
  await sleep(700);
  const stopped = await (await post("/stop?c=z", {})).json();
  check("/stop reports that it stopped a running turn", stopped.stopped === true, JSON.stringify(stopped));
  await turn.catch(() => {});
  const elapsed = Date.now() - t0;
  check("the turn ends promptly rather than running its command out", elapsed < 4000, `${elapsed}ms`);
  await sleep(6000);
  check("AND THE COMMAND IS DEAD — /stop reaches all the way to the process",
    (await there("never.txt", "z")) === false, "the command finished after /stop");

  // ── /stop?queue=1 also DISCARDS what has not started ──────────────────────
  // Found by npm run conditions: the whole `queue=1` branch could be removed
  // without breaking a claim. It is a user-facing intent — "stop, and drop what
  // I queued" — and the failure mode is silent: the running turn stops, the
  // caller sees success, and the queue keeps draining work they asked to
  // discard.
  //
  // Off by default on purpose, so the contrast is claimed too: stopping the
  // command someone is watching must NOT throw away work they queued.
  {
    const queued = makeCell(AgentCell, { SCRIPT: JSON.stringify([{ text: "ok" }]), CONTEXT_WINDOW: "8000" },
      { alarms: "coalesce", alarmDelayMs: 5000 });
    const send = (t) => queued.fetch("/prompt?c=z&async=1", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: t }) });
    for (let i = 0; i < 4; i++) await send(`queued ${i}`);
    const pendingBefore = queued.rows("SELECT COUNT(*) AS n FROM turns WHERE status='pending'")[0].n;
    check("four turns are queued and not yet started", pendingBefore === 4, `${pendingBefore} pending`);

    // Without queue=1: the queue is left alone.
    const plain = await (await queued.fetch("/stop?c=z", { method: "POST" })).json();
    const stillPending = queued.rows("SELECT COUNT(*) AS n FROM turns WHERE status='pending'")[0].n;
    check("a plain /stop does NOT discard queued work", stillPending === 4 && plain.dropped === 0,
      `${stillPending} pending, dropped=${plain.dropped}`);

    // With queue=1: dropped, counted, and recorded with a reason.
    const withQueue = await (await queued.fetch("/stop?c=z&queue=1", { method: "POST" })).json();
    const afterPending = queued.rows("SELECT COUNT(*) AS n FROM turns WHERE status='pending'")[0].n;
    check("/stop?queue=1 discards every pending turn", afterPending === 0, `${afterPending} pending`);
    check("and reports how many it discarded", withQueue.dropped === 4, JSON.stringify(withQueue));
    const reasons = queued.rows("SELECT error FROM turns WHERE status='error'").map((r) => r.error);
    check("each discarded turn records WHY, rather than vanishing",
      reasons.length === 4 && reasons.every((r) => /dropped by \/stop/.test(r ?? "")), JSON.stringify(reasons.slice(0, 2)));
  }

  // A stopped turn must not wedge the queue: 'running' is the state the alarm
  // claim checks, so a turn stuck there stops every later turn forever.
  const after = await (await post("/prompt?c=z", { text: "after", script: [{ tool: "bash", id: "after_stop", args: { command: "echo AFTER" } }, { text: "ok" }] })).json();
  check("the session still accepts work after a stop", after && !after.error, JSON.stringify(after).slice(0, 120));
  const stuck = cell.rows("SELECT status FROM turns WHERE status='running'");
  check("no turn is left stranded at 'running', which would wedge the queue", stuck.length === 0, JSON.stringify(stuck));
}

await new Promise((r) => server.close(r));
console.log(bad ? `\n  ${bad} failure(s) of ${claims}` : `\n  cancelling a turn stops the command: ${claims} claims`);
process.exit(bad ? 1 : 0);
