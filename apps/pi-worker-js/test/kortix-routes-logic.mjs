// THE KORTIX-NATIVE ROUTE SURFACE. A regular sandbox answers `/kortix/*` as
// well as OpenCode's own routes, and the control plane and dashboard prefer
// it: the transcript envelope, the act route, ports, logs, diag, a part's
// bytes, and the commit-push the dashboard uses to open a change request. A
// cell answered four of them and `unknown route` to the rest.
// EXPECTED_PASSES=70
import { DatabaseSync } from "node:sqlite";
import { watchClaims } from "../../tools/crash-reporter.mjs";
import { makeCell, installWorkerGlobals } from "./cell-harness.mjs";
installWorkerGlobals();
let bad = 0;
const check = watchClaims((n, c, d = "") => { if (c) console.log(`  ok    ${n}`); else { console.log(`  FAIL  ${n}${d ? `\n          ${d}` : ""}`); bad++; } });
const { pageSize, messagesPage, actAnswer, portsAnswer, logsAnswer, partAnswer, ACT_KINDS, DEFAULT_MESSAGE_PAGE, MAX_MESSAGE_PAGE } = await import("../src/kortix-runtime.js");
const { unifiedDiff, workingDiff, commitAndPush, git, gitFs } = await import("../src/cell-git.js");
const { cellFs, CELL_CWD } = await import("../src/execenv.cell.js");
const { AgentCell } = await import("../dist/worker.js");

const msg = (id, role, text) => ({ info: { id, role, sessionID: "s", time: { created: 1 } }, parts: [{ id: `${id}-p0`, messageID: id, type: "text", text }] });
const transcript = ["m1", "m2", "m3", "m4", "m5"].map((id, i) => msg(id, i % 2 ? "assistant" : "user", `t${i}`));

// ── paging ──
check("a page size is clamped to the daemon's own bounds, and junk is the default",
  pageSize(undefined) === DEFAULT_MESSAGE_PAGE && pageSize("0") === DEFAULT_MESSAGE_PAGE && pageSize("-4") === DEFAULT_MESSAGE_PAGE
    && pageSize("abc") === DEFAULT_MESSAGE_PAGE && pageSize("5") === 5 && pageSize("100000") === MAX_MESSAGE_PAGE, "");
{
  const body = messagesPage({ sessionId: "s", messages: transcript, epoch: "e1", seq: 9, limit: 2 });
  check("the envelope is the daemon's, field for field",
    body.session_id === "s" && body.epoch === "e1" && body.seq === 9 && body.head_seq === 9 && body.source === "cell"
      && body.count === 2 && body.dropped === 0 && "attachments_referenced" in body && "tool_outputs_truncated" in body, JSON.stringify(Object.keys(body)));
  check("a page with no cursor is the END of the transcript — a transcript is read from its end",
    body.messages.map((m) => m.info.id).join(",") === "m4,m5" && body.first_message_id === "m4" && body.last_message_id === "m5", JSON.stringify(body.messages.map((m) => m.info.id)));
  check("and it says there is more", body.has_more === true, String(body.has_more));
  const all = messagesPage({ sessionId: "s", messages: transcript, limit: 50 });
  check("a page that holds everything says there is no more", all.count === 5 && all.has_more === false, JSON.stringify(all.count));
  const before = messagesPage({ sessionId: "s", messages: transcript, limit: 2, before: "m4" });
  check("`before` pages backwards from a message", before.messages.map((m) => m.info.id).join(",") === "m2,m3", JSON.stringify(before.messages.map((m) => m.info.id)));
  const after = messagesPage({ sessionId: "s", messages: transcript, limit: 2, after: "m2" });
  check("`after` pages forwards from one", after.messages.map((m) => m.info.id).join(",") === "m3,m4", JSON.stringify(after.messages.map((m) => m.info.id)));
  const unknown = messagesPage({ sessionId: "s", messages: transcript, limit: 2, after: "nope" });
  check("a cursor naming nothing is ignored rather than answering an empty page", unknown.count === 2, JSON.stringify(unknown.count));
  const empty = messagesPage({ sessionId: "s", messages: [], epoch: "e", seq: 0 });
  check("an empty transcript is an empty page, not a missing one", empty.count === 0 && empty.messages.length === 0 && empty.first_message_id === null, JSON.stringify(empty));
}

