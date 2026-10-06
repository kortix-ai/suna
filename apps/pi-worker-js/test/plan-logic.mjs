// GLOB AND TODOS. The web client draws a tool call by NAME: `glob` gets the
// search view, `todowrite` gets the checklist the session panel shows as a
// plan, and it polls `GET /session/:id/todo`. A cell had none of them. The
// cell-level claims run real turns: a scripted one (the tools as pi calls them)
// and one against the gateway mock (the tools the model is offered).
// EXPECTED_PASSES=28
import { DatabaseSync } from "node:sqlite";
import { watchClaims } from "../../tools/crash-reporter.mjs";
import { makeCell, installWorkerGlobals, newMessageId, rootIdOf } from "./cell-harness.mjs";
import { startGatewayMock, toolNamesOf } from "./openai-compat.mjs";
installWorkerGlobals();
let bad = 0;
const check = watchClaims((n, c, d = "") => { if (c) console.log(`  ok    ${n}`); else { console.log(`  FAIL  ${n}${d ? `\n          ${d}` : ""}`); bad++; } });
const { globToRegExp, walkFiles, globTool, todoTools, normalizeTodos, readTodos, writeTodos } = await import("../src/plantools.js");
const { cellFs, cellExecutionEnv, CELL_CWD } = await import("../src/execenv.cell.js");
const { AgentCell } = await import("../dist/worker.js");

const db = new DatabaseSync(":memory:");
const sql = { exec(q, ...a) { const t = q.trim(); if (/^(CREATE|INSERT|UPDATE|DELETE)/i.test(t)) { const st = db.prepare(t); a.length ? st.run(...a) : st.run(); return { toArray: () => [], [Symbol.iterator]: function* () {} }; } const rows = db.prepare(t).all(...a); return { toArray: () => rows, [Symbol.iterator]: function* () { yield* rows; } }; } };

// ---- the pattern language
const m = (pattern, path) => globToRegExp(pattern).test(path);
check("a pattern with no slash matches by file name at any depth — what a model assumes of `*.ts`",
  m("*.ts", "src/lib/a.ts") && m("*.ts", "a.ts") && !m("*.ts", "a.tsx"), "");
check("`**` crosses directories and may match none of them", m("src/**/*.ts", "src/a/b/c.ts") && m("src/**/*.ts", "src/c.ts"), "");
check("`*` does not cross a directory", !m("src/*.ts", "src/a/b.ts") && m("src/*.ts", "src/b.ts"), "");
check("`?` is exactly one character, and never a slash", m("a?.ts", "ab.ts") && !m("a?.ts", "a/b.ts"), "");
check("`{a,b}` alternates", m("**/*.{ts,tsx}", "src/a.tsx") && m("**/*.{ts,tsx}", "src/a.ts") && !m("**/*.{ts,tsx}", "src/a.js"), "");
check("a dot is a dot, not any character", !m("*.ts", "atsts") && m("*.ts", "x.ts"), "");
check("an empty pattern is no pattern", globToRegExp("") === null && globToRegExp(null) === null, "");

// ---- the walk and the tool, over a real cell tree
const cell = cellFs(sql); await cell.ready;
const env = cellExecutionEnv(cell);
for (const p of ["src/app.ts", "src/lib/util.ts", "src/lib/util.test.ts", "README.md", "node_modules/dep/index.js", ".git/config"]) {
  await env.writeFile(p, "x");
}
const walked = (await walkFiles(env, "")).sort();
check("the walk finds every file and skips node_modules and .git",
  walked.join(",") === "README.md,src/app.ts,src/lib/util.test.ts,src/lib/util.ts", walked.join(","));
const glob = globTool();
const run = async (args) => (await glob.execute("id", args, undefined, undefined, { env })).content[0].text;
check("glob **/*.ts finds the sources, sorted, and not the markdown",
  (await run({ pattern: "**/*.ts" })) === "src/app.ts\nsrc/lib/util.test.ts\nsrc/lib/util.ts", await run({ pattern: "**/*.ts" }));
check("a bare *.ts matches by name at any depth", (await run({ pattern: "*.ts" })).split("\n").length === 3, await run({ pattern: "*.ts" }));
check("a path narrows the search and the results keep it", (await run({ pattern: "*.ts", path: "src/lib" })) === "src/lib/util.test.ts\nsrc/lib/util.ts", await run({ pattern: "*.ts", path: "src/lib" }));
check("nothing found says so, rather than answering an empty string", (await run({ pattern: "**/*.rs" })) === "No files found", "");
check("the tool is named `glob`, which is what makes the client draw it as a search", glob.name === "glob", glob.name);

// ---- todos
check("a todo list is normalized to content/status/priority, empties dropped, unknown status pending",
  JSON.stringify(normalizeTodos([{ content: "a", status: "in_progress" }, { content: "  " }, { content: "b", status: "nonsense", priority: "high" }]))
    === JSON.stringify([{ id: "1", content: "a", status: "in_progress" }, { id: "3", content: "b", status: "pending", priority: "high" }]), JSON.stringify(normalizeTodos([{ content: "a", status: "in_progress" }, { content: "  " }, { content: "b", status: "nonsense", priority: "high" }])));
