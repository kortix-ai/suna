// A KORTIX SESSION, END TO END, AGAINST A REAL CELL ON A REAL celld.
//
// Drives the built bundle (dist/worker.js) under `celld dev` through exactly
// the calls apps/api and the SDK make to a kortixd pi box, and plays the
// control plane on the other side (the turn-stream callbacks):
//
//   boot      health polls until ready; the cell pins its root and claims the
//             initial turn on the control plane's turn stream
//   open      GET /session lists the root (ses_pi + sha256 of the session)
//   env       POST /kortix/env with the session token
//   prompt    POST /kortix/runtime/sessions/:root/prompt -> 202, a redelivery
//             of the same message id -> 200 deduplicated
//   stream    /global/event carries the user echo, the assistant, tool parts
//             running -> completed, text deltas, busy -> idle
//   relay     the control plane receives `kind: end` for that message
//   read      /session/:root/message and /kortix/runtime/messages agree
//   files     the file the agent wrote is listed by /file
//   stop      a long command is aborted; the session goes idle
//   restart   celld is killed and restarted; the transcript and the workspace
//             are still there, and the next prompt runs
//
// Usage: node test/session-e2e.mjs [--celld <path>] [--keep]
// The model is pi-ai's faux provider, scripted per prompt: offline and free.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { cpSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { mintWireMessageId } from "../../../packages/sdk/src/core/session/wire-message-id.ts";

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "..");
const argv = process.argv.slice(2);
const celldBin = argv.includes("--celld") ? argv[argv.indexOf("--celld") + 1] : process.env.CELLD_BIN ?? "celld";
const keep = argv.includes("--keep");
const esbuildBin = join(app, "node_modules", ".bin", "esbuild");