// ── act ──
{
  let stopped = 0;
  const ctx = { sessionId: "s", seq: 4, stop: async () => { stopped++; return true; } };
  const r = await actAnswer({ kind: "stop" }, ctx);
  check("act stop stops the turn and answers ok with the session and the sequence",
    r.status === 200 && r.body.ok === true && r.body.kind === "stop" && r.body.session_id === "s" && r.body.seq === 4 && stopped === 1, JSON.stringify(r));
  const other = await actAnswer({ kind: "stop", session_id: "elsewhere" }, ctx);
  check("an explicit session_id is the one reported", other.body.session_id === "elsewhere", JSON.stringify(other.body));
  const nosession = await actAnswer({ kind: "stop" }, { seq: 0, stop: async () => true });
  check("stopping with no session pinned is a 409, not a silent success", nosession.status === 409 && nosession.body.ok === false, JSON.stringify(nosession));
  for (const kind of ["permission", "question"]) {
    const a = await actAnswer({ kind, id: "x", reply: "once" }, ctx);
    check(`act ${kind} says a cell never asks, rather than pretending to answer`, a.status === 409 && /without prompting/.test(a.body.error), JSON.stringify(a.body));
  }
  const revert = await actAnswer({ kind: "revert", message_id: "m1" }, ctx);
  check("act revert says this runtime does not implement it", revert.status === 409 && /not implemented/.test(revert.body.error), JSON.stringify(revert.body));
  const junk = await actAnswer({ kind: "teleport" }, ctx);
  check("an unknown kind lists what IS supported, the daemon's own courtesy",
    junk.status === 400 && JSON.stringify(junk.body.supported) === JSON.stringify(ACT_KINDS), JSON.stringify(junk.body));
  const missing = await actAnswer({}, ctx);
  check("and a body with no kind says so", missing.status === 400 && /<missing>/.test(missing.body.error), JSON.stringify(missing.body));
}

// ── ports, logs, parts ──
check("ports is an empty list WITH the reason — a 404 would read as a broken runtime",
  portsAnswer().ports.length === 0 && /no processes/.test(portsAnswer().reason), JSON.stringify(portsAnswer()));
check("logs answers the tail, its source and a count", (() => { const l = logsAnswer(["a", "b"], 1); return l.lines.join() === "b" && l.count === 1 && l.source === "cell"; })(), JSON.stringify(logsAnswer(["a", "b"], 1)));
check("logs on an empty cell is empty rather than absent", logsAnswer(undefined).lines.length === 0, "");
{
  const found = partAnswer(transcript, "m2", "m2-p0");
  check("a part is served by its own id", found.status === 200 && found.body.text === "t1", JSON.stringify(found.body));
  check("a missing message and a missing part each say which was missing",
    partAnswer(transcript, "nope", "x").status === 404 && /message not found/.test(partAnswer(transcript, "nope", "x").body.error)
      && /part not found/.test(partAnswer(transcript, "m2", "nope").body.error), "");
}

// ── the diff a cell can make ──
{
  const patch = unifiedDiff("a.txt", "one\ntwo\n", "one\nthree\n");
  check("a diff names the file both sides and carries a hunk header",
    patch.startsWith("diff --git a/a.txt b/a.txt") && patch.includes("--- a/a.txt") && patch.includes("+++ b/a.txt") && /@@ -1,2 \+1,2 @@/.test(patch), JSON.stringify(patch));
  check("an added file has no old side, a deleted one no new side",
    unifiedDiff("n.md", "", "hi\n").includes("--- /dev/null") && unifiedDiff("g.md", "bye\n", "").includes("+++ /dev/null"), "");
  check("no change is no diff", unifiedDiff("a.txt", "same\n", "same\n") === "", "");
}

