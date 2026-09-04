// THE WORKER'S OWN LOGIC, against a fake Durable Object with real SQLite.
//
// The turn queue's claim is the reason this file exists. That bug — six
// concurrent alarms each taking a DIFFERENT pending turn and running them in
// parallel — was invisible on celld 0.4.0, which serialises alarm invocations,
// and only appeared on 0.3.0, which does not. It cost a full Docker run to find
// and another to confirm.
//
// It is pure logic. Here it takes two seconds and no container.
// Read by test/all.sh. The suite's own tail line catches a section that ran
// and produced nothing; it cannot catch an exit partway through, which skips
// the tail entirely. This is the number that check compares against.
// EXPECTED_PASSES=78

import { createServer } from "node:http";
import { makeCell, makeNamespace, installWorkerGlobals } from "./cell-harness.mjs";
import { watchClaims } from "../../tools/crash-reporter.mjs";

installWorkerGlobals();
const mod = await import("../dist/worker.js");
const AgentCell = mod.AgentCell ?? mod.default?.AgentCell;
if (!AgentCell) { console.log("  FAIL  dist/worker.js does not export AgentCell — run `npm run build`"); process.exit(1); }

let bad = 0;
const check = watchClaims((name, cond, detail = "") => {
  if (cond) console.log(`  ok    ${name}`);
  else { console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`); bad++; }
});

const SCRIPT = (id, out) => JSON.stringify([
  { tool: "bash", id, args: { command: `echo ${out}` } },
  { text: `ok ${out}` },
]);

// The daemon is not running here, so tool calls fail — which is fine and even
// useful: the QUEUE's behaviour is what is under test, and a failing turn
// exercises the error path that a happy one never would.
const ENV = { SCRIPT: "[]", TOOL_DAEMON_URL: "http://127.0.0.1:9", TOOL_DAEMON_TOKEN: "t" };

// ── routing ─────────────────────────────────────────────────────────────────
{
  const h = makeCell(AgentCell, ENV);
  const root = await (await h.fetch("/?c=s")).json();
  check("GET / reports the cell's counts", root.ok === true && root.messages === 0, JSON.stringify(root));
  const ctx = await (await h.fetch("/context?c=s")).json();
  check("/context reports tokens and the window",
    ctx.tokens === 0 && ctx.contextWindow > 0 && ctx.wouldCompact === false, JSON.stringify(ctx));
  const model = await (await h.fetch("/model?c=s")).json();
  check("/model says scripted when no key is configured", model.active === "scripted", JSON.stringify(model.active));
  check("/model reports the daemon backend when no PT_* vars are set",
    model.tools.backend === "daemon", JSON.stringify(model.tools));
  const ops = await (await h.fetch("/ops?c=s")).json();
  check("/ops starts empty", Array.isArray(ops.ops) && ops.ops.length === 0);
}

// ── backend selection ───────────────────────────────────────────────────────
{
  const h = makeCell(AgentCell, { ...ENV, PT_API_URL: "http://x", PT_SANDBOX_KEY: "k", PT_WORKSPACE_ID: "sbx" });
  const model = await (await h.fetch("/model?c=s")).json();
  check("all three PT_* vars select the platinum backend",
    model.tools.backend === "platinum" && model.tools.workspace === "sbx", JSON.stringify(model.tools));
}
{
  // Two of three is a half-configured backend, which must NOT silently win.
  const h = makeCell(AgentCell, { ...ENV, PT_API_URL: "http://x", PT_SANDBOX_KEY: "k" });
  const model = await (await h.fetch("/model?c=s")).json();
  check("a half-configured platinum backend falls back to the daemon",
    model.tools.backend === "daemon", JSON.stringify(model.tools));
}

// ── THE TURN QUEUE ──────────────────────────────────────────────────────────
{
  const h = makeCell(AgentCell, ENV);
  const accepted = await Promise.all([1, 2, 3, 4, 5, 6].map((i) =>
    h.fetch("/prompt?c=s&async=1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: `p${i}`, script: JSON.parse(SCRIPT(`q${i}`, i)) }),
    })));
  check("every concurrent prompt is accepted with 202",
    accepted.every((r) => r.status === 202), accepted.map((r) => r.status).join(","));

  const queued = h.rows("SELECT status FROM turns");
  check("all six are queued durably as rows", queued.length === 6, `${queued.length} rows`);

  await h.drain();
  const done = h.rows("SELECT i, status FROM turns ORDER BY i");
  check("every queued turn reaches a terminal state",
    done.every((t) => t.status === "done" || t.status === "error"),
    JSON.stringify(done));

  // THE CLAIM. One user message per turn, in queue order, never interleaved.
  const roles = h.rows("SELECT role FROM msgs ORDER BY i").map((r) => r.role);
  const users = roles.filter((r) => r === "user").length;
  check("exactly one user message per turn", users === 6, `${users} user messages in ${roles.length}`);
  check("turns did not interleave (no two user messages adjacent)",
    !roles.some((r, i) => r === "user" && roles[i + 1] === "user"),
    roles.join(","));
}

// ── one turn at a time, checked directly ────────────────────────────────────
{
  const h = makeCell(AgentCell, ENV);
  for (const i of [1, 2, 3]) {
    await h.fetch("/prompt?c=s&async=1", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: `p${i}`, script: JSON.parse(SCRIPT(`r${i}`, i)) }),
    });
  }
  // Fire several alarms by hand, the way overlapping invocations do on celld
  // 0.3.0. Checking the state AFTER they settle proves nothing — by then they
  // have all finished. The invariant that actually breaks is the TRANSCRIPT: an
  // alarm claims, writes its user message, and only then awaits, so a second
  // alarm that claims a different turn writes its user message immediately
  // after the first. Two adjacent user messages is the signature.
  await Promise.all([h.cell.alarm(), h.cell.alarm(), h.cell.alarm()]);
  await h.drain();
  const seq = h.rows("SELECT role FROM msgs ORDER BY i").map((r) => r.role);
  check("concurrent alarms do not interleave two turns",
    !seq.some((r, i) => r === "user" && seq[i + 1] === "user"),
    seq.join(","));
  const stuck = h.rows("SELECT status FROM turns WHERE status='running'");
  check("no turn is left running once the alarms settle", stuck.length === 0, JSON.stringify(stuck));
}

// ── the re-arm, which only runs after a turn completes ──────────────────────
// `if (more > 0) setAlarm(now + 1)`, and nothing asked what happens at zero.
//
// MEASURED, correcting the first version of this comment: `>= 0` is not an
// infinite hot loop. The spurious alarm it arms finds no pending turn and
// returns BEFORE reaching the re-arm, so the cost is one extra wake per drained
// queue — metered, and on a cell that should be asleep.
//
// Observed as a CHANGE across an awaited alarm() rather than as "no alarm is
// set": the prompt itself arms one, so the absolute value is never null here.
// Two earlier versions of this claim passed under the mutation — one read
// getAlarm() after drain(), which races the harness timer that nulls it, and
// one called alarm() on an EMPTY queue, which returns before the re-arm line is
// ever reached.
{
  const h = makeCell(AgentCell, ENV, { alarmDelayMs: 60_000 });
  await h.fetch("/prompt?c=s&async=1", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "only turn", script: JSON.parse(SCRIPT("done", 1)) }),
  });
  const armedBefore = await h.cell.state.storage.getAlarm();
  await h.cell.alarm();
  const armedAfter = await h.cell.state.storage.getAlarm();
  check("the LAST turn does not arm another alarm — a drained cell is left asleep",
    armedAfter === armedBefore,
    `armed ${armedBefore} -> ${armedAfter}, pending ${h.rows("SELECT COUNT(*) AS n FROM turns WHERE status='pending'")[0].n}`);
}

// ── a turn from a previous life ─────────────────────────────────────────────
{
  const h = makeCell(AgentCell, ENV);
  await h.fetch("/?c=s");   // create the tables
  h.db.prepare(
    "INSERT INTO turns(text, script, window, status, created_at, started_at) VALUES (?, NULL, 0, 'running', ?, ?)",
  ).run("orphan", Date.now() - 600_000, Date.now() - 600_000);
  await h.cell.alarm();
  const orphan = h.rows("SELECT status, error FROM turns")[0];
  check("a turn left running by a dead cell is marked interrupted, not re-run",
    orphan.status === "interrupted" && /died/.test(orphan.error ?? ""),
    JSON.stringify(orphan));
}

// ── the transcript survives a new instance ──────────────────────────────────
{
  const h = makeCell(AgentCell, ENV);
  await h.fetch("/prompt?c=s&async=1", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "remember me", script: JSON.parse(SCRIPT("m1", "x")) }),
  });
  await h.drain();
  const before = h.rows("SELECT COUNT(*) AS n FROM msgs")[0].n;
  // A new instance over the SAME storage is what an eviction produces.
  const second = new AgentCell(
    { ...h.cell.state, storage: h.cell.state.storage, id: { toString: () => "harness-cell" } },
    ENV,
  );
  const hist = await (await second.fetch(new Request("http://cell/history?c=s"))).json();
  check("a fresh instance reads the transcript back from storage",
    hist.messages.length === before && before > 0, `${hist.messages.length} vs ${before}`);
}

// ── compaction, in the cell rather than in the abstract ─────────────────────
{
  // A tiny window so compaction is reachable in a handful of turns. The
  // per-request override exists precisely so this needs no restart and no
  // 200k-token transcript.
  const h = makeCell(AgentCell, ENV);
  const PAD = "padding ".repeat(120);
  for (let i = 1; i <= 10; i++) {
    await h.fetch("/prompt?c=s&async=1", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: `turn ${i} ${PAD}`, contextWindow: 3000, script: JSON.parse(SCRIPT(`c${i}`, i)) }),
    });
  }
  await h.drain(20000);

  // THE ACTIVE WINDOW, not the whole table. Compaction no longer deletes what
  // it summarised — the archive stays for /history and for audit — so the head
  // of `msgs` is still the first thing that was ever said. The head of the
  // CONTEXT is the summary, and that is what this claims.
  const from = h.rows("SELECT COALESCE((SELECT v FROM meta WHERE k='context_from'), '0') AS v")[0].v;
  const roles = h.rows(`SELECT role FROM msgs WHERE i >= ${Number(from)} ORDER BY i`).map((r) => r.role);
  check("compaction fired and left a summary at the head of the context",
    roles[0] === "compactionSummary", `from=${from} ${roles.slice(0, 4).join(",")}`);
  check("and the messages it summarised are still on disk",
    h.rows("SELECT COUNT(*) AS n FROM msgs")[0].n > roles.length,
    `${h.rows("SELECT COUNT(*) AS n FROM msgs")[0].n} rows vs ${roles.length} in context`);
  check("the summary keeps its own role rather than becoming an assistant turn",
    h.rows("SELECT COUNT(*) AS n FROM msgs WHERE role='compactionSummary'")[0].n >= 1);
  check("the retained tail begins at a user message",
    roles[1] === "user", roles.slice(0, 3).join(","));

  // The rewrite writes the new rows and THEN deletes the old ones by id. If the
  // order were reversed a crash between them would lose the conversation, so
  // this asserts the outcome: nothing is left behind and nothing is duplicated.
  const summaries = h.rows("SELECT COUNT(*) AS n FROM msgs WHERE role='compactionSummary'")[0].n;
  check("the rewrite leaves no orphaned copies of the transcript",
    roles.length < 40 && summaries <= 3, `${roles.length} messages, ${summaries} summaries`);

  const ctx = await (await h.fetch("/context?c=s&window=3000")).json();
  check("/context reports the compacted size", ctx.messages === roles.length, JSON.stringify(ctx).slice(0, 110));
  // The count and the token figure on this endpoint must describe the SAME
  // thing. They did not once the archive stopped being deleted.
  check("/context counts the context, and reports the archive separately",
    ctx.archived === h.rows("SELECT COUNT(*) AS n FROM msgs")[0].n - roles.length,
    JSON.stringify({ archived: ctx.archived, total: h.rows("SELECT COUNT(*) AS n FROM msgs")[0].n, ctx: roles.length }));
}

// ── the queue and ledger are observable ─────────────────────────────────────
{
  const h = makeCell(AgentCell, ENV);
  await h.fetch("/prompt?c=s&async=1", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "t", script: JSON.parse(SCRIPT("t1", "x")) }),
  });
  await h.drain();
  const turns = await (await h.fetch("/turns?c=s")).json();
  check("/turns exposes the queue with terminal status",
    turns.turns.length === 1 && ["done", "error"].includes(turns.turns[0].status),
    JSON.stringify(turns.turns[0] ?? {}).slice(0, 90));
  const ops = await (await h.fetch("/ops?c=s")).json();
  check("the op ledger recorded the tool call", ops.ops.length === 1 && ops.ops[0].kind === "bash",
    JSON.stringify(ops.ops[0] ?? {}).slice(0, 90));
  check("a failed tool leaves the op resolved, not stuck at running",
    ops.ops[0].status !== "running", ops.ops[0].status);

  await h.fetch("/reset?c=s");
  const after = await (await h.fetch("/?c=s")).json();
  check("/reset clears the transcript and the ledger", after.messages === 0 && after.ops === 0, JSON.stringify(after));
}

// ── pi's edit tool, THROUGH the cell, against a real daemon ─────────────────
// Everything above tolerates a dead daemon because it tests the queue. This one
// starts the real daemon in-process, drives an `edit` turn through /prompt, and
// asserts the file on disk changed exactly as asked — the whole reason
// ExecutionEnv exists, proven where it will actually run.
{
  const { rm, mkdir, readFile } = await import("node:fs/promises");
  process.env.TOKEN = "cell-edit-token";
  process.env.WORK_ROOT = "/tmp/cell-edit-work";
  await rm(process.env.WORK_ROOT, { recursive: true, force: true });
  await mkdir(process.env.WORK_ROOT, { recursive: true });
  const { createDaemon } = await import("../daemon/server.js");
  const server = createDaemon();
  await new Promise((r) => server.listen(7127, "127.0.0.1", r));

  const h = makeCell(AgentCell, { ...ENV, TOOL_DAEMON_URL: "http://127.0.0.1:7127", TOOL_DAEMON_TOKEN: "cell-edit-token" }, { id: "s" });
  const prompt = (text, script) => h.fetch("/prompt?c=s&async=1", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, script }),
  });
  await prompt("seed", [{ tool: "write", id: "w1", args: { path: "app.py", content: "alpha\nbeta\ngamma\n" } }, { text: "ok" }]);
  await h.drain();
  await prompt("edit", [{ tool: "edit", id: "e1", args: { path: "app.py", edits: [{ oldText: "beta", newText: "BETA" }] } }, { text: "ok" }]);
  await h.drain();

  const disk = await readFile("/tmp/cell-edit-work/s/app.py", "utf8");
  check("pi's edit tool, driven through the cell, changed exactly the target line",
    disk === "alpha\nBETA\ngamma\n", JSON.stringify(disk));
  const ops = h.rows("SELECT id, kind, status FROM ops ORDER BY started_at");
  check("both tool calls are in the ledger under pi's tool names",
    ops.map((o) => o.kind).join(",") === "write,edit", JSON.stringify(ops));
  check("both resolved to done, not stranded at running",
    ops.every((o) => o.status === "done"), JSON.stringify(ops));
  const names = (await (await h.fetch("/model?c=s")).json()).tools.backend;
  check("the daemon backend is the one that ran them", names === "daemon", names);
  server.close();
}

// ── the bill, measured rather than estimated ────────────────────────────────
// pi applies prompt caching itself and the catalogue prices a cache read at
// roughly a tenth of an input token. /context used to price the whole
// transcript at the full input rate every turn, which overstates a long session
// and hides whether caching is working at all. These drive a model that reports
// real usage — including cache reads — and check the arithmetic.
{
  const { scriptedStream } = await import("../src/scripted.js");
  void scriptedStream; // the cell builds its own; this asserts the module loads

  // A real model must be CONFIGURED for prices to exist — /context reads the
  // catalogue record, which needs no network. With the scripted model there are
  // no rates and the money fields are correctly absent, which is its own claim
  // below.
  // NO api key: a key would switch the scripted model off and send the turn to
  // the real provider. A price needs only the catalogue, which is the point of
  // pricedModel().
  const PRICED = { ...ENV, MODEL_PROVIDER: "anthropic", MODEL_ID: "claude-sonnet-5" };
  const h = makeCell(AgentCell, PRICED);
  await h.fetch("/?c=s");

  // Usage as a provider reports it: DRIVEN through real turns, not inserted.
  // Inserting rows tests the arithmetic and nothing about whether the cell ever
  // records anything — a version that recorded nothing passed that way.
  const turn = (usage) => h.fetch("/prompt?c=s&async=1", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "t", script: [{ text: "reply", usage }] }),
  });
  await turn({ input: 1000, output: 500, cacheRead: 9000, cacheWrite: 200 });
  await h.drain();
  await turn({ input: 2000, output: 300 });
  await h.drain();
  check("usage is recorded from the assistant message, one row per turn",
    h.rows("SELECT COUNT(*) AS n FROM usage")[0].n === 2,
    JSON.stringify(h.rows("SELECT * FROM usage")));

  const ctx = await (await h.fetch("/context?c=s")).json();
  const a = ctx.actual;
  check("actual usage is summed across turns",
    a.input === 3000 && a.output === 800 && a.cacheRead === 9000 && a.cacheWrite === 200, JSON.stringify(a));
  // 9000 cached of 12000 billed input-side.
  check("the cache hit rate is cacheRead over billed input",
    a.cacheHitRate === 0.75, String(a.cacheHitRate));
  check("turns with no usage are not counted as turns", a.turnsWithUsage === 2, String(a.turnsWithUsage));
  check("spend and cache savings are reported as numbers",
    typeof a.spentUSD === "number" && typeof a.savedByCacheUSD === "number", JSON.stringify(a));
  check("a cache read is priced BELOW an input token, so caching shows a saving",
    a.savedByCacheUSD > 0, `saved=${a.savedByCacheUSD} spent=${a.spentUSD}`);
  check("the estimate is still reported alongside the actual",
    typeof ctx.cost?.perTurn === "number", JSON.stringify(ctx.cost));
  check("the money is priced from the catalogue, not a table of ours",
    ctx.cost.perMillionInputTokens === 2, String(ctx.cost.perMillionInputTokens));

  // And with no model configured there are no prices to report — better than
  // inventing them.
  const scripted = makeCell(AgentCell, ENV);
  await scripted.fetch("/?c=s");
  await scripted.fetch("/prompt?c=s&async=1", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "t", script: [{ text: "reply", usage: { input: 10, output: 10 } }] }),
  });
  await scripted.drain();
  const sctx = await (await scripted.fetch("/context?c=s")).json();
  check("a scripted session reports usage but no invented prices",
    sctx.actual.input === 10 && sctx.actual.spentUSD === undefined && sctx.cost === undefined,
    JSON.stringify({ actual: sctx.actual, cost: sctx.cost }).slice(0, 120));
}

// ── forking a session ───────────────────────────────────────────────────────
// A cell IS a session, so a fork is another cell holding a prefix of this one's
// transcript. A cell cannot write a sibling's SQLite — that isolation is the
// point — so the parent reads and the child imports over the DO binding.
{
  const { ns, cell } = makeNamespace(AgentCell, ENV);
  const parent = cell("mother");
  const post = (c, path, body) => c.cell.fetch(new Request(`http://cell${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));

  for (const i of [1, 2, 3]) {
    await post(parent, "/prompt?c=mother&async=1", { text: `p${i}`, script: [{ text: `reply ${i}` }] });
    await parent.drain();
  }
  const parentCount = parent.rows("SELECT COUNT(*) AS n FROM msgs")[0].n;
  check("the parent has a transcript to fork", parentCount === 6, String(parentCount));

  // Fork the whole thing.
  const full = await (await post(parent, "/fork", { to: "child-full" })).json();
  check("a full fork reports what it copied", full.ok && full.forked === parentCount, JSON.stringify(full));
  const childFull = cell("child-full");
  check("the child holds the same transcript",
    childFull.rows("SELECT COUNT(*) AS n FROM msgs")[0].n === parentCount,
    String(childFull.rows("SELECT COUNT(*) AS n FROM msgs")[0].n));
  check("in the same order, with roles preserved",
    childFull.rows("SELECT role FROM msgs ORDER BY i").map((r) => r.role).join(",") ===
    parent.rows("SELECT role FROM msgs ORDER BY i").map((r) => r.role).join(","));

  // Fork a PREFIX — branching at a point is the whole feature.
  const part = await (await post(parent, "/fork", { to: "child-part", upTo: 2 })).json();
  check("a prefix fork copies only that far", part.forked === 2 && part.of === parentCount, JSON.stringify(part));
  // upTo COUNTS MESSAGES AND ZERO IS A NUMBER. The clamp is `upTo >= 0`, and
  // `> 0` reads a request for nothing as a request for everything — the fork
  // silently becomes a full copy. Nothing asked for zero until the boundary
  // auditor moved the comparison.
  const none = await (await post(parent, "/fork", { to: "child-none", upTo: 0 })).json();
  check("upTo: 0 forks NOTHING, and is not read as 'all of it'",
    none.forked === 0 && cell("child-none").rows("SELECT COUNT(*) AS n FROM msgs")[0].n === 0,
    JSON.stringify(none));
  const childPart = cell("child-part");
  check("the branch child has exactly the prefix",
    childPart.rows("SELECT COUNT(*) AS n FROM msgs")[0].n === 2);

  // The branches are INDEPENDENT: a turn on one must not appear on the other.
  await post(childPart, "/prompt?c=child-part&async=1", { text: "only here", script: [{ text: "branch reply" }] });
  await childPart.drain();
  check("a turn on the branch does not reach the parent",
    parent.rows("SELECT COUNT(*) AS n FROM msgs")[0].n === parentCount,
    String(parent.rows("SELECT COUNT(*) AS n FROM msgs")[0].n));
  check("nor the other branch",
    childFull.rows("SELECT COUNT(*) AS n FROM msgs")[0].n === parentCount);

  // The op ledger is NOT copied: those ids belong to calls the parent made, and
  // a child claiming them would have the daemon answer its retry from the
  // parent's result.
  const childOps = childFull.rows("SELECT id, kind FROM ops");
  check("the child does not inherit the parent's op ids",
    childOps.every((o) => o.kind === "fork"), JSON.stringify(childOps));
  check("but it records where it came from",
    childOps.some((o) => o.kind === "fork"), JSON.stringify(childOps));

  // Refusals.
  const onto = await post(parent, "/fork", { to: "child-full" });
  check("forking onto a session that already has a transcript is refused",
    onto.status === 400 || onto.status === 409 || (await onto.clone().json()).error !== undefined,
    String(onto.status));
  const self = await post(parent, "/fork", { to: "mother" });
  check("a session cannot fork onto itself", self.status === 400, String(self.status));
  const nowhere = await post(parent, "/fork", {});
  check("a fork with no target is refused", nowhere.status === 400, String(nowhere.status));
  void ns;
}

// ── the harness models a REAL cursor, not a friendlier one ──────────────────
// celld hands the worker a SqlStorageCursor, which is consumed once. This
// double used to return the same rows however many times they were asked for —
// more permissive than production, so worker code that read a cursor twice
// would pass here and get nothing the second time in a real cell.
//
// The guard is only worth having if it fires, so this drives it directly.
{
  // A cell of its own, so this does not consume a cursor another claim is
  // still holding.
  const hc = makeCell(AgentCell, ENV);
  await hc.fetch("/history?c=cursor");
  const c = hc.cell.sql.exec("SELECT COUNT(*) AS n FROM msgs");
  const first = c.toArray();
  check("a cursor can be read once", Array.isArray(first) && first.length === 1, JSON.stringify(first));
  let threw = null;
  try { c.toArray(); } catch (e) { threw = String(e?.message ?? e); }
  check("and reading it a SECOND time throws, as a real cell would return nothing",
    /consumed twice/.test(threw ?? ""), String(threw));
  let threw2 = null;
  const c2 = hc.cell.sql.exec("SELECT COUNT(*) AS n FROM msgs");
  [...c2];
  try { [...c2]; } catch (e) { threw2 = String(e?.message ?? e); }
  check("iterating twice throws too, not only toArray twice",
    /consumed twice/.test(threw2 ?? ""), String(threw2));
}

// ── the queue drains under AT-MOST-ONE-ALARM, not only under overlap ────────
// celld 0.3.0 delivers overlapping alarms and the harness models that, which is
// what caught the claim race. It also hid the opposite hazard: Cloudflare and
// celld 0.4.0 keep at most ONE pending alarm, so N prompts leave one alarm, one
// alarm runs one turn, and a queue that does not re-arm strands the rest
// forever.
//
// Found by npm run conditions — disabling `if (more > 0)` broke nothing,
// because every prompt got its own timer.
{
  // 300ms of held-back delivery: long enough for all five prompts to be PENDING
  // when the single surviving alarm finally fires.
  const q = makeCell(AgentCell, ENV, { alarms: "coalesce", alarmDelayMs: 300 });
  for (let i = 1; i <= 5; i++) {
    await q.fetch("/prompt?c=q&async=1", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: `queued ${i}` }),
    });
  }
  const drained = await q.drain(20000);
  const left = q.rows("SELECT COUNT(*) AS n FROM turns WHERE status IN ('pending','running')")[0].n;
  const done = q.rows("SELECT COUNT(*) AS n FROM turns WHERE status='done'")[0].n;
  check("five queued turns all run when the runtime keeps only ONE alarm",
    drained && left === 0 && done === 5, `drained=${drained} left=${left} done=${done}`);
  const users = q.rows("SELECT COUNT(*) AS n FROM msgs WHERE role='user'")[0].n;
  check("and every prompt reached the transcript, none stranded", users === 5, `${users} user messages`);
}

