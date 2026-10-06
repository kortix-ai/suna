// THE KORTIX CONTRACT, ON A CELL — in process, against the shipped bundle.
//
// To apps/api, the SDK and the web app a cell is a kortixd pi box: the same
// routes, the same root id, the same event framing, the same turn-stream
// callbacks (worker.js header). A rename on either side silently un-drives
// every session on a cell, so these claims make the mapping a contract rather
// than a coincidence.
//
// This carries forward the intent of three suites that pinned the OLD route
// table and were removed with it in the pi-durable rewrite (kortix-parity,
// kortix-routes-logic, cell-logic): every claim of theirs whose behaviour the
// new contract still has is restated here against the new routes. Turns are
// real pi-durable runs with pi-ai's faux model; the control plane is a local
// HTTP server that records every turn-stream callback.
//
// test/session-e2e.mjs drives the same contract through a real `celld dev`;
// this suite is the fast half that needs no binary.
// EXPECTED_PASSES=97
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { watchClaims } from "../../tools/crash-reporter.mjs";
import { installWorkerGlobals, makeCell, makeNamespace, makeStorage, newMessageId, rootIdOf } from "./cell-harness.mjs";

installWorkerGlobals();
let bad = 0;
const check = watchClaims((n, c, d = "") => { if (c) console.log(`  ok    ${n}`); else { console.log(`  FAIL  ${n}${d ? `\n          ${d}` : ""}`); bad++; } });
const worker = await import("../dist/worker.js");
const { AgentCell } = worker;
const router = worker.default;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const JSON_HEADERS = { "content-type": "application/json" };
const post = (h, path, body, headers = {}) => h.fetch(path, { method: "POST", headers: { ...JSON_HEADERS, ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const textPrompt = (text, extra = {}) => ({ parts: [{ type: "text", text }], ...extra });
async function until(pred, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await pred();
    if (v) return v;
    await sleep(20);
  }
  throw new Error(`timed out after ${ms} ms waiting for ${what}`);
}
/** An SSE response, parsed as it arrives: `{event, data}` per frame. */
function readSse(res) {
  const frames = [];
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const event = /^event: (.*)$/m.exec(chunk)?.[1] ?? null;
        const data = chunk.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("");
        if (data) frames.push({ event, data: JSON.parse(data) });
      }
    }
  })().catch(() => {});
  return { frames, stop: () => reader.cancel().catch(() => {}) };
}

// ── the control plane, played by a recorder ──────────────────────────────────
const relays = [];
let initialTurn = null;
const control = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch { /* not json */ }
    relays.push({ path: req.url, auth: req.headers.authorization ?? null, body });
    res.setHeader("content-type", "application/json");
    if (body.kind === "initial_turn_claim") return res.end(JSON.stringify({ ok: true, initial_turn: initialTurn }));
    if (body.kind === "end") return res.end(JSON.stringify({ ok: true, turn_completion: { outcome: "closed" } }));
    res.end(JSON.stringify({ ok: true }));
  });
});
await new Promise((r) => control.listen(0, "127.0.0.1", r));
const CONTROL = `http://127.0.0.1:${control.address().port}`;
const relaysFor = (session) => relays.filter((r) => r.body.session_id === session);

// ── the double is as strict as production ────────────────────────────────────
// A Durable Object's SQL cursor is consumed once. A double that hands rows
// back twice certifies code that reads a cursor twice — which gets nothing the
// second time in a real cell.
{
  const { sql } = makeStorage(new DatabaseSync(":memory:"));
  const a = sql.exec("SELECT 1 AS n");
  const first = a.toArray();
  let threw = false;
  try { a.toArray(); } catch { threw = true; }
  check("a cursor can be read once, and a SECOND read throws, as a real cell would return nothing", first[0]?.n === 1 && threw, "");
  const b = sql.exec("SELECT 1 AS n");
  [...b];
  threw = false;
  try { [...b]; } catch { threw = true; }
  check("iterating twice throws too, not only toArray twice", threw, "");
  const c = sql.exec("SELECT 1 AS n UNION ALL SELECT 2");
  const n1 = c.next().value?.n;
  const n2 = c.next().value?.n;
  threw = false;
  try { c.toArray(); } catch { threw = true; }
  check("`.next()` reads row by row and spends the cursor like the other two", n1 === 1 && n2 === 2 && c.next().done === true && threw, "");
}