// ── the routes, on a cell ──
{
  const db = new DatabaseSync(":memory:");
  const sql = { exec(q, ...a) { const t = q.trim(); if (/^(CREATE|INSERT|UPDATE|DELETE)/i.test(t)) { const st = db.prepare(t); a.length ? st.run(...a) : st.run(); return { toArray: () => [], [Symbol.iterator]: function* () {} }; } const rows = db.prepare(t).all(...a); return { toArray: () => rows, [Symbol.iterator]: function* () { yield* rows; } }; } };
  void sql;
  const h = makeCell(AgentCell, { KORTIX_SESSION_ID: "s", TOOLS_BACKEND: "cell" });
  const c = h.cell ?? h;
  const get = async (p) => { const r = await h.fetch(`${p}${p.includes("?") ? "&" : "?"}c=s`); return { status: r.status, body: await r.json().catch(() => null) }; };
  check("GET /kortix/ports answers", (await get("/kortix/ports")).body.ports.length === 0, "");
  check("GET /kortix/logs answers", Array.isArray((await get("/kortix/logs")).body.lines), "");
  const diag = await get("/kortix/diag");
  check("GET /kortix/diag names the runtime, the session and what it holds",
    diag.body.runtime === "cell" && diag.body.engine === "pi" && diag.body.sessionId === "s" && typeof diag.body.messages === "number", JSON.stringify(diag.body).slice(0, 160));
  // AND WHICH DIRECTORY THE PROJECT'S AGENTS AND SKILLS COME FROM. A cell that
  // resolved it before its checkout landed read the v2 path for a v3 project
  // and reported zero skills, which is indistinguishable from a model that
  // chose not to use them — so the dump has to say it out loud.
  check("and it reports the config dir it resolved — null while the workspace has no manifest",
    "configDir" in diag.body && diag.body.configDir === null, JSON.stringify(diag.body.configDir));
  check("and whose system prompt is running: `built-in` when no project agent compiled one",
    diag.body.agent_prompt === "built-in", JSON.stringify(diag.body.agent_prompt));
  {
    // The other half: a project whose agent DID compile a prompt. A config
    // that carries the name and not the body is the failure this distinguishes.
    const cfg = JSON.stringify({ agent: { kortix: { description: "d", prompt: "You are the project's own agent." } } });
    const p = makeCell(AgentCell, { KORTIX_SESSION_ID: "p", TOOLS_BACKEND: "cell", KORTIX_AGENT_NAME: "kortix", KORTIX_COMPILED_AGENT_CONFIG: cfg });
    const got = await (await p.fetch("/kortix/diag?c=p")).json();
    check("and `project` when it did — the two are indistinguishable in every other field",
      got.agent_prompt === "project" && got.agent === "kortix", JSON.stringify({ a: got.agent, p: got.agent_prompt }));
    const bodiless = makeCell(AgentCell, { KORTIX_SESSION_ID: "q", TOOLS_BACKEND: "cell", KORTIX_AGENT_NAME: "kortix", KORTIX_COMPILED_AGENT_CONFIG: JSON.stringify({ agent: { kortix: { description: "d" } } }) });
    const gotQ = await (await bodiless.fetch("/kortix/diag?c=q")).json();
    check("a compiled agent with a NAME and no body reads as `built-in` — the exact shape a misplaced .md compiles to",
      gotQ.agent === "kortix" && gotQ.agent_prompt === "built-in", JSON.stringify({ a: gotQ.agent, p: gotQ.agent_prompt }));
  }
  const messages = await get("/kortix/opencode/messages/s");
  check("GET /kortix/opencode/messages/:id answers the envelope", messages.status === 200 && messages.body.session_id === "s" && Array.isArray(messages.body.messages), JSON.stringify(messages.body).slice(0, 120));
  check("and refuses another session's transcript", (await get("/kortix/opencode/messages/other")).status === 404, "");
  const session = await get("/kortix/opencode/session/s");
  check("GET /kortix/opencode/session/:id is the session object, not a list", session.status === 200 && session.body.id === "s" && !Array.isArray(session.body), JSON.stringify(session.body).slice(0, 120));
  check("GET /kortix/opencode/todo/:id is the list", Array.isArray((await get("/kortix/opencode/todo/s")).body), "");
  check("GET /kortix/opencode/config and /project-current answer the boot shapes",
    typeof (await get("/kortix/opencode/config")).body === "object" && (await get("/kortix/opencode/project-current")).body.worktree === CELL_CWD, "");
  check("GET /kortix/opencode/vcs-diff answers files and a patch, empty on a workspace with no checkout",
    JSON.stringify((await get("/kortix/opencode/vcs-diff")).body) === JSON.stringify({ files: [], patch: "" }), JSON.stringify((await get("/kortix/opencode/vcs-diff")).body));
  const act = await h.fetch("/kortix/opencode/act?c=s", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "stop" }) });
  check("POST /kortix/opencode/act answers the act shape", act.status === 200 && (await act.json()).kind === "stop", String(act.status));
  check("GET /env answers the daemon's bare env route", (await get("/env")).body.ok === true, "");
  check("GET /global/dispose is accepted", (await get("/global/dispose")).body === true, "");
  const proxied = await get("/proxy/3000");
  check("a port proxy is 501 with the reason, not 404 — 'not possible' is not 'not here'",
    proxied.status === 501 && /nothing can listen/.test(proxied.body.detail), JSON.stringify(proxied.body));
  check("and so is the deck converter", (await get("/presentation/convert-to-pdf")).status === 501, "");
}

