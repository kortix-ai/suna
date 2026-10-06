// SUBAGENTS IN A CELL: kortixd's `task` tool on pi-durable conversations.
//
// kortixd's pi harness ships `task` (harness/pi/extensions/subagents.ts): a
// child session per call, linked from the running part's
// `metadata.sessionId`, an output that starts `task_id: <id>`, resumable by
// that id, `general` / `explore` / the compiled subagents, and no `task` or
// `question` inside a child. The cell had no `task` at all.
//
// Driven through the SHIPPED BUNDLE against the OpenAI-compatible gateway
// mock, so what each conversation sends the model (its system prompt and the
// tools it offers) is read off the real request.
// EXPECTED_PASSES=26

import { watchClaims } from "../../tools/crash-reporter.mjs";
import { installWorkerGlobals, makeCell, newMessageId, rootIdOf } from "./cell-harness.mjs";
import { startGatewayMock, systemPromptOf, toolNamesOf } from "./openai-compat.mjs";

installWorkerGlobals();
let bad = 0, claims = 0;
const check = watchClaims((n, c, d = "") => { claims++; if (c) console.log(`  ok    ${n}`); else { console.log(`  FAIL  ${n}${d ? `\n          ${d}` : ""}`); bad++; } });
const { AgentCell } = await import("../dist/worker.js");
const JSON_HEADERS = { "content-type": "application/json" };

// What the root and a child answer, per request. The child is recognised by
// its system prompt; each side ends with text once it has a tool result.
const plan = { root: null, child: null };
const isChild = (body) => /You are a subagent|REVIEWER PROMPT/.test(systemPromptOf(body));
const lastIsTool = (body) => (body.messages ?? []).at(-1)?.role === "tool";
const gw = await startGatewayMock({
  reply: (body) => {
    if (isChild(body)) return lastIsTool(body) ? { text: plan.child?.text ?? "CHILD REPORT" } : (plan.child?.tool ? plan.child : { text: plan.child?.text ?? "CHILD REPORT" });
    return lastIsTool(body) ? { text: "done" } : plan.root;
  },
});

const S = "subagents";
const ROOT = rootIdOf(S);
const AGENTS = JSON.stringify({ agent: {
  kortix: { prompt: "ROOT PROMPT", mode: "primary" },
  reviewer: { prompt: "REVIEWER PROMPT", mode: "subagent", description: "Reviews things", permission: { bash: "deny" } },
} });
const c = makeCell(AgentCell, { KORTIX_SESSION_ID: S, KORTIX_TOKEN: "tok", KORTIX_LLM_BASE_URL: gw.url, KORTIX_AGENT_NAME: "kortix", KORTIX_COMPILED_AGENT_CONFIG: AGENTS });
await c.fetch("/kortix/health");
async function turn(text) {
  const before = gw.seen.length;
  await c.fetch(`/kortix/runtime/sessions/${ROOT}/prompt`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ message_id: newMessageId(), parts: [{ type: "text", text }] }) });
  await c.drain(20_000);
  return gw.seen.slice(before);
}
const rootParts = async () => (await (await c.fetch(`/session/${ROOT}/message`)).json()).flatMap((m) => m.parts);
const taskParts = async () => (await rootParts()).filter((p) => p.type === "tool" && p.tool === "task");

check("the cell lists the task tool and advertises session.subagents",
  (await (await c.fetch("/tool/ids")).json()).includes("task") && (await (await c.fetch("/kortix/health")).json()).capabilities.includes("session.subagents"), "");

// ── one general subagent ────────────────────────────────────────────────────
plan.root = { tool: "task", args: { description: "probe the tree", prompt: "Write child.txt and report.", subagent_type: "general" } };
plan.child = { tool: "bash", args: { command: "echo child-ran > child.txt; echo ok" }, text: "CHILD REPORT" };
let sent = await turn("delegate it");
const rootReq = sent.find((r) => !isChild(r.body));
const childReq = sent.find((r) => isChild(r.body));
check("the root offers `task`, and its description lists general, explore and the compiled subagent",
  toolNamesOf(rootReq?.body).includes("task") && JSON.stringify(rootReq?.body.tools).includes("- reviewer: Reviews things") && JSON.stringify(rootReq?.body.tools).includes("- explore:"),
  JSON.stringify(toolNamesOf(rootReq?.body)));
check("the child is its own conversation: the subagent prompt, not the root's",
  systemPromptOf(childReq?.body).includes("You are a subagent") && !systemPromptOf(childReq?.body).includes("ROOT PROMPT") && systemPromptOf(childReq?.body).includes("Working directory: /workspace"),
  systemPromptOf(childReq?.body).slice(0, 200));
check("and it sees the delegated prompt as its user message, nothing of the root's conversation",
  childReq?.body.messages.filter((m) => m.role === "user").length === 1 && JSON.stringify(childReq?.body.messages).includes("Write child.txt and report.") && !JSON.stringify(childReq?.body.messages).includes("delegate it"),
  JSON.stringify(childReq?.body.messages).slice(0, 200));