check("an empty store reads as an empty list, not a throw", JSON.stringify(readTodos(sql)) === "[]", "");
const [todowrite, todoread] = todoTools(sql);
let out = await todowrite.execute("id", { todos: [{ content: "read the code", status: "completed" }, { content: "write the fix", status: "in_progress" }, { content: "run the suite" }] });
check("todowrite stores the list and answers a checklist the model can read back",
  out.todos.length === 3 && out.content[0].text.startsWith("[x] read the code\n[~] write the fix\n[ ] run the suite"), JSON.stringify(out.content[0].text));
check("and it is durable — the same list comes back from storage", JSON.stringify(readTodos(sql)) === JSON.stringify(out.todos), "");
out = await todowrite.execute("id", { todos: [{ content: "one thing", status: "pending" }] });
check("a second write REPLACES the list, which is what the client renders", readTodos(sql).length === 1 && readTodos(sql)[0].content === "one thing", JSON.stringify(readTodos(sql)));
check("todoread answers the stored list", (await todoread.execute("id", {})).todos[0].content === "one thing", "");
let notified = null;
await todoTools(sql, (list) => { notified = list; })[0].execute("id", { todos: [{ content: "watched" }] });
check("a write tells the listener, so the browser can be told the plan changed", notified?.[0]?.content === "watched", JSON.stringify(notified));

// ---- the route the client polls, and the tools the agent is given
{
  const root = rootIdOf("s");
  const h = makeCell(AgentCell, { KORTIX_SESSION_ID: "s", CELL_MODEL: "faux" });
  const c = h.cell;
  check("GET /session/:root/todo starts empty", JSON.stringify(await (await h.fetch(`/session/${root}/todo`)).json()) === "[]", "");
  writeTodos(c.sql, [{ content: "from the model", status: "in_progress" }]);
  const served = await (await h.fetch(`/session/${root}/todo`)).json();
  check("and then answers what the model wrote — the poll the client makes every few seconds",
    served.length === 1 && served[0].content === "from the model" && served[0].status === "in_progress", JSON.stringify(served));
  check("a todo poll for another session is refused", (await h.fetch(`/session/${rootIdOf("other")}/todo`)).status === 404, "");

  // AS PI CALLS THEM: a real turn, the scripted model asking for each tool by
  // name, pi-durable running it through the cell's adapter (engine.js
  // fromAgentTool). Measured live 2026-09-10 on the old engine: glob answered
  // "Cannot read properties of undefined (reading 'env')" while a unit claim
  // passed, because the unit handed it a context the harness never did. So the
  // claim is the turn, not the tool object.
  c.engine().script([
    { tool: "write", args: { path: "plan.txt", content: "x" } },
    { tool: "glob", args: { pattern: "**/*.txt" } },
    { tool: "todowrite", args: { todos: [{ content: "through the adapter", status: "in_progress" }] } },
    { text: "planned" },
  ]);
  const events = [];
  const watching = c.bus.subscribe((e) => events.push(e));
  const res = await h.fetch(`/kortix/runtime/sessions/${root}/prompt`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ message_id: newMessageId(), parts: [{ type: "text", text: "make a plan" }] }),
  });
  await h.drain();
  watching.unsubscribe();
  const parts = (await (await h.fetch(`/session/${root}/message`)).json()).flatMap((m) => m.parts);
  const tool = (name) => parts.find((p) => p.type === "tool" && p.tool === name);
  check("a turn is admitted (202)", res.status === 202, String(res.status));
  check("glob runs the way pi calls it — through the adapter, over the session's tree",
    tool("glob")?.state?.status === "completed" && String(tool("glob")?.state?.output ?? "").includes("plan.txt"), JSON.stringify(tool("glob")?.state).slice(0, 200));
  check("and so does todowrite: the list is stored, so the poll answers it",
    tool("todowrite")?.state?.status === "completed" && readTodos(c.sql)[0]?.content === "through the adapter"
      && (await (await h.fetch(`/session/${root}/todo`)).json())[0]?.content === "through the adapter", JSON.stringify(readTodos(c.sql)));
  const told = events.filter((e) => e.type === "todo.updated");
  check("and the write is published as todo.updated for this session, so the browser is told the plan changed",
    told.length === 1 && told[0].payload.sessionID === root && told[0].payload.todos[0]?.content === "through the adapter", JSON.stringify(told).slice(0, 200));
}
{
  // WHAT THE MODEL IS OFFERED, read off the request the gateway receives.
  const gw = await startGatewayMock({ reply: () => ({ text: "ok" }) });
  const h = makeCell(AgentCell, { KORTIX_SESSION_ID: "t", KORTIX_TOKEN: "tok", KORTIX_LLM_BASE_URL: gw.url });
  await h.fetch(`/kortix/runtime/sessions/${rootIdOf("t")}/prompt`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ message_id: newMessageId(), parts: [{ type: "text", text: "hi" }] }),
  });
  await h.drain();
  const names = toolNamesOf(gw.seen[0]?.body).sort();
  check("the model is offered glob, todowrite and todoread alongside pi's own read, write, edit and bash",
    ["glob", "todowrite", "todoread", "read", "write", "edit", "bash"].every((n) => names.includes(n)), names.join(","));
  await gw.close();
}

console.log(bad ? `\n${bad} FAILED` : "\nall claims hold");
process.exit(bad ? 1 : 0);