// ── commit-push, over a real repository ──
{
  const db = new DatabaseSync(":memory:");
  const sql = { exec(q, ...a) { const t = q.trim(); if (/^(CREATE|INSERT|UPDATE|DELETE)/i.test(t)) { const st = db.prepare(t); a.length ? st.run(...a) : st.run(); return { toArray: () => [], [Symbol.iterator]: function* () {} }; } const rows = db.prepare(t).all(...a); return { toArray: () => rows, [Symbol.iterator]: function* () { yield* rows; } }; } };
  const cell = cellFs(sql); await cell.ready;
  const fs = gitFs(cell.fs);
  const noRepo = await commitAndPush({ cell, url: "https://example.test/x.git", token: "t", branch: "b" });
  check("commit-push on a workspace that is not a checkout is a 409 in the daemon's words",
    noRepo.ok === false && noRepo.status === 409 && /not materialized/.test(noRepo.error), JSON.stringify(noRepo));
  await git.init({ fs, dir: CELL_CWD, defaultBranch: "main" });
  await fs.promises.writeFile(`${CELL_CWD}/a.txt`, "one\n");
  await git.add({ fs, dir: CELL_CWD, filepath: "a.txt" });
  await git.commit({ fs, dir: CELL_CWD, message: "base", author: { name: "c", email: "c@k" } });
  await fs.promises.writeFile(`${CELL_CWD}/a.txt`, "two\n");
  await fs.promises.writeFile(`${CELL_CWD}/new.txt`, "added\n");
  // The push itself needs a remote; the commit half is asserted here and the
  // push half is measured live (a real branch on the real origin).
  const pushed = await commitAndPush({ cell, url: "http://127.0.0.1:9/none.git", token: "t", branch: "main", message: "session work" });
  check("commit-push commits the whole working tree before it pushes",
    (await git.log({ fs, dir: CELL_CWD })).length === 2, JSON.stringify(pushed).slice(0, 140));
  const diff = await workingDiff(cell);
  check("and the tree is clean afterwards — the changes are in the commit, not still pending", diff.files.length === 0, JSON.stringify(diff.files));
  check("a push that cannot reach its origin reports the failure rather than claiming success",
    pushed.ok === false && !!pushed.error, JSON.stringify(pushed).slice(0, 140));
}