// ── the router: which object a request reaches ───────────────────────────────
// ORDER MATTERS: the router remembers the roots it has served (a resumed box
// that lost its env still knows its one session), so the refusal comes first.
{
  const { ns, cell } = makeNamespace(AgentCell, { CELL_MODEL: "faux" });
  const route = (path, init) => router.fetch(new Request(`http://box${path}`, init), { AGENT: ns });
  const health = await route("/health");
  check("GET /health is the node's own liveness, answered with no session at all",
    health.status === 200 && (await health.json()).runtime === "pi-cell", String(health.status));
  const none = await route("/kortix/health");
  check("a box with no session, asked about none, refuses — 503 runtime_not_ready, marked FINAL so the proxy stops retrying",
    none.status === 503 && none.headers.get("x-kortix-final") === "1" && none.headers.get("x-kortix-boot-phase") === "cell|no-session"
      && (await none.json()).code === "runtime_not_ready", `${none.status} ${none.headers.get("x-kortix-final")}`);
  const viaQuery = await (await route("/session?c=sess-a")).json();
  check("`?c=<session>` reaches the object named by that session's root — ses_pi + sha256(\"pi-root\\0\" + session)[:24]",
    Array.isArray(viaQuery) && viaQuery[0]?.id === rootIdOf("sess-a") && cell(rootIdOf("sess-a")).cell.rootId === rootIdOf("sess-a"), JSON.stringify(viaQuery).slice(0, 120));
  const unaddressed = await route("/session");
  check("with exactly one root known, an unaddressed request resolves to it",
    unaddressed.status === 200 && (await unaddressed.json())[0]?.id === rootIdOf("sess-a"), String(unaddressed.status));
  const rootB = rootIdOf("sess-b");
  const viaPath = await route(`/session/${rootB}`);
  check("a root named in the PATH reaches that root's object, which adopts it from the router",
    viaPath.status === 200 && (await viaPath.json()).id === rootB && cell(rootB).cell.rootId === rootB, String(viaPath.status));
  const ambiguous = await route("/session");
  check("with two roots known, an unaddressed request is REFUSED rather than served the first",
    ambiguous.status === 503 && ambiguous.headers.get("x-kortix-final") === "1", String(ambiguous.status));
  const own = await router.fetch(new Request("http://box/session"), { AGENT: ns, KORTIX_SESSION_ID: "sess-c" });
  check("a box whose env names its session routes an unaddressed request there",
    own.status === 200 && (await own.json())[0]?.id === rootIdOf("sess-c"), String(own.status));
}

// ── boot: the root is pinned, the initial turn is claimed and run ────────────
const BOOT_SESSION = "boot-session";
const BOOT_ROOT = rootIdOf(BOOT_SESSION);
const BOOT_MESSAGE = newMessageId();
const BOOT_ENV = {
  KORTIX_SESSION_ID: BOOT_SESSION, KORTIX_PROJECT_ID: "proj-1", KORTIX_TOKEN: "tok-boot", KORTIX_API_URL: `${CONTROL}/v1`,
  KORTIX_BOOTSTRAP_RUNTIME_SESSION: "1", CELL_MODEL: "faux", SCRIPT: JSON.stringify([{ text: "booted and answered" }]),
};
{
  initialTurn = { prompt: "the prompt the CLI created the session with", message_id: BOOT_MESSAGE, turn_token: "turn-token-1" };
  // Alarm delivery held back, so the cell can be asked about itself before it has booted.
  const h = makeCell(AgentCell, BOOT_ENV, { alarmDelayMs: 300 });
  const early = await (await h.fetch("/kortix/health")).json();
  check("before boot the cell says it is starting — not ready, harness state starting — rather than taking prompts",
    early.runtimeReady === false && early.harness.state === "starting" && early.status === "starting", JSON.stringify({ r: early.runtimeReady, s: early.harness?.state }));
  const listEarly = await h.fetch("/session");
  check("and GET /session is 503 runtime_not_ready, naming the phase it waits on",
    listEarly.status === 503 && listEarly.headers.get("x-kortix-boot-phase") === "cell|initial-turn-claim" && (await listEarly.json()).code === "runtime_not_ready",
    `${listEarly.status} ${listEarly.headers.get("x-kortix-boot-phase")}`);
  const verbEarly = await post(h, `/kortix/runtime/sessions/${BOOT_ROOT}/prompt`, { message_id: newMessageId(), ...textPrompt("too soon") });
  check("a prompt before the initial turn is claimed is 503, so the API retries it rather than racing the claim",
    verbEarly.status === 503 && (await verbEarly.json()).code === "runtime_not_ready", String(verbEarly.status));
  const ready = await h.ready(5000);
  check("after boot the cell is ready: daemon ok, a runtime OBJECT, harness pi ready, a session.* capability",
    ready?.runtimeReady === true && ready.daemon === "ok" && typeof ready.runtime === "object" && ready.runtime !== null
      && ready.harness.id === "pi" && ready.harness.ready === true && ready.capabilities.some((c) => c.startsWith("session."))
      && ready.capabilities.includes("runtime.turns.v1"), JSON.stringify(ready).slice(0, 200));
  check("and it names its root in the session's own words, and the pre-W3 flat names too",
    ready.harness.session.id === BOOT_ROOT && ready.opencode_session_id === BOOT_ROOT && ready.workload === "session", "");
  const pin = relaysFor(BOOT_SESSION).find((r) => r.body.kind === "runtime_session");
  check("boot pins the root with the control plane: POST /v1/projects/:p/turn-stream, kind runtime_session, under the session's bearer",
    pin?.path === "/v1/projects/proj-1/turn-stream" && pin.body.runtime_session_id === BOOT_ROOT && pin.auth === "Bearer tok-boot", JSON.stringify(pin));
  check("then claims the initial turn", relaysFor(BOOT_SESSION).filter((r) => r.body.kind === "initial_turn_claim").length === 1, "");
  await h.drain(5000);
  const accepted = relaysFor(BOOT_SESSION).find((r) => r.body.kind === "turn_accepted");
  check("the claimed turn is admitted under the API's message id and accepted with its turn token",
    accepted?.body.turn_message_id === BOOT_MESSAGE && accepted.body.turn_token === "turn-token-1" && accepted.body.runtime_session_id === BOOT_ROOT, JSON.stringify(accepted?.body));
  const transcript = await (await h.fetch(`/session/${BOOT_ROOT}/message`)).json();
  check("and it RUNS: the prompt and the answer are in the transcript",
    transcript[0]?.info.id === BOOT_MESSAGE && transcript[0].parts[0]?.text === initialTurn.prompt
      && transcript.at(-1)?.parts.some((p) => p.type === "text" && p.text === "booted and answered"), JSON.stringify(transcript.map((m) => m.info.role)));
  const end = await until(() => relaysFor(BOOT_SESSION).find((r) => r.body.kind === "end"), 3000, "kind:end");
  check("the turn's end goes to the control plane — kind end, status idle, the message it answered — the ONLY signal that closes it",
    end.body.status === "idle" && end.body.turn_message_id === BOOT_MESSAGE && end.body.runtime_session_id === BOOT_ROOT && end.auth === "Bearer tok-boot", JSON.stringify(end.body));
  const again = h.rebuild();
  await again.fetch("/kortix/health");
  await sleep(400);
  check("boot happens once per session: a rebuilt isolate does not claim the initial turn again",
    relaysFor(BOOT_SESSION).filter((r) => r.body.kind === "initial_turn_claim").length === 1 && (await again.ready(2000))?.runtimeReady === true, "");
  initialTurn = null;
}