// ── the socket upgrade, on both runtimes ────────────────────────────────────
// `acceptWebSocket` hands the socket to the RUNTIME, so it outlives the isolate
// being evicted — that is the whole reason a parked session costs a file
// descriptor instead of memory. `accept()` keeps it on this instance and loses
// it. celld offers the first; a runtime that does not is why the fallback
// exists, and the harness always provided acceptWebSocket, so neither the
// fallback nor the CHOICE had ever run.
//
// A version calling acceptWebSocket unconditionally passes every other claim in
// this file and throws a TypeError on any runtime without it.
{
  const upgrade = () => ({ headers: { upgrade: "websocket" } });

  const hib = makeCell(AgentCell, ENV);
  const res = await hib.fetch("/?c=sess-a", upgrade());
  check("the upgrade is a 101 carrying a socket", res.status === 101 && res.webSocket !== undefined,
    `${res.status} ${typeof res.webSocket}`);
  check("on a runtime WITH hibernation the socket is handed to the runtime, not kept by the cell",
    hib.sockets.length === 1, `runtime holds ${hib.sockets.length}`);
  check("tagged with the session, which is how a broadcast finds it again",
    JSON.stringify(hib.acceptedTags[0]) === JSON.stringify(["sess-a"]), JSON.stringify(hib.acceptedTags));
  // "A parked session that is woken every 30s by a heartbeat is not parked."
  check("and a ping/pong auto-response is registered, so a keepalive does not wake the isolate",
    hib.autoResponses.length === 1 && hib.autoResponses[0]?.req === "ping" && hib.autoResponses[0]?.res === "pong",
    JSON.stringify(hib.autoResponses));
  // Written on the SERVER end of the pair — the client end is the one returned
  // in the response, and the harness does not wire the two together.
  const hello = JSON.parse(hib.sockets[0]?.sent?.[0] ?? "{}");
  check("the client is told where things stand immediately, without waiting for an event",
    hello.type === "hello" && hello.sessionId === "sess-a", JSON.stringify(hello).slice(0, 120));

  // The other runtime: no acceptWebSocket at all.
  const plain = makeCell(AgentCell, ENV, { sockets: "plain" });
  const res2 = await plain.fetch("/?c=sess-b", upgrade());
  check("a runtime WITHOUT hibernation still completes the upgrade rather than throwing",
    res2.status === 101 && res2.webSocket !== undefined, `${res2.status}`);
  check("and the cell keeps the socket itself, since nothing else will",
    plain.cell.sockets.size === 1, `cell holds ${plain.cell.sockets.size}`);
  check("the runtime is handed nothing, because it has nowhere to put it",
    plain.sockets.length === 0, `runtime holds ${plain.sockets.length}`);
  const hello2 = JSON.parse([...plain.cell.sockets][0]?.sent?.[0] ?? "{}");
  check("and the client still gets its hello", hello2.type === "hello" && hello2.sessionId === "sess-b",
    JSON.stringify(hello2).slice(0, 120));
}