let failures = 0;
const results = [];
function claim(name, ok, detail = "") {
  results.push({ name, ok });
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `  — ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the control plane ────────────────────────────────────────────────────
const relays = [];
const control = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let parsed = {};
    try { parsed = JSON.parse(body || "{}"); } catch { /* not json */ }
    relays.push({ path: req.url, auth: req.headers.authorization, body: parsed });
    res.setHeader("content-type", "application/json");
    if (parsed.kind === "initial_turn_claim") return res.end(JSON.stringify({ ok: true, initial_turn: null, runtime_session_id: null }));
    if (parsed.kind === "end") return res.end(JSON.stringify({ ok: true, turn_completion: { outcome: "closed" } }));
    res.end(JSON.stringify({ ok: true }));
  });
});
await new Promise((r) => control.listen(0, "127.0.0.1", r));
const controlUrl = `http://127.0.0.1:${control.address().port}`;

// ── the cell ─────────────────────────────────────────────────────────────
const session = randomUUID();
const project = randomUUID();
const token = `kortix_test_${randomUUID()}`;
const root = `ses_pi${createHash("sha256").update(`pi-root\0${session}`).digest("hex").slice(0, 24)}`;
const dir = mkdtempSync(join(tmpdir(), "pi-cell-e2e-"));
cpSync(join(app, "dist", "worker.js"), join(dir, "worker.js"));
writeFileSync(join(dir, "wrangler.json"), JSON.stringify({
  ...JSON.parse(await (await import("node:fs/promises")).readFile(join(app, "wrangler.json"), "utf8")),
  main: "worker.js",
}, null, 2));
writeFileSync(join(dir, ".dev.vars"), [
  `KORTIX_SESSION_ID=${session}`,
  `KORTIX_PROJECT_ID=${project}`,
  `KORTIX_TOKEN=${token}`,
  `KORTIX_API_URL=${controlUrl}/v1`,
  "KORTIX_BOOTSTRAP_RUNTIME_SESSION=1",
  "CELL_MODEL=faux",
  "CELL_TEST_ROUTES=1",
].join("\n"));

const port = 18000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
let celld = null;
async function startCelld() {
  celld = spawn(celldBin, ["dev", dir, "--port", String(port), "--no-watch"], {
    env: { ...process.env, CELLD_ESBUILD: esbuildBin },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  celld.stdout.on("data", (d) => (out += d));
  celld.stderr.on("data", (d) => (out += d));
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    if (celld.exitCode !== null) throw new Error(`celld exited ${celld.exitCode}:\n${out.slice(-2000)}`);
    try { if ((await fetch(`${base}/health`, { signal: AbortSignal.timeout(2_000) })).ok) return; } catch { /* not yet */ }
    await sleep(200);
  }
  throw new Error(`celld did not start:\n${out.slice(-2000)}`);
}
async function stopCelld() {
  if (!celld) return;
  const proc = celld;
  celld = null;
  if (proc.exitCode === null && proc.signalCode === null) {
    const exited = new Promise((r) => proc.once("exit", r));
    proc.kill("SIGKILL");
    await Promise.race([exited, sleep(5_000)]);
  }
}

const get = (path, init = {}) => fetch(`${base}${path}`, { signal: AbortSignal.timeout(20_000), ...init });
const post = (path, body, headers = {}) => get(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

/** Subscribe to /global/event and collect frames. */
function subscribe() {
  const frames = [];
  const ctl = new AbortController();
  const done = (async () => {
    const res = await get("/global/event", { signal: ctl.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = chunk.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("");
        if (data) frames.push(JSON.parse(data));
      }
    }
  })().catch(() => {});
  return { frames, stop: () => ctl.abort(), done };
}
async function waitFor(pred, ms, what) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const v = await pred();
    if (v) return v;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}
const mint = () => mintWireMessageId({ nowMs: Date.now(), backdateMs: 0 });

try {
  await startCelld();

  // ── boot ───────────────────────────────────────────────────────────────
  const health = await waitFor(async () => {
    const h = await (await get("/kortix/health")).json();
    return h.runtimeReady ? h : null;
  }, 20_000, "runtimeReady");
  claim("health: daemon ok, harness pi ready, runtime object present", health.daemon === "ok" && health.harness?.id === "pi" && health.harness.ready === true && typeof health.runtime === "object" && health.capabilities.includes("runtime.turns.v1"));
  claim("boot: the root was pinned on the control plane", relays.some((r) => r.body.kind === "runtime_session" && r.body.runtime_session_id === root && r.body.session_id === session && r.auth === `Bearer ${token}`));
  claim("boot: the initial turn was claimed", relays.some((r) => r.body.kind === "initial_turn_claim"));

  // ── open ───────────────────────────────────────────────────────────────
  const sessions = await (await get("/session?directory=/workspace")).json();
  claim("open: GET /session lists exactly the deterministic root", Array.isArray(sessions) && sessions.length === 1 && sessions[0].id === root && !sessions[0].parentID, JSON.stringify(sessions).slice(0, 160));

  // ── env ────────────────────────────────────────────────────────────────
  const refused = await post("/kortix/env", { env: {} }, { authorization: "Bearer wrong" });
  claim("env: a push with the wrong token is refused 401", refused.status === 401);
  const pushed = await (await post("/kortix/env", { env: { PROJECT_SECRET: "s3cret" }, names: ["PROJECT_SECRET"], revision: "r1", runtimeEnv: { KORTIX_MODEL: "kortix/faux-1" } }, { authorization: `Bearer ${token}` })).json();
  claim("env: the push is applied and counted", pushed.ok === true && pushed.exported === 1 && pushed.agent_env_written === true && pushed.revision === "r1", JSON.stringify(pushed).slice(0, 200));

  // ── prompt + stream ────────────────────────────────────────────────────
  await post("/cell/script", { steps: [
    { tool: "write", args: { path: "hello.txt", content: "hi from the cell\n" } },
    { tool: "bash", args: { command: "cat hello.txt && echo $((6*7)) && printenv PROJECT_SECRET" } },
    { text: "Done: hello.txt holds the greeting." },
  ] });
  const stream = subscribe();
  await sleep(300);
  const messageId = mint();
  const t0 = Date.now();
  const accepted = await post(`/kortix/runtime/sessions/${root}/prompt`, { message_id: messageId, parts: [{ type: "text", text: "write hello.txt and read it back" }], directory: "/workspace" });
  const acceptedBody = await accepted.json();
  claim("prompt: 202 with the caller's message id and the turn-verb header", accepted.status === 202 && acceptedBody.message_id === messageId && accepted.headers.get("x-kortix-turn-verb") === "1", `${accepted.status} ${JSON.stringify(acceptedBody)}`);
  const again = await post(`/kortix/runtime/sessions/${root}/prompt`, { message_id: messageId, parts: [{ type: "text", text: "write hello.txt and read it back" }] });
  claim("prompt: a redelivery of the same message id is deduplicated", again.status === 200 && (await again.json()).deduplicated === true);

  await waitFor(() => stream.frames.some((f) => f.type === "session.idle"), 30_000, "session.idle");
  const turnMs = Date.now() - t0;
  const types = stream.frames.map((f) => f.type);
  claim("stream: frames carry epoch:seq ids", stream.frames.filter((f) => f.type !== "server.connected" && f.type !== "server.heartbeat").every((f) => /^c[a-z0-9]+:\d+$/.test(f.id)));
  claim("stream: the user message is echoed", stream.frames.some((f) => f.type === "message.updated" && f.properties.info.id === messageId && f.properties.info.role === "user"));
  const assistants = stream.frames.filter((f) => f.type === "message.updated" && f.properties.info.role === "assistant");
  claim("stream: assistant messages answer the user message", assistants.length > 0 && assistants.every((f) => f.properties.info.parentID === messageId), `${assistants.length} assistant frames`);
  const tools = stream.frames.filter((f) => f.type === "message.part.updated" && f.properties.part.type === "tool");
  const completed = tools.filter((f) => f.properties.part.state.status === "completed").map((f) => f.properties.part.tool);
  claim("stream: write and bash tool parts complete", completed.includes("write") && completed.includes("bash"), JSON.stringify(completed));
  const bashOut = tools.find((f) => f.properties.part.tool === "bash" && f.properties.part.state.status === "completed")?.properties.part.state.output ?? "";
  claim("tools: bash ran in the cell's tree with the project secret", bashOut.includes("hi from the cell") && bashOut.includes("42") && bashOut.includes("s3cret"), JSON.stringify(bashOut));
  claim("stream: busy then idle", types.indexOf("session.status") >= 0 && stream.frames.some((f) => f.type === "session.status" && f.properties.status.type === "busy") && stream.frames.some((f) => f.type === "session.status" && f.properties.status.type === "idle"));
  console.log(`      turn: ${turnMs} ms, ${stream.frames.length} frames`);

  // ── relay ──────────────────────────────────────────────────────────────
  const end = await waitFor(() => relays.find((r) => r.body.kind === "end" && r.body.turn_message_id === messageId), 10_000, "turn end relay");
  claim("relay: the control plane got kind:end for the message, status idle", end.body.status === "idle" && end.body.runtime_session_id === root && end.auth === `Bearer ${token}`, JSON.stringify(end.body));

  // ── read ───────────────────────────────────────────────────────────────
  const list = await (await get(`/session/${root}/message`)).json();
  const user = list.find((m) => m.info.id === messageId);
  const replies = list.filter((m) => m.info.role === "assistant");
  const finalText = replies.at(-1)?.parts.filter((p) => p.type === "text").map((p) => p.text).join("");
  claim("read: the transcript holds the user message and the replies", !!user && user.parts[0]?.text === "write hello.txt and read it back" && replies.length >= 2, `${list.length} messages`);
  claim("read: the final reply text is whole", finalText === "Done: hello.txt holds the greeting.", JSON.stringify(finalText));
  claim("read: every assistant message is completed with its tokens", replies.every((m) => m.info.time?.completed && m.info.tokens));
  const runtimeBody = await (await get(`/kortix/runtime/messages/${root}?limit=20`)).json();
  claim("read: /kortix/runtime/messages agrees with /session/:id/message", runtimeBody.count === list.length && runtimeBody.messages.map((m) => m.info.id).join() === list.map((m) => m.info.id).join());
  const sorted = [...list.map((m) => m.info.id)].sort();
  claim("read: message ids sort in transcript order", sorted.join() === list.map((m) => m.info.id).join());
  const probe = await (await get(`/kortix/health?turn=1&turn_message_id=${messageId}`)).json();
  claim("health: the turn probe reports the turn completed", probe.turn_in_flight === false && probe.turn_end === "completed", JSON.stringify({ in: probe.turn_in_flight, end: probe.turn_end }));

  // ── files ──────────────────────────────────────────────────────────────
  const files = await (await get("/file?path=.")).json().catch(() => null);
  claim("files: the Files panel lists what the agent wrote", Array.isArray(files) && files.some((f) => f.name === "hello.txt"), JSON.stringify(files)?.slice(0, 200));

  // ── stop ───────────────────────────────────────────────────────────────
  await post("/cell/script", { steps: [{ tool: "bash", args: { command: "sleep 20 && echo never" } }, { text: "should not be reached" }] });
  const stopId = mint();
  const before = stream.frames.length;
  await post(`/kortix/runtime/sessions/${root}/prompt`, { message_id: stopId, parts: [{ type: "text", text: "run something slow" }] });
  await waitFor(() => stream.frames.slice(before).some((f) => f.type === "message.part.updated" && f.properties.part.tool === "bash" && f.properties.part.state.status === "running"), 15_000, "slow bash running");
  const tStop = Date.now();
  const stopped = await post(`/kortix/runtime/sessions/${root}/abort`, {});
  await waitFor(() => stream.frames.slice(before).some((f) => f.type === "session.idle"), 15_000, "idle after abort");
  claim("stop: abort answers 200 and the session goes idle", stopped.status === 200, `${Date.now() - tStop} ms`);
  const stopEnd = await waitFor(() => relays.find((r) => r.body.kind === "end" && r.body.turn_message_id === stopId), 10_000, "stop relay");
  claim("stop: the stopped turn is relayed as ended", !!stopEnd, JSON.stringify(stopEnd?.body));
  stream.stop();

  // ── restart ────────────────────────────────────────────────────────────
  await stopCelld();
  await startCelld();
  const after = await (await get(`/session/${root}/message`)).json();
  claim("restart: the transcript survives killing celld", after.length >= list.length && after.some((m) => m.info.id === messageId), `${after.length} messages`);
  const filesAfter = await (await get("/file?path=.")).json().catch(() => null);
  claim("restart: the workspace survives killing celld", Array.isArray(filesAfter) && filesAfter.some((f) => f.name === "hello.txt"));
  await post("/cell/script", { steps: [{ text: "still here" }] });
  const stream2 = subscribe();
  await sleep(300);
  const nextId = mint();
  const next = await post(`/kortix/runtime/sessions/${root}/prompt`, { message_id: nextId, parts: [{ type: "text", text: "are you there?" }] });
  await waitFor(() => stream2.frames.some((f) => f.type === "session.idle"), 20_000, "idle after restart");
  const afterList = await (await get(`/session/${root}/message`)).json();
  const lastText = afterList.filter((m) => m.info.role === "assistant").at(-1)?.parts.filter((p) => p.type === "text").map((p) => p.text).join("");
  claim("restart: a prompt after the restart runs", next.status === 202 && lastText === "still here", JSON.stringify(lastText));
  stream2.stop();
} catch (e) {
  claim("the run finished", false, String(e?.stack ?? e));
} finally {
  await stopCelld();
  control.close();
  if (!keep) rmSync(dir, { recursive: true, force: true });
  else console.log(`kept ${dir}`);
}
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} claims passed`);
process.exitCode = failures ? 1 : 0;