// ── the env push ─────────────────────────────────────────────────────────────
const ENV_SESSION = "env-session";
const ENV_ROOT = rootIdOf(ENV_SESSION);
const TOKEN = "tok-env";
const envCell = makeCell(AgentCell, { KORTIX_SESSION_ID: ENV_SESSION, KORTIX_TOKEN: TOKEN, CELL_MODEL: "faux" });
const pushEnv = (body, auth = `Bearer ${TOKEN}`) => post(envCell, "/kortix/env", body, auth ? { authorization: auth } : {});
{
  const tokenless = makeCell(AgentCell, { KORTIX_SESSION_ID: "no-token" });
  check("a cell with no KORTIX_TOKEN cannot verify a push, and says so (503) rather than taking it",
    (await post(tokenless, "/kortix/env", { env: { A: "1" } }, { authorization: "Bearer anything" })).status === 503, "");
  check("a push with the wrong bearer is 401", (await pushEnv({ env: { A: "1" } }, "Bearer wrong")).status === 401, "");
  check("a push carrying a USER context is 403 — env pushes take the session token only",
    (await post(envCell, "/kortix/env", { env: {} }, { authorization: `Bearer ${TOKEN}`, "x-kortix-user-context": "ctx.sig" })).status === 403, "");
  // kortixd refuses a body without a string `revision` or an `env` object
  // (routes/kortix/env.ts). The cell refuses the same bodies with the same 400s.
  check("a body that is not JSON is 400", (await pushEnv("nope")).status === 400, "");
  {
    const noRevision = await pushEnv({ env: { A: "1" } });
    const noEnv = await pushEnv({ revision: "r0" });
    const arrayEnv = await pushEnv({ revision: "r0", env: ["A"] });
    check("a push without a string `revision`, or without an `env` object, is 400 with kortixd's message — and nothing is stored",
      noRevision.status === 400 && (await noRevision.json()).error === "revision is required"
        && noEnv.status === 400 && (await noEnv.json()).error === "env object is required"
        && arrayEnv.status === 400 && envCell.cell.effectiveEnv().A === undefined, "");
  }
  const res = await pushEnv({ env: { PROJECT_SECRET: "s3cret", "not-an-identifier": "x" }, names: ["PROJECT_SECRET"], revision: "r1" });
  const body = await res.json();
  check("a push with the session token is applied and answered in kortixd's shape",
    res.status === 200 && body.ok === true && body.changed === true && body.revision === "r1" && body.agent_env_written === true && body.names.join() === "PROJECT_SECRET", JSON.stringify(body).slice(0, 200));
  const listed = await (await envCell.fetch("/env")).json();
  check("GET /env lists the session's keys — and a name that is not an identifier was never stored",
    listed.keys.includes("PROJECT_SECRET") && !listed.keys.includes("not-an-identifier"), JSON.stringify(listed.keys));
  const rt = await (await pushEnv({ env: { PROJECT_SECRET: "s3cret" }, names: ["PROJECT_SECRET"], revision: "r2", runtimeEnv: { KORTIX_DEFAULT_MODEL: "kortix/x", NOT_A_RUNTIME_KEY: "y" } })).json();
  check("runtime keys are KORTIX_* only: the rest of `runtimeEnv` is ignored",
    rt.runtime_env_names.join() === "KORTIX_DEFAULT_MODEL" && envCell.cell.effectiveEnv().NOT_A_RUNTIME_KEY === undefined, JSON.stringify(rt.runtime_env_names));
  await pushEnv({ env: {}, names: [], revision: "r3", llmGatewayEnabled: true, llmGatewayBaseUrl: "https://gw.example/v1/llm" });
  const gwOn = envCell.cell.effectiveEnv().KORTIX_LLM_BASE_URL;
  await pushEnv({ env: {}, names: [], revision: "r4", llmGatewayEnabled: false });
  check("llmGatewayEnabled sets the gateway's base URL, and false takes it away again",
    gwOn === "https://gw.example/v1/llm" && envCell.cell.effectiveEnv().KORTIX_LLM_BASE_URL === undefined, String(gwOn));
  check("a name the previous push managed and this one dropped is REMOVED, not left behind",
    !(await (await envCell.fetch("/env")).json()).keys.includes("PROJECT_SECRET"), "");
  await pushEnv({ env: { PROJECT_SECRET: "s3cret" }, names: ["PROJECT_SECRET"], revision: "r5" });
  const put = await envCell.fetch("/env/USER_KEY", { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ value: "mine" }) });
  check("PUT /env/:key stores a value the session set for itself, reported under `secrets`",
    put.status === 200 && (await (await envCell.fetch("/env")).json()).secrets.USER_KEY === "mine", String(put.status));
  check("but a reserved KORTIX_ or CELLD_ key cannot be written from a session",
    (await envCell.fetch("/env/KORTIX_TOKEN", { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ value: "x" }) })).status === 409
      && (await envCell.fetch("/env/CELLD_X", { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ value: "x" }) })).status === 409, "");
  envCell.cell.engine().script([{ tool: "bash", args: { command: "printenv PROJECT_SECRET; printenv USER_KEY; printenv KORTIX_TOKEN; echo end" } }, { text: "done" }]);
  await post(envCell, `/kortix/runtime/sessions/${ENV_ROOT}/prompt`, { message_id: newMessageId(), ...textPrompt("show the env") });
  await envCell.drain();
  const out = (await (await envCell.fetch(`/session/${ENV_ROOT}/message`)).json()).flatMap((m) => m.parts).find((p) => p.tool === "bash")?.state?.output ?? "";
  check("the project's secret and the session's own key reach the agent's shell; the control plane's KORTIX_TOKEN never does",
    out.includes("s3cret") && out.includes("mine") && !out.includes(TOKEN) && out.includes("end"), JSON.stringify(out));
  const del = await envCell.fetch("/env/USER_KEY", { method: "DELETE" });
  check("DELETE /env/:key removes it again", del.status === 200 && (await (await envCell.fetch("/env")).json()).secrets.USER_KEY === undefined, "");
  const evicted = envCell.rebuild();
  await evicted.fetch("/kortix/health");
  check("the pushed env survives an eviction — it is in the cell's SQLite, not its memory",
    evicted.cell.effectiveEnv().PROJECT_SECRET === "s3cret" && evicted.cell.projectSecrets().PROJECT_SECRET === "s3cret", JSON.stringify(Object.keys(evicted.cell.sessionEnv)));
}

