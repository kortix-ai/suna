// PI RUNNING NATIVELY, as the control for the cell.
//
// The point of this file is that it is the SAME AGENT. Same @earendil-works/
// pi-agent-core `Agent`, same scripted model, same turn sequence, same commands.
// Three things differ, and they are exactly the things a cell buys or costs:
//
//   tools       spawn directly here; an HTTP call to the daemon in a cell
//   transcript  a plain array here; SQLite replicated to object storage in a cell
//   isolation   none here; a V8 isolate per session in a cell
//
// So the difference in the numbers is the price of durability and isolation,
// with the agent, the model and the work held constant. Anything else would be
// comparing two different programs and calling it a benchmark.
//
// Usage:  node test/local-pi.mjs '<script json>'   → prints one JSON line
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { scriptedStream } from "../src/scripted.js";

const WORK = "/tmp/local-pi-work";
const SCRIPTED_MODEL = { id: "scripted", api: "anthropic-messages", provider: "scripted", name: "scripted" };

function runShell(cwd, command, timeoutSec = 120) {
  return new Promise((done) => {
    const child = spawn("bash", ["-lc", command], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const t = setTimeout(() => child.kill("SIGKILL"), timeoutSec * 1000);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (code) => { clearTimeout(t); done({ out, err, code: code ?? -1 }); });
  });
}

// The same three tools, with the HTTP hop removed. Nothing else changes: same
// names, same parameter schemas, same result shape the model sees.
const localTools = (cwd) => [
  {
    name: "bash", label: "Bash (local)", description: "Run a shell command.",
    parameters: Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number()) }),
    execute: async (_id, { command, timeout }) => {
      const r = await runShell(cwd, command, timeout ?? 120);
      return { content: [{ type: "text", text: `${r.out}${r.err}\n[exit ${r.code}]` }], details: { exitCode: r.code } };
    },
  },
  {
    name: "read", label: "Read (local)", description: "Read a file.",
    parameters: Type.Object({ path: Type.String(), offset: Type.Optional(Type.Number()), limit: Type.Optional(Type.Number()) }),
    execute: async (_id, { path, offset = 0, limit }) => {
      const { readFile } = await import("node:fs/promises");
      try {
        const lines = (await readFile(join(cwd, path), "utf8")).split("\n");
        return { content: [{ type: "text", text: lines.slice(offset, offset + (limit ?? lines.length)).join("\n") }], details: {} };
      } catch (e) { return { content: [{ type: "text", text: `error: ${e.message}` }], details: { error: true } }; }
    },
  },
  {
    name: "write", label: "Write (local)", description: "Write a file.",
    parameters: Type.Object({ path: Type.String(), content: Type.String() }),
    execute: async (_id, { path, content }) => {
      const { writeFile } = await import("node:fs/promises");
      const { dirname } = await import("node:path");
      const full = join(cwd, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content, "utf8");
      return { content: [{ type: "text", text: `wrote ${path}` }], details: { ok: true } };
    },
  },
];

const script = JSON.parse(process.argv[2] ?? "[]");
const session = `s${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const cwd = join(WORK, session);
await mkdir(cwd, { recursive: true });

// Transcript lives in a plain array — the honest native baseline. A cell rebuilds
// this from SQLite on every request, which is the cost of surviving the process.
let messages = [];

const t0 = process.hrtime.bigint();
const agent = new Agent({
  streamFn: scriptedStream(script),
  sessionId: session,
  initialState: { systemPrompt: "bench", model: SCRIPTED_MODEL, tools: localTools(cwd), messages },
});
agent.subscribe((ev) => {
  if (ev.type === "turn_end") {
    if (ev.message) messages.push(ev.message);
    for (const r of ev.toolResults ?? []) messages.push(r);
  }
});
await agent.prompt("go");
const ms = Number(process.hrtime.bigint() - t0) / 1e6;

console.log(JSON.stringify({
  ms: Number(ms.toFixed(1)),
  messages: messages.length + 1,
  rssMb: Number((process.memoryUsage().rss / 1048576).toFixed(1)),
  heapMb: Number((process.memoryUsage().heapUsed / 1048576).toFixed(1)),
  cwd,
}));