// ── what a watcher actually sees during a turn ──────────────────────────────
// The subscription is the streaming contract. Tool events are rewritten to
// carry detail — "previously this sent only {type}, which tells a UI that
// something happened and nothing about what" — and everything else is forwarded
// bare. Three conditionals, none of them ever run outside Docker.
//
// The one that matters most is the exclusion on the third: without it a tool
// event goes out TWICE, once detailed and once bare, and a UI counting tool
// starts silently doubles.
{
  // A daemon that answers with a long stdout, because the truncation below is a
  // bound on what gets pushed to every connected socket.
  const daemon = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ stdout: "L".repeat(1000), stderr: "", exitCode: 0, killed: false, cancelled: false }));
    });
  });
  await new Promise((r) => daemon.listen(0, "127.0.0.1", r));
  const h = makeCell(AgentCell, { ...ENV, TOOL_DAEMON_URL: `http://127.0.0.1:${daemon.address().port}` });
  await h.fetch("/?c=w", { headers: { upgrade: "websocket" } });
  await h.fetch("/prompt?c=w&async=1", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "go", script: [{ tool: "bash", id: "call-7", args: { command: "echo hi" } }, { text: "done" }] }),
  });
  await h.drain();
  daemon.close();

  const frames = h.sockets[0].sent.map((f) => JSON.parse(f));
  const start = frames.filter((f) => f.type === "tool_start");
  const end = frames.filter((f) => f.type === "tool_end");
  check("a watcher is told WHICH tool started, not merely that something did",
    start.length === 1 && start[0].tool === "bash" && start[0].id === "call-7", JSON.stringify(start));
  check("and gets the output when it finishes, under the same id, so a UI can pair them",
    end.length === 1 && end[0].id === "call-7" && typeof end[0].output === "string", JSON.stringify(end).slice(0, 140));
  check("the output is TRUNCATED — an unbounded tool result is pushed to every connected socket",
    end[0].output.length === 400, `${end[0].output.length} chars`);

  // The exclusion. A tool event must not also arrive in its raw form.
  const raw = frames.filter((f) => f.type === "tool_execution_start" || f.type === "tool_execution_end");
  check("a tool event is sent ONCE — the raw form is not forwarded alongside the detailed one",
    raw.length === 0, JSON.stringify(raw));

  // And everything that is not a tool event still reaches the watcher.
  const kinds = new Set(frames.map((f) => f.type));
  const expected = ["hello", "turn_started", "agent_start", "turn_start", "message_start", "message_end", "turn_end", "agent_end", "turn_done"];
  check("every other event is still forwarded, so a UI can follow the turn",
    expected.every((k) => kinds.has(k)), `missing ${expected.filter((k) => !kinds.has(k)).join(", ")}`);
  check("and tool_execution_update, which carries no detail here, comes through as itself",
    kinds.has("tool_execution_update"), JSON.stringify([...kinds]));
}