// ── the session surface ──────────────────────────────────────────────────────
const S = "surface-session";
const ROOT = rootIdOf(S);
const OTHER = rootIdOf("someone-else");
const h = makeCell(AgentCell, { KORTIX_SESSION_ID: S, KORTIX_PROJECT_ID: "proj-2", KORTIX_TOKEN: "tok-s", KORTIX_API_URL: `${CONTROL}/v1`, CELL_MODEL: "faux" });
{
  const list = await (await h.fetch("/session")).json();
  check("GET /session is a LIST holding exactly the root — the control plane pins a root from it",
    Array.isArray(list) && list.length === 1 && list[0].id === ROOT && !list[0].parentID && list[0].directory === "/workspace" && typeof list[0].time?.created === "number", JSON.stringify(list).slice(0, 160));
  const one = await (await h.fetch(`/session/${ROOT}`)).json();
  check("GET /session/:root is ONE session object, not the list", !Array.isArray(one) && one.id === ROOT && one.projectID === "proj-2", JSON.stringify(one).slice(0, 120));
  const other = await h.fetch(`/session/${OTHER}`);
  check("another session is 404 `unknown session`, not served from here", other.status === 404 && (await other.json()).error === "unknown session", String(other.status));
  check("a malformed percent-encoding in the session segment is 400, not a crash", (await h.fetch("/session/%E0%A4%A")).status === 400, "");
  check("GET /session/status is OpenCode's keyed map — empty while idle", JSON.stringify(await (await h.fetch("/session/status")).json()) === "{}", "");
  check("POST /session/:root/prompt_async with no parts is 400, not an empty turn",
    (await post(h, `/session/${ROOT}/prompt_async`, { parts: [] })).status === 400, "");
  check("a message id that is not a Kortix wire id is 400",
    (await post(h, `/session/${ROOT}/prompt_async`, { messageID: "msg_not_a_wire_id", ...textPrompt("x") })).status === 400, "");
  check("a prompt addressed to ANOTHER root is refused, not run here",
    (await post(h, `/session/${OTHER}/prompt_async`, textPrompt("x"))).status === 404, "");
  const foreignVerb = await post(h, `/kortix/runtime/sessions/${OTHER}/prompt`, { message_id: newMessageId(), ...textPrompt("x") });
  check("and so is a runtime verb for another root — 404 with the turn-verb header the API reads",
    foreignVerb.status === 404 && foreignVerb.headers.get("x-kortix-turn-verb") === "1", String(foreignVerb.status));

  // ONE TURN, watched on the wire the browser opens.
  const stream = readSse(await h.fetch("/global/event"));
  const runtime = readSse(await h.fetch("/kortix/runtime/events"));
  h.cell.engine().script([
    { tool: "bash", args: { command: "sleep 1; echo slept > slept.txt; echo done" } },
    { text: "All done: slept.txt is written." },
  ]);
  const M1 = newMessageId();
  const accepted = await post(h, `/session/${ROOT}/prompt_async`, { messageID: M1, ...textPrompt("take a nap") });
  check("POST /session/:root/prompt_async is ACCEPTED with 204, as OpenCode answers it", accepted.status === 204, String(accepted.status));
  const echoUser = stream.frames.find((f) => f.data.type === "message.updated" && f.data.properties.info.id === M1);
  const echoPart = stream.frames.find((f) => f.data.type === "message.part.updated" && f.data.properties.part.messageID === M1);
  check("the user message is on the wire before the answer is accepted back: message.updated (role user, the client's id), then its text as part -p0",
    echoUser?.data.properties.info.role === "user" && echoPart?.data.properties.part.id === `${M1}-p0` && echoPart.data.properties.part.text === "take a nap"
      && stream.frames.indexOf(echoUser) < stream.frames.indexOf(echoPart), JSON.stringify(stream.frames.map((f) => f.data.type)).slice(0, 200));
  check("and it is in the transcript the moment the prompt is accepted — the client's id, once",
    (await (await h.fetch(`/session/${ROOT}/message`)).json()).filter((m) => m.info.id === M1).length === 1, "");
  check("the browser's stream opens with server.connected and every sequenced frame carries an epoch:seq id",
    stream.frames[0]?.data.type === "server.connected" && stream.frames.slice(1).every((f) => /^c[a-z0-9]+:\d+$/.test(f.data.id ?? "")), JSON.stringify(stream.frames[0]));
  await until(() => stream.frames.some((f) => f.data.type === "message.part.updated" && f.data.properties.part.tool === "bash" && f.data.properties.part.state?.status === "running"), 5000, "bash running");
  check("while the turn runs, GET /session/status names this root busy",
    JSON.stringify(await (await h.fetch("/session/status")).json()) === JSON.stringify({ [ROOT]: { type: "busy" } }), "");
  const probe = await (await h.fetch(`/kortix/health?turn=1&turn_message_id=${M1}`)).json();
  check("and health?turn=1 says the turn is in flight — what the reaper and the reload gate read",
    probe.turn_in_flight === true && probe.turn_end === null && probe.harness.turn.in_flight === true, JSON.stringify({ i: probe.turn_in_flight, e: probe.turn_end }));
  const dup = await post(h, `/session/${ROOT}/prompt_async`, { messageID: M1, ...textPrompt("take a nap") });
  check("a redelivery of the same message id is deduplicated (200), not a second turn",
    dup.status === 200 && (await dup.json()).deduplicated === true, String(dup.status));
  await h.drain(10_000);
  await until(() => stream.frames.some((f) => f.data.type === "session.idle"), 3000, "session.idle");
  const types = stream.frames.map((f) => f.data.type);
  check("the stream carries the turn: busy, the tool part running then completed, the answer, idle",
    stream.frames.some((f) => f.data.type === "session.status" && f.data.properties.status?.type === "busy")
      && stream.frames.some((f) => f.data.properties?.part?.tool === "bash" && f.data.properties.part.state?.status === "completed")
      && types.includes("session.idle"), JSON.stringify([...new Set(types)]));
  check("and the workspace change goes out as file.edited, so the Files panel re-reads",
    stream.frames.some((f) => f.data.type === "file.edited" && String(f.data.properties.file).endsWith("slept.txt")), "");
  const transcript = await (await h.fetch(`/session/${ROOT}/message`)).json();
  const ids = transcript.map((m) => m.info.id);
  check("after the turn the prompt is ONE user message, followed by the assistant's replies",
    transcript.filter((m) => m.info.role === "user").length === 1 && transcript[0].info.id === M1 && transcript.slice(1).every((m) => m.info.role === "assistant"), JSON.stringify(transcript.map((m) => m.info.role)));
  check("every assistant message answers that user message (parentID), complete with its tokens",
    transcript.slice(1).every((m) => m.info.parentID === M1 && m.info.time?.completed && m.info.tokens), "");
  check("message ids sort in transcript order — the client orders by id", JSON.stringify([...ids].sort()) === JSON.stringify(ids), JSON.stringify(ids));
  check("the final reply text is whole",
    transcript.at(-1).parts.filter((p) => p.type === "text").map((p) => p.text).join("") === "All done: slept.txt is written.", "");
  const done = await (await h.fetch(`/kortix/health?turn=1&turn_message_id=${M1}`)).json();
  check("health?turn=1 then names how the turn ended", done.turn_in_flight === false && done.turn_end === "completed" && done.turn_orphaned_prompt === false, JSON.stringify({ i: done.turn_in_flight, e: done.turn_end }));
  const orphan = await (await h.fetch(`/kortix/health?turn=1&turn_message_id=${newMessageId()}`)).json();
  check("a prompt the cell never admitted reads as abandoned and orphaned, so the API stops waiting for it",
    orphan.turn_in_flight === false && orphan.turn_end === "abandoned" && orphan.turn_orphaned_prompt === true, JSON.stringify({ e: orphan.turn_end, o: orphan.turn_orphaned_prompt }));
  const plain = await (await h.fetch("/kortix/health")).json();
  check("a plain health call carries no turn probe — it is asked for", !("turn_in_flight" in plain) && plain.harness.turn === null, "");
  const end = await until(() => relaysFor(S).find((r) => r.body.kind === "end" && r.body.turn_message_id === M1), 3000, "kind:end");
  check("the end of the turn is relayed under the session's bearer, with the session the prompt was for",
    end.body.status === "idle" && end.body.session_id === S && end.body.runtime_session_id === ROOT && end.auth === "Bearer tok-s"
      && end.path === "/v1/projects/proj-2/turn-stream", JSON.stringify(end));
  check("and relayed exactly once", relaysFor(S).filter((r) => r.body.kind === "end" && r.body.turn_message_id === M1).length === 1, "");
  check("the runtime stream opens with kortix.hello carrying the exact cursor, then sequenced events",
    runtime.frames[0]?.event === "kortix.hello" && typeof runtime.frames[0].data.head_seq === "number"
      && runtime.frames.slice(1).every((f) => f.event === "kortix.heartbeat" || Number.isInteger(f.data.seq)), JSON.stringify(runtime.frames[0]));
  stream.stop();
  runtime.stop();

  // ── reads ──
  const env = await h.fetch(`/kortix/runtime/messages/${ROOT}?limit=20`);
  const envelope = await env.json();
  check("/kortix/runtime/messages answers the daemon's envelope, and agrees with /session/:root/message",
    envelope.session_id === ROOT && envelope.source === "pi" && env.headers.get("x-kortix-transcript-source") === "pi"
      && envelope.count === transcript.length && envelope.messages.map((m) => m.info.id).join() === ids.join() && envelope.has_more === false, JSON.stringify({ ...envelope, messages: undefined }));
  const pageOne = await (await h.fetch(`/kortix/runtime/messages/${ROOT}?limit=1`)).json();
  check("a page with no cursor is the END of the transcript, and says there is more",
    pageOne.count === 1 && pageOne.messages[0].info.id === ids.at(-1) && pageOne.has_more === true, JSON.stringify({ c: pageOne.count, m: pageOne.has_more }));
  const after = await (await h.fetch(`/kortix/runtime/messages/${ROOT}?after=${M1}&limit=50`)).json();
  check("`after` answers what follows a message — the catch-up read after a resync", after.messages.map((m) => m.info.id).join() === ids.slice(1).join(), "");
  const foreign = await (await h.fetch(`/kortix/runtime/messages/${OTHER}`)).json();
  check("another session's transcript is not served from here — an empty envelope", foreign.count === 0 && foreign.messages.length === 0, "");
  const paged = await h.fetch(`/session/${ROOT}/message?limit=1`);
  check("/session/:root/message?limit=1 names the next cursor in x-next-cursor",
    (await paged.json()).length === 1 && paged.headers.get("x-next-cursor") === ids.at(-1), String(paged.headers.get("x-next-cursor")));
  const single = await (await h.fetch(`/session/${ROOT}/message/${M1}`)).json();
  check("GET /session/:root/message/:id is that ONE message with its parts", single.info?.id === M1 && single.parts[0]?.text === "take a nap", "");
  check("a message id this session does not have is 404, not an empty 200",
    (await h.fetch(`/session/${ROOT}/message/${newMessageId()}`)).status === 404 && (await h.fetch(`/kortix/runtime/messages/${ROOT}/${newMessageId()}`)).status === 404, "");
  check("deleting a message is refused (409) — the transcript is pi's, append-only",
    (await h.fetch(`/session/${ROOT}/message/${M1}`, { method: "DELETE" })).status === 409
      && (await h.fetch(`/kortix/runtime/messages/${ROOT}/${M1}`, { method: "DELETE" })).status === 409, "");
  const state = await h.fetch("/kortix/runtime/state");
  const doc = await state.json();
  check("/kortix/runtime/state is kortix.runtime.v1, naming the root, its agent and an idle status",
    doc.schema === "kortix.runtime.v1" && doc.identity.harness === "pi" && doc.identity.runtime_session_id === ROOT
      && doc.sessions.value[0].id === ROOT && doc.statuses.value[ROOT].type === "idle" && doc.agents.known === true, JSON.stringify(doc).slice(0, 200));
  const etag = state.headers.get("etag");
  check("and it carries an etag a client revalidates with — If-None-Match is 304",
    /^"sha256-[0-9a-f]{32}"$/.test(etag ?? "") && (await h.fetch("/kortix/runtime/state", { headers: { "if-none-match": etag } })).status === 304, String(etag));
  const resync = readSse(await h.fetch("/kortix/runtime/events?since=1&epoch=c-some-older-isolate"));
  await until(() => resync.frames.length >= 2, 2000, "resync");
  resync.stop();
  check("a cursor from another epoch — a rebuilt isolate — is answered with a resync naming what to re-read, never a replay",
    resync.frames[1]?.event === "kortix.resync" && resync.frames[1].data.reason === "epoch-changed" && resync.frames[1].data.recover.length === 2, JSON.stringify(resync.frames[1]));

  // ── attachments ──
  h.cell.engine().script([{ text: "got the file" }]);
  const big = "x".repeat(12_000);
  const url = `data:text/plain;base64,${btoa(big)}`;
  const M2 = newMessageId();
  await post(h, `/kortix/runtime/sessions/${ROOT}/prompt`, { message_id: M2, parts: [{ type: "text", text: "read this" }, { type: "file", mime: "text/plain", url, filename: "big.txt" }] });
  await h.drain();
  const withFile = await (await h.fetch(`/session/${ROOT}/message/${M2}`)).json();
  const filePart = withFile.parts.find((p) => p.type === "file");
  check("a large inline attachment is answered as a /kortix/part reference, so a transcript page stays small",
    filePart?.url === `/kortix/part/${encodeURIComponent(ROOT)}/${encodeURIComponent(M2)}/${encodeURIComponent(filePart.id)}` && filePart.filename === "big.txt", String(filePart?.url).slice(0, 80));
  const bytes = await h.fetch(filePart.url);
  check("and GET /kortix/part/... serves the attachment's bytes with its type",
    bytes.status === 200 && bytes.headers.get("content-type") === "text/plain" && (await bytes.text()) === big, String(bytes.status));
  check("a part that is not an attachment is 404", (await h.fetch(`/kortix/part/${ROOT}/${M2}/${M2}-p0`)).status === 404, "");

  // ── stop ──
  h.cell.engine().script([{ tool: "bash", args: { command: "sleep 20 && echo never" } }, { text: "should not be reached" }]);
  const M3 = newMessageId();
  const watch = readSse(await h.fetch("/global/event"));
  await post(h, `/kortix/runtime/sessions/${ROOT}/prompt`, { message_id: M3, ...textPrompt("run something slow") });
  await until(() => watch.frames.some((f) => f.data.properties?.part?.tool === "bash" && f.data.properties.part.state?.status === "running"), 5000, "slow bash running");
  const t0 = Date.now();
  const stop = await post(h, `/kortix/runtime/sessions/${ROOT}/abort`, {});
  const stopped = await h.drain(10_000);
  watch.stop();
  check("a Stop answers 200 and ends a 20 s command in seconds, not after it",
    stop.status === 200 && stopped && Date.now() - t0 < 8_000, `${stop.status} after ${Date.now() - t0} ms`);
  const stopEnd = await until(() => relaysFor(S).find((r) => r.body.kind === "end" && r.body.turn_message_id === M3), 5000, "stop relay");
  check("and the stopped turn is relayed as ended — idle, not an error the user has to dismiss",
    stopEnd.body.status === "idle", JSON.stringify(stopEnd.body));
  check("the never-reached step did not run", !(await (await h.fetch(`/session/${ROOT}/message`)).json()).some((m) => m.parts.some((p) => p.text === "should not be reached")), "");
  check("POST /session/:root/abort answers whether or not a turn is running, and another root's abort is refused",
    (await post(h, `/session/${ROOT}/abort`, {})).status === 200 && (await post(h, `/session/${OTHER}/abort`, {})).status === 404, "");
  const boxStop = await (await post(h, "/kortix/abort", {})).json();
  check("POST /kortix/abort is the box-wide stop the reaper sends, and names the session it stopped",
    boxStop.ok === true && boxStop.runtime_session_id === ROOT, JSON.stringify(boxStop));

  // ── what a cell does not do, said plainly ──
  check("revert, fork, share and the rest are 501 feature_not_supported — 'not possible' is not 'not here'",
    (await Promise.all(["revert", "unrevert", "fork", "share", "shell", "init"].map((v) => post(h, `/session/${ROOT}/${v}`, {})))).every((r) => r.status === 501), "");
  check("a slash command is 400: the pi cell has no slash commands", (await post(h, `/session/${ROOT}/command`, { command: "x" })).status === 400, "");
  check("a port, web or deck proxy is 501 with the reason — a cell has no processes and no ports",
    (await Promise.all(["/proxy/3000/", "/web-proxy/x", "/presentation/x"].map((p) => h.fetch(p)))).every((r) => r.status === 501), "");
  check("a permission or question reply is 404 — nothing is ever asked in a cell",
    (await post(h, "/permission/p1/reply", {})).status === 404 && (await post(h, "/question/q1/reply", {})).status === 404, "");
  check("POST /log and /global/dispose are accepted the way OpenCode answers them (true)",
    (await (await post(h, "/log", {})).json()) === true && (await (await post(h, "/global/dispose", {})).json()) === true, "");
  const unknown = await h.fetch("/definitely/not/a/route");
  check("a route the cell does not serve is a 404 naming the path, not a 200 that looks served",
    unknown.status === 404 && (await unknown.json()).error.includes("/definitely/not/a/route"), String(unknown.status));
  check("every answer carries the cell's own service time (x-cell-ms)",
    ["/kortix/health", "/session", "/nope", "/ping"].length === (await Promise.all(["/kortix/health", "/session", "/nope", "/ping"].map((p) => h.fetch(p))))
      .filter((r) => Number.isFinite(Number(r.headers.get("x-cell-ms")))).length, "");
}