check("a child is offered neither task nor question", !toolNamesOf(childReq?.body).includes("task") && !toolNamesOf(childReq?.body).includes("question") && toolNamesOf(childReq?.body).includes("bash"),
  JSON.stringify(toolNamesOf(childReq?.body)));
let [task] = await taskParts();
const childId = task?.state?.metadata?.sessionId;
check("the task part completes with kortixd's output: task_id first, then the report in <task_result>",
  task?.state?.status === "completed" && task.state.output.startsWith(`task_id: ${childId} (for resuming`) && task.state.output.includes("<task_result>\nCHILD REPORT\n</task_result>"),
  JSON.stringify(task?.state).slice(0, 300));
check("its metadata names the child session (the web links the child from it)", /^ses_pi[0-9a-f]{24}$/.test(childId ?? "") && childId !== ROOT, String(childId));
check("the child's work lands in the shared workspace", (await c.cell.cell().fs.readFile("/workspace/child.txt", "utf8").catch(() => null)) === "child-ran\n", "");
const sessions = await (await c.fetch("/session")).json();
check("GET /session lists the root and the child, the child with parentID = root",
  sessions.length === 2 && sessions[0].id === ROOT && sessions[1].id === childId && sessions[1].parentID === ROOT && sessions[1].title === "probe the tree (@general subagent)",
  JSON.stringify(sessions.map((x) => [x.id, x.parentID, x.title])));
check("GET /session/:root/children lists it too", (await (await c.fetch(`/session/${ROOT}/children`)).json())[0]?.id === childId, "");
const childMsgs = await (await c.fetch(`/session/${childId}/message`)).json();
check("the child's transcript holds its user prompt, its bash call and its report",
  childMsgs[0]?.info.role === "user" && childMsgs[0].parts[0].text === "Write child.txt and report."
    && childMsgs.flatMap((m) => m.parts).some((p) => p.type === "tool" && p.tool === "bash" && p.state.status === "completed")
    && childMsgs.flatMap((m) => m.parts).some((p) => p.type === "text" && p.text === "CHILD REPORT"),
  JSON.stringify(childMsgs.map((m) => [m.info.role, m.parts.map((p) => p.type)])));
check("and the root's transcript holds none of the child's messages",
  !(await (await c.fetch(`/session/${ROOT}/message`)).json()).some((m) => m.info.sessionID === childId), "");
check("a child session is read-only: a prompt to it is 501",
  (await c.fetch(`/session/${childId}/prompt_async`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ parts: [{ type: "text", text: "x" }] }) })).status === 501, "");

// ── resume the same child by task_id ───────────────────────────────────────
plan.root = { tool: "task", args: { description: "probe again", prompt: "Second round.", subagent_type: "general", task_id: childId } };
plan.child = { text: "SECOND REPORT" };
sent = await turn("continue it");
const resumed = sent.find((r) => isChild(r.body));
task = (await taskParts())[1];
check("task_id resumes the SAME child: same session, its earlier turn still in its context",
  task?.state?.metadata?.sessionId === childId && task.state.output.includes("SECOND REPORT")
    && JSON.stringify(resumed?.body.messages).includes("Write child.txt and report.") && JSON.stringify(resumed?.body.messages).includes("Second round."),
  JSON.stringify(task?.state).slice(0, 200));
check("and the child's transcript now holds both rounds",
  (await (await c.fetch(`/session/${childId}/message`)).json()).filter((m) => m.info.role === "user").length === 2, "");

// ── explore is read-only, a compiled subagent brings its own prompt and rules ──
plan.root = { tool: "task", args: { description: "look only", prompt: "Look around.", subagent_type: "explore" } };
plan.child = { text: "LOOKED" };
sent = await turn("explore it");
const explore = sent.find((r) => isChild(r.body));
check("an explore child is offered exactly bash, read, glob and grep",
  JSON.stringify([...toolNamesOf(explore?.body)].sort()) === JSON.stringify(["bash", "glob", "grep", "read"]), JSON.stringify(toolNamesOf(explore?.body)));
plan.root = { tool: "task", args: { description: "review", prompt: "Review it.", subagent_type: "reviewer" } };
plan.child = { tool: "bash", args: { command: "echo should-not-run" }, text: "REVIEWED" };
sent = await turn("review it");
const reviewerReq = sent.find((r) => isChild(r.body));
task = (await taskParts()).at(-1);
const reviewerId = task?.state?.metadata?.sessionId;
const reviewerBash = (await (await c.fetch(`/session/${reviewerId}/message`)).json()).flatMap((m) => m.parts).find((p) => p.type === "tool" && p.tool === "bash");
check("a compiled subagent runs on its own prompt", systemPromptOf(reviewerReq?.body).includes("REVIEWER PROMPT") && !systemPromptOf(reviewerReq?.body).includes("You are a subagent"), systemPromptOf(reviewerReq?.body).slice(0, 120));
check("and under its own permission: its `bash: deny` blocks the child's bash",
  reviewerBash?.state?.status === "error" && /denies this bash call/.test(reviewerBash.state.error ?? ""), JSON.stringify(reviewerBash?.state).slice(0, 200));

