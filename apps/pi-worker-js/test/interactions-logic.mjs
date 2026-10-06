// THE PROJECT'S PERMISSION POLICY AND THE QUESTION TOOL, IN A CELL.
//
// kortixd's pi harness checks the compiled agent's `permission` block before
// every tool call: `deny` blocks, `ask` waits for `/permission/:id/reply`, and
// `question` waits for `/question/:id/reply|reject` (harness/pi/interactions.ts,
// runtime.ts `toolGate`). The cell ignored the block: an agent with
// `bash: deny` still ran bash. These claims drive the SHIPPED BUNDLE with the
// scripted model, and read the outcome off the transcript the client renders.
//
// The cell can be evicted while a person decides, so one claim answers a
// permission on a NEW isolate built on the same storage, and the call resumes.
// EXPECTED_PASSES=19

import { watchClaims } from "../../tools/crash-reporter.mjs";
import { installWorkerGlobals, makeCell, newMessageId, rootIdOf } from "./cell-harness.mjs";

installWorkerGlobals();
let bad = 0, claims = 0;
const check = watchClaims((n, c, d = "") => { claims++; if (c) console.log(`  ok    ${n}`); else { console.log(`  FAIL  ${n}${d ? `\n          ${d}` : ""}`); bad++; } });
const { AgentCell } = await import("../dist/worker.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const JSON_HEADERS = { "content-type": "application/json" };
const post = (c, path, body) => c.fetch(path, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
async function until(pred, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await pred();
    if (v) return v;
    await sleep(20);
  }
  throw new Error(`timed out after ${ms} ms waiting for ${what}`);
}

const POLICY = { bash: { "rm *": "deny", "*": "allow" }, edit: "ask", read: "allow" };
const config = (permission, tools) => JSON.stringify({ agent: { kortix: { prompt: "P", permission, ...(tools ? { tools } : {}) } } });
const cellFor = (session, permission = POLICY, tools = undefined, opts = {}) =>
  makeCell(AgentCell, { KORTIX_SESSION_ID: session, KORTIX_TOKEN: "tok", CELL_MODEL: "faux", KORTIX_AGENT_NAME: "kortix", KORTIX_COMPILED_AGENT_CONFIG: config(permission, tools) }, opts);
const prompt = (c, session, text) => post(c, `/kortix/runtime/sessions/${rootIdOf(session)}/prompt`, { message_id: newMessageId(), parts: [{ type: "text", text }] });
const toolParts = async (c, session, tool) => (await (await c.fetch(`/session/${rootIdOf(session)}/message`)).json())
  .flatMap((m) => m.parts).filter((p) => p.type === "tool" && (!tool || p.tool === tool));

// ── deny ────────────────────────────────────────────────────────────────────
{
  const S = "deny";
  const c = cellFor(S);
  await c.fetch("/kortix/health");
  c.cell.engine().script([
    { tool: "bash", args: { command: "rm -rf important" } },
    { tool: "bash", args: { command: "echo allowed" } },
    { text: "done" },
  ]);
  await prompt(c, S, "go");
  await c.drain();
  const bash = await toolParts(c, S, "bash");
  check("a `deny` pattern blocks the call, with kortixd's reason",
    bash[0]?.state?.status === "error" && /The project policy denies this bash call/.test(bash[0]?.state?.error ?? ""), JSON.stringify(bash[0]?.state).slice(0, 200));
  check("and the most specific pattern decides: `echo` falls to `*: allow` and runs",
    bash[1]?.state?.status === "completed" && bash[1]?.state?.output.includes("allowed"), JSON.stringify(bash[1]?.state).slice(0, 200));
}
{
  const S = "switch";
  const c = cellFor(S, {}, { write: false });
  await c.fetch("/kortix/health");
  c.cell.engine().script([{ tool: "write", args: { path: "x.txt", content: "x" } }, { text: "done" }]);
  await prompt(c, S, "go");
  await c.drain();
  const write = (await toolParts(c, S, "write"))[0];
  check("a tool the agent switches off (`tools: { write: false }`) is blocked too",
    write?.state?.status === "error" && /denies this write call/.test(write?.state?.error ?? ""), JSON.stringify(write?.state).slice(0, 200));
}

// ── ask ─────────────────────────────────────────────────────────────────────
{
  const S = "ask";
  const c = cellFor(S);
  await c.fetch("/kortix/health");
  c.cell.engine().script([
    { tool: "write", args: { path: "a.txt", content: "first" } },
    { tool: "write", args: { path: "b.txt", content: "second" } },
    { tool: "write", args: { path: "c.txt", content: "third" } },
    { text: "done" },
  ]);
  await prompt(c, S, "go");
  const drained = c.drain(15_000);
  const first = await until(async () => (await (await c.fetch("/permission")).json())[0], 5_000, "the first permission request");
  check("an `ask` rule lists the request on GET /permission, in kortixd's shape",
    /^perm_/.test(first.id) && first.sessionID === rootIdOf(S) && first.permission === "edit" && first.patterns[0] === "a.txt" && first.metadata.content === "first",
    JSON.stringify(first));
  check("and the call waits: nothing is written before the reply",
    !(await c.cell.cell().fs.exists("/workspace/a.txt")), "");
  check("a reply that is not once, always or reject is 400", (await post(c, `/permission/${first.id}/reply`, { reply: "maybe" })).status === 400, "");
  check("a reply to an unknown request is 404", (await post(c, "/permission/perm_nope/reply", { reply: "once" })).status === 404, "");
  check("`once` answers 200", (await post(c, `/permission/${first.id}/reply`, { reply: "once" })).status === 200, "");
  const second = await until(async () => (await (await c.fetch("/permission")).json())[0], 5_000, "the second permission request");
  check("`once` covers one call: the next edit asks again", second.id !== first.id && second.patterns[0] === "b.txt", JSON.stringify(second));
  await post(c, `/permission/${second.id}/reply`, { reply: "reject" });
  await sleep(300);
  check("`reject` blocks that call with kortixd's reason",
    (await toolParts(c, S, "write"))[1]?.state?.error?.includes("The user rejected this tool call."), JSON.stringify((await toolParts(c, S, "write"))[1]?.state).slice(0, 200));
  const third = await until(async () => (await (await c.fetch("/permission")).json())[0], 5_000, "the third permission request");
  await post(c, `/permission/${third.id}/reply`, { reply: "always" });
  await drained;
  const writes = await toolParts(c, S, "write");
  check("the approved calls ran and wrote their files",
    writes[0]?.state?.status === "completed" && writes[2]?.state?.status === "completed"
      && (await c.cell.cell().fs.readFile("/workspace/a.txt", "utf8")) === "first" && (await c.cell.cell().fs.readFile("/workspace/c.txt", "utf8")) === "third",
    JSON.stringify(writes.map((w) => w.state.status)));
  c.cell.engine().script([{ tool: "edit", args: { path: "a.txt", edits: [{ oldText: "first", newText: "FIRST" }] } }, { text: "done" }]);
  await prompt(c, S, "again");
  await c.drain();
  const edit = (await toolParts(c, S, "edit"))[0];
  check("`always` covers the capability for the session: a later edit runs without asking",
    edit?.state?.status === "completed" && (await (await c.fetch("/permission")).json()).length === 0, JSON.stringify(edit?.state).slice(0, 200));
}

// ── a reply that reaches a new isolate ──────────────────────────────────────
{
  const S = "evict";
  const c = cellFor(S);
  await c.fetch("/kortix/health");
  c.cell.engine().script([{ tool: "write", args: { path: "kept.txt", content: "kept" } }, { text: "done" }]);
  await prompt(c, S, "go");
  c.drain(2_000).catch(() => {});
  const asked = await until(async () => (await (await c.fetch("/permission")).json())[0], 5_000, "the permission request");
  const next = c.rebuild();
  await next.fetch("/kortix/health");
  check("a pending request survives an eviction: the new isolate lists it",
    (await (await next.fetch("/permission")).json())[0]?.id === asked.id, "");
  next.cell.engine().script([{ tool: "write", args: { path: "kept.txt", content: "kept" } }, { text: "done" }]);
  const replied = await post(next, `/permission/${asked.id}/reply`, { reply: "once" });
  await next.drain(10_000);
  check("and a reply on the new isolate resumes the call: the file is written",
    replied.status === 200 && (await next.cell.cell().fs.readFile("/workspace/kept.txt", "utf8").catch(() => null)) === "kept",
    `${replied.status} ${JSON.stringify((await toolParts(next, S, "write")).map((p) => p.state.status))}`);
}

// ── the question tool ───────────────────────────────────────────────────────
{
  const S = "question";
  const c = cellFor(S, {});
  await c.fetch("/kortix/health");
  check("the question tool is listed", (await (await c.fetch("/tool/ids")).json()).includes("question"), "");
  const questions = [{ header: "Target", question: "Where should it go?", options: [{ label: "dev", description: "the dev stack" }, { label: "prod", description: "production" }] }];
  c.cell.engine().script([{ tool: "question", args: { questions } }, { tool: "question", args: { questions } }, { text: "done" }]);
  await prompt(c, S, "ask me");
  const drained = c.drain(15_000);
  const q = await until(async () => (await (await c.fetch("/question")).json())[0], 5_000, "the question");
  check("the question is listed on GET /question with its questions", /^que_/.test(q.id) && q.questions[0].header === "Target", JSON.stringify(q));
  await post(c, `/question/${q.id}/reply`, { answers: [["dev"]] });
  const q2 = await until(async () => (await (await c.fetch("/question")).json())[0], 5_000, "the second question");
  await post(c, `/question/${q2.id}/reject`, {});
  await drained;
  const parts = await toolParts(c, S, "question");
  check("an answer reaches the model as kortixd's text, and the part carries the answers",
    parts[0]?.state?.status === "completed" && parts[0].state.output === "User answered:\nTarget: dev" && JSON.stringify(parts[0].state.metadata?.answers) === '[["dev"]]',
    JSON.stringify(parts[0]?.state).slice(0, 240));
  check("a dismissed question is an error the model reads", parts[1]?.state?.status === "error" && parts[1].state.error.includes("The user dismissed the question."), JSON.stringify(parts[1]?.state).slice(0, 200));
}

// ── a stop releases what is pending ─────────────────────────────────────────
{
  const S = "abort";
  const c = cellFor(S);
  await c.fetch("/kortix/health");
  c.cell.engine().script([{ tool: "write", args: { path: "never.txt", content: "x" } }, { text: "done" }]);
  await prompt(c, S, "go");
  c.drain(3_000).catch(() => {});
  await until(async () => (await (await c.fetch("/permission")).json())[0], 5_000, "the permission request");
  await post(c, `/session/${rootIdOf(S)}/abort`, {});
  check("a Stop rejects every open request, so nothing waits on a person who already left",
    (await (await c.fetch("/permission")).json()).length === 0 && !(await c.cell.cell().fs.exists("/workspace/never.txt")), "");
}

console.log(bad ? `\n  ${bad} failure(s) of ${claims}` : `\n  the permission policy and questions hold: ${claims} claims`);
process.exit(bad ? 1 : 0);