// ── an eviction: the same storage, a new isolate ─────────────────────────────
{
  const before = await (await h.fetch(`/session/${ROOT}/message`)).json();
  const rebuilt = h.rebuild();
  const after = await (await rebuilt.fetch(`/session/${ROOT}/message`)).json();
  check("the transcript survives an eviction — it is in SQLite, not the isolate",
    after.length === before.length && after.map((m) => m.info.id).join() === before.map((m) => m.info.id).join(), `${before.length} -> ${after.length}`);
  const files = await (await rebuilt.fetch("/file?path=.")).json();
  check("and so does the workspace the agent wrote", Array.isArray(files) && files.some((f) => f.name === "slept.txt"), JSON.stringify(files).slice(0, 160));
  rebuilt.cell.engine().script([{ text: "still here" }]);
  const M4 = newMessageId();
  const res = await post(rebuilt, `/kortix/runtime/sessions/${ROOT}/prompt`, { message_id: M4, ...textPrompt("are you there?") });
  await rebuilt.drain();
  const list = await (await rebuilt.fetch(`/session/${ROOT}/message`)).json();
  const ids = list.map((m) => m.info.id);
  check("a prompt after the eviction runs, and its answer lands",
    res.status === 202 && list.at(-1).parts.some((p) => p.text === "still here"), String(res.status));
  check("and every id the new isolate minted sorts after every id the old one did — by id, as the client orders",
    JSON.stringify([...ids].sort()) === JSON.stringify(ids) && list.at(-1).info.id > before.at(-1).info.id, "");
}
{
  // NO MACHINE ON OFFER BY DEFAULT. The machine comes from the API's
  // environment/ensure route, which main removed (e60ed971f1, #9189). A tool
  // that fails on every call must not be listed; CELL_MACHINE=1 opts back in.
  const plain = makeCell(AgentCell, { KORTIX_SESSION_ID: "no-machine", CELL_MODEL: "faux" });
  const opted = makeCell(AgentCell, { KORTIX_SESSION_ID: "machine-on", CELL_MODEL: "faux", CELL_MACHINE: "1" });
  await plain.fetch("/kortix/health");
  await opted.fetch("/kortix/health");
  const ids = await (await plain.fetch("/tool/ids")).json();
  const optedIds = await (await opted.fetch("/tool/ids")).json();
  check("/tool/ids lists no `machine` by default, and lists it with CELL_MACHINE=1",
    Array.isArray(ids) && ids.includes("bash") && !ids.includes("machine") && optedIds.includes("machine"), `${JSON.stringify(ids)} / ${JSON.stringify(optedIds)}`);
}
{
  // A DEAD ISOLATE'S HALF-WRITTEN MESSAGE. An eviction mid-stream leaves an
  // assistant message with no completion; the next isolate must close it, or
  // the client spins on it forever.
  const x = makeCell(AgentCell, { KORTIX_SESSION_ID: "half", CELL_MODEL: "faux" });
  await x.fetch("/kortix/health");
  const root = rootIdOf("half");
  const id = newMessageId();
  x.cell.publish([{ type: "message.updated", properties: { sessionID: root, info: { id, role: "assistant", sessionID: root, time: { created: Date.now() } } } }]);
  const next = x.rebuild();
  const closed = await (await next.fetch(`/session/${root}/message/${id}`)).json();
  check("an assistant message a dead isolate left open is closed as aborted by the next one",
    closed.info.error?.name === "MessageAbortedError" && typeof closed.info.time?.completed === "number", JSON.stringify(closed.info).slice(0, 200));
}
{
  // NO CONTROL PLANE, NO CALLS. A bench or a local cell has no ledger to tell;
  // its turns are settled locally rather than retried forever.
  const before = relays.length;
  const quiet = makeCell(AgentCell, { KORTIX_SESSION_ID: "quiet", CELL_MODEL: "faux" });
  quiet.cell.engine().script([{ text: "ok" }]);
  await post(quiet, `/kortix/runtime/sessions/${rootIdOf("quiet")}/prompt`, { message_id: newMessageId(), ...textPrompt("hi") });
  await quiet.drain();
  await until(() => quiet.rows("SELECT relayed FROM kx_turns").every((r) => r.relayed === 1), 3000, "relayed");
  check("a cell with no control-plane identity tells nobody, and still settles its turn",
    relays.length === before && quiet.rows("SELECT status, relayed FROM kx_turns").every((r) => r.status === "done" && r.relayed === 1), JSON.stringify(quiet.rows("SELECT status, relayed FROM kx_turns")));
}

await new Promise((r) => control.close(r));
console.log(bad ? `\n${bad} FAILED` : "\nall claims hold");
process.exit(bad ? 1 : 0);