// ── errors the model reads ──────────────────────────────────────────────────
plan.root = { tool: "task", args: { description: "bad", prompt: "x", subagent_type: "nope" } };
await turn("bad type");
task = (await taskParts()).at(-1);
check("an unknown subagent_type is an error that lists the types",
  task?.state?.status === "error" && /Unknown subagent_type "nope". Available: general, explore, reviewer/.test(task.state.error ?? ""), JSON.stringify(task?.state).slice(0, 200));
plan.root = { tool: "task", args: { description: "bad", prompt: "x", subagent_type: "general", task_id: "ses_pi000000000000000000000000" } };
await turn("bad id");
task = (await taskParts()).at(-1);
check("a task_id that is not a child of this session is an error", task?.state?.status === "error" && /is not a subagent session of this session/.test(task.state.error ?? ""), JSON.stringify(task?.state).slice(0, 200));

// ── a Stop reaches the child ────────────────────────────────────────────────
{
  plan.root = { tool: "task", args: { description: "slow", prompt: "Sleep.", subagent_type: "general" } };
  plan.child = { tool: "bash", args: { command: "sleep 20; echo never" }, text: "NEVER" };
  await c.fetch(`/kortix/runtime/sessions/${ROOT}/prompt`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ message_id: newMessageId(), parts: [{ type: "text", text: "slow one" }] }) });
  const draining = c.drain(25_000);
  const started = Date.now();
  let running = null;
  while (!running && Date.now() - started < 8_000) {
    const status = await (await c.fetch("/session/status")).json();
    running = Object.keys(status).find((id) => id !== ROOT && status[id].type === "busy");
    if (!running) await new Promise((r) => setTimeout(r, 50));
  }
  check("a running child is busy on /session/status", !!running, "");
  const stop = await c.fetch(`/session/${ROOT}/abort`, { method: "POST" });
  await draining;
  task = (await taskParts()).at(-1);
  check("a Stop on the root ends the child's 20 s command in seconds, and the task says so",
    stop.status === 200 && Date.now() - started < 15_000 && task?.state?.status === "error", `${Date.now() - started} ms ${JSON.stringify(task?.state).slice(0, 160)}`);
  check("and the child is idle afterwards", !(Object.keys(await (await c.fetch("/session/status")).json()).includes(running)), "");
}

// ── an eviction mid-child ───────────────────────────────────────────────────
{
  plan.root = { tool: "task", args: { description: "survive", prompt: "Survive an eviction.", subagent_type: "general" } };
  plan.child = { tool: "bash", args: { command: "sleep 1; echo survived > survived.txt" }, text: "SURVIVED" };
  const before = (await (await c.fetch("/session")).json()).length;
  await c.fetch(`/kortix/runtime/sessions/${ROOT}/prompt`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ message_id: newMessageId(), parts: [{ type: "text", text: "evict me" }] }) });
  c.drain(1_500).catch(() => {});
  await new Promise((r) => setTimeout(r, 700));
  const next = c.rebuild();
  await next.fetch("/kortix/health");
  await next.drain(20_000);
  const parts = (await (await next.fetch(`/session/${ROOT}/message`)).json()).flatMap((m) => m.parts).filter((p) => p.type === "tool" && p.tool === "task");
  const last = parts.at(-1);
  const after = await (await next.fetch("/session")).json();
  check("a task interrupted by an eviction finishes on the new isolate with the child's report",
    last?.state?.status === "completed" && last.state.output.includes("SURVIVED"), JSON.stringify(last?.state).slice(0, 200));
  check("with ONE child, not a second one, and one user message in it",
    after.length === before + 1 && (await (await next.fetch(`/session/${last?.state?.metadata?.sessionId}/message`)).json()).filter((m) => m.info.role === "user").length === 1,
    `${before} -> ${after.length}`);
}

// ── an eviction ─────────────────────────────────────────────────────────────
{
  const next = c.rebuild();
  await next.fetch("/kortix/health");
  const listed = await (await next.fetch("/session")).json();
  check("children survive an eviction: a new isolate lists them and serves their transcripts",
    listed.length >= 4 && (await (await next.fetch(`/session/${childId}/message`)).json()).length >= 4, `${listed.length} sessions`);
}
await gw.close();

console.log(bad ? `\n  ${bad} failure(s) of ${claims}` : `\n  subagents run as pi-durable conversations: ${claims} claims`);
process.exit(bad ? 1 : 0);