// ── the schema is built once, not on every request ──────────────────────────
// init() opens with `if (this.ready) return`, and removing it changes no
// answer: the statements are CREATE TABLE IF NOT EXISTS, so re-running them is
// idempotent. Verified against the Docker suites too, not just these — the
// mutant survives e2e.sh, which deploys to a real celld node and drives a whole
// turn through it. Nothing anywhere covers this guard.
//
// What it costs is the point. A cell's SQLite is flushed to object storage on
// every change, every HTTP request to a cell calls init(), and there are five
// tables. So the claim is about statements issued, which is the only thing that
// moves when the guard goes.
{
  const h = makeCell(AgentCell, ENV);
  await h.fetch("/health?c=s");
  const creates = () => h.sqlLog.filter((q) => /^CREATE TABLE/i.test(q)).length;
  const first = creates();
  check("the first request builds the schema", first > 0, `${first} CREATE statements`);
  for (let i = 0; i < 10; i++) await h.fetch(`/history?c=s&n=${i}`);
  check("and ten more requests add NOT ONE — this SQLite is flushed to object storage on every change",
    creates() === first, `${creates()} after eleven requests, was ${first}`);
  // A rebuilt instance is a new isolate and must set itself up again; the guard
  // is per-instance, not per-cell.
  const woken = h.rebuild();
  await woken.fetch("/health?c=s");
  check("a rebuilt instance does build it again, because `ready` did not survive the eviction",
    woken.sqlLog.filter((q) => /^CREATE TABLE/i.test(q)).length === first,
    `${woken.sqlLog.filter((q) => /^CREATE TABLE/i.test(q)).length} vs ${first}`);
}

console.log(bad ? `\n  ${bad} failure(s)` : "\n  the cell's logic holds");
process.exit(bad ? 1 : 0);