// THE ROUTES A CLIENT CALLS THAT A CELL ANSWERED `unknown route`.
//
// Measured 2026-09-11 by asking a LIVE cell for every path the SDK, the web
// app and the control plane are known to build on a sandbox base (the audit
// behind scratchpad/probe-routes.sh): twenty-one of them were not served at
// all. Each one fails as something else — the Changes tab is empty, the skills
// list is empty, a reap looks like a broken runtime, a cancelled forward
// leaves its half-written message in the transcript — and none of them looks
// like a missing route from the outside.
//
// The rule: a route a cell CAN do, does it; a route it CANNOT do says so in
// that route's own terms with a status that means "not possible", never 404.
{
  const db = new DatabaseSync(":memory:");
  void db;
  const h = makeCell(AgentCell, { KORTIX_SESSION_ID: "r1", TOOLS_BACKEND: "cell" });
  const c = h.cell ?? h;
  const get = async (p) => { const r = await h.fetch(`${p}${p.includes("?") ? "&" : "?"}c=r1`); return { status: r.status, body: await r.json().catch(() => null) }; };
  const send = async (m, p, body) => {
    const r = await h.fetch(`${p}${p.includes("?") ? "&" : "?"}c=r1`, { method: m, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  // ── the ones a cell can simply do ──
  const skill = await get("/skill");
  check("GET /skill answers OpenCode's own name for the skills list — the one the SDK actually calls",
    skill.status === 200 && Array.isArray(skill.body), JSON.stringify(skill.body).slice(0, 80));
  const diff = await get("/session/r1/diff");
  check("GET /session/:id/diff answers a list of per-file diffs, not the joined patch /kortix/opencode/vcs-diff returns",
    diff.status === 200 && Array.isArray(diff.body), JSON.stringify(diff.body).slice(0, 80));
  check("and it refuses another session's diff", (await get("/session/other/diff")).status === 404, "");

  const turn = await get("/kortix/opencode/turn/msg-nothing");
  check("GET /kortix/opencode/turn/:messageId answers the daemon's fields for a prompt it never saw",
    turn.status === 200 && turn.body.message_id === "msg-nothing" && turn.body.opencode_session_id === "r1"
      && turn.body.in_flight === null && turn.body.end === null && turn.body.orphaned_prompt === false,
    JSON.stringify(turn.body));

  const abort = await send("POST", "/kortix/abort");
  check("POST /kortix/abort is the box-wide stop the reaper sends, and names the session it stopped",
    abort.status === 200 && abort.body.ok === true && abort.body.opencode_session_id === "r1" && abort.body.aborted === false,
    JSON.stringify(abort.body));

  // ── the ones it cannot, each in its own words ──
  const web = await get("/web-proxy/http/example.com");
  check("a web proxy is 501 with the reason, the same answer /proxy gives — a cell forwards nothing",
    web.status === 501 && /no web proxy/.test(web.body.error), JSON.stringify(web.body).slice(0, 90));
  const share = await send("POST", "/session/r1/share");
  check("POST /session/:id/share is 501 and says WHY, rather than 404 which reads as a broken runtime",
    share.status === 501 && /share/.test(share.body.error) && !!share.body.detail, JSON.stringify(share.body).slice(0, 110));
  check("DELETE /session/:id/share is refused the same way", (await send("DELETE", "/session/r1/share")).status === 501, "");
  const revert = await send("POST", "/session/r1/revert", { messageID: "m1" });
  check("revert and unrevert are 501 for the reason act already gives: this transcript is append-only",
    revert.status === 501 && /append-only/.test(revert.body.detail) && (await send("POST", "/session/r1/unrevert")).status === 501,
    JSON.stringify(revert.body).slice(0, 110));
  const perm = await send("POST", "/permission/req-1/reply", { response: "allow" });
  check("a permission or question reply is 409, not 404 — nothing is ASKED in a cell, which is different from the route not existing",
    perm.status === 409 && /without prompting/.test(perm.body.detail)
      && (await send("POST", "/question/req-1/reply")).status === 409,
    JSON.stringify(perm.body).slice(0, 110));

  // ── env: what a session may write, and what it may never read back ──
  // The control plane's own push first, so `secrets` has something dangerous
  // to withhold rather than passing on an empty object.
  await send("POST", "/kortix/env", { env: { KORTIX_TOKEN: "a-real-token", KORTIX_PROJECT_ID: "p1" } });
  const put = await send("PUT", "/env/MY_KEY", { value: "hello" });
  check("PUT /env/:key stores a value the session set for itself", put.status === 200 && put.body.ok === true, JSON.stringify(put.body));
  const env1 = await get("/env");
  check("and GET /env reports it under `secrets`, which is the field the SDK's env editor reads",
    env1.body.secrets?.MY_KEY === "hello", JSON.stringify(env1.body.secrets));
  // THE PLATFORM'S OWN KEYS ARE NOT SECRETS TO HAND BACK. `sessionEnv` holds
  // this session's Kortix token; a route that returned it would turn an env
  // panel into a credential dump.
  check("but the platform's env is NOT in `secrets` — its keys are listed, its values never leave the cell",
    !("KORTIX_TOKEN" in (env1.body.secrets ?? {}))
      && env1.body.keys.includes("KORTIX_TOKEN")
      && !JSON.stringify(env1.body).includes("a-real-token"),
    JSON.stringify(env1.body).slice(0, 160));
  const reserved = await send("PUT", "/env/KORTIX_TOKEN", { value: "stolen" });
  check("and a reserved key cannot be written from a session at all",
    reserved.status === 409 && /reserved/.test(reserved.body.error), JSON.stringify(reserved.body).slice(0, 100));
  check("DELETE /env/:key removes it again",
    (await send("DELETE", "/env/MY_KEY")).status === 200 && !((await get("/env")).body.secrets ?? {}).MY_KEY, "");
}

// ── one message, and the two deletes that cancel a forwarded turn ──
{
  const h = makeCell(AgentCell, { KORTIX_SESSION_ID: "r2", TOOLS_BACKEND: "cell" });
  const c = h.cell ?? h;
  await h.fetch("/?c=r2");
  c.saveMessage("user", { role: "user", content: [{ type: "text", text: "one" }] }, "msg_000000000001aaaaaaaaaaaaaa");
  c.saveMessage("assistant", { role: "assistant", content: [{ type: "text", text: "first" }, { type: "text", text: "second" }] }, "msg_000000000002bbbbbbbbbbbbbb");
  const get = async (p) => { const r = await h.fetch(`${p}?c=r2`); return { status: r.status, body: await r.json().catch(() => null) }; };
  const del = async (p) => { const r = await h.fetch(`${p}?c=r2`, { method: "DELETE" }); return { status: r.status, body: await r.json().catch(() => null) }; };

  const one = await get("/session/r2/message/msg_000000000002bbbbbbbbbbbbbb");
  check("GET /session/:id/message/:messageID is that ONE message with its parts",
    one.status === 200 && one.body.info.id === "msg_000000000002bbbbbbbbbbbbbb" && one.body.parts.length === 2,
    JSON.stringify(one.body).slice(0, 120));
  check("and a message id this session does not have is 404, not an empty 200",
    (await get("/session/r2/message/msg-nope")).status === 404, "");

  // A PART IS BLANKED, NOT SPLICED. Its id is its INDEX in the stored content,
  // so removing the entry would renumber every later part and change ids the
  // client already holds.
  const delPart = await del("/session/r2/message/msg_000000000002bbbbbbbbbbbbbb/part/msg_000000000002bbbbbbbbbbbbbb-p0");
  check("DELETE …/part/:partID removes that part and answers true",
    delPart.status === 200 && delPart.body === true, JSON.stringify(delPart.body));
  const after = await get("/session/r2/message/msg_000000000002bbbbbbbbbbbbbb");
  check("and the SURVIVING part keeps the id it already had — a splice would have renumbered it to -p0",
    after.body.parts.length === 1 && after.body.parts[0].id.endsWith("-p1") && after.body.parts[0].text === "second",
    JSON.stringify(after.body.parts));
  check("deleting the same part twice is 404 the second time, not a silent true",
    (await del("/session/r2/message/msg_000000000002bbbbbbbbbbbbbb/part/msg_000000000002bbbbbbbbbbbbbb-p0")).status === 404, "");

  const delMsg = await del("/session/r2/message/msg_000000000002bbbbbbbbbbbbbb");
  check("DELETE /session/:id/message/:messageID removes the message from the transcript",
    delMsg.status === 200 && delMsg.body === true, JSON.stringify(delMsg.body));
  const left = await get("/session/r2/message");
  check("and the transcript is what is left — the user's message, alone",
    left.body.length === 1 && left.body[0].info.role === "user", JSON.stringify(left.body.map((m) => m.info.role)));
  check("every one of these refuses another session by name",
    (await del("/session/other/message/msg_000000000001aaaaaaaaaaaaaa")).status === 404
      && (await get("/session/other/message/msg_000000000001aaaaaaaaaaaaaa")).status === 404, "");
}

console.log(bad ? `\n${bad} FAILED` : "\nall claims hold");
process.exit(bad ? 1 : 0);
