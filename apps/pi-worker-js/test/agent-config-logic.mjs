// THE PROJECT'S AGENT, INSIDE THE CELL. Kortix compiles `agents:` into an
// OpenCode config and hands it down as KORTIX_COMPILED_AGENT_CONFIG; before
// this the cell ignored it and every session ran the built-in prompt as
// "kortix". Pure over the config, plus the cell's own reading of it — read
// back from the request the model receives (the gateway mock).
// EXPECTED_PASSES=32
import { watchClaims } from "../../tools/crash-reporter.mjs";
import { makeCell, installWorkerGlobals, newMessageId, rootIdOf } from "./cell-harness.mjs";
import { startGatewayMock, systemPromptOf } from "./openai-compat.mjs";
installWorkerGlobals();
let bad = 0;
const check = watchClaims((n, c, d = "") => { if (c) console.log(`  ok    ${n}`); else { console.log(`  FAIL  ${n}${d ? `\n          ${d}` : ""}`); bad++; } });
const { parseAgentConfig, selectAgent, agentSystemPrompt, agentModelId, agentList, gatewayModelId } = await import("../src/agent-config.js");
const { agentShape } = await import("../src/opencode-boot.js");
const { AgentCell } = await import("../dist/worker.js");

const CONFIG = JSON.stringify({
  model: "kortix/anthropic/claude-sonnet-5",
  agent: {
    reviewer: { prompt: "You review code. Be exacting.", model: "kortix/anthropic/claude-opus-5", description: "Reviews a change", mode: "primary" },
    scribe: { prompt: "You write docs.", mode: "subagent" },
    retired: { prompt: "gone", disable: true },
  },
});

// ---- parsing
let c = parseAgentConfig(CONFIG);
check("the compiled config yields its agents, its default model and the names that are not disabled",
  c.names.join(",") === "reviewer,scribe" && c.model === "kortix/anthropic/claude-sonnet-5" && c.agents.reviewer.prompt.startsWith("You review"), JSON.stringify(c.names));
for (const [name, raw] of [["absent", undefined], ["blank", "   "], ["not json", "{oops"], ["an array", "[]"], ["no agent map", '{"model":"x"}']]) {
  const empty = parseAgentConfig(raw);
  check(`${name} parses to an empty config, never a throw`, empty.names.length === 0 && Object.keys(empty.agents).length === 0, JSON.stringify(empty));
}

// ---- selection
check("the agent the session was told to run is the one selected", selectAgent(c, "scribe").name === "scribe", "");
check("a name the config does not carry falls back to the first agent — a session must still answer",
  selectAgent(c, "nope").name === "reviewer", "");
check("a disabled agent is never selected by name or by fallback",
  selectAgent(c, "retired").name === "reviewer" && !parseAgentConfig(JSON.stringify({ agent: { retired: { disable: true } } })).names.length, "");
check("with no config at all the wanted name survives and there is no agent",
  (() => { const s = selectAgent(parseAgentConfig(""), "kortix"); return s.name === "kortix" && s.agent === null; })(), "");

// ---- prompt
check("the agent's `.md` body is the system prompt", agentSystemPrompt(c.agents.reviewer, "BUILT-IN") === "You review code. Be exacting.", "");
check("an agent with no body keeps the cell's own prompt", agentSystemPrompt({ mode: "primary" }, "BUILT-IN") === "BUILT-IN" && agentSystemPrompt(null, "BUILT-IN") === "BUILT-IN", "");

// ---- model
check("the agent's model wins over the config default, with the gateway prefix stripped",
  agentModelId(c.agents.reviewer, c) === "anthropic/claude-opus-5", agentModelId(c.agents.reviewer, c));
check("an agent with no model takes the config's default", agentModelId(c.agents.scribe, c) === "anthropic/claude-sonnet-5", "");
check("a native ref is passed through whole", agentModelId({ model: "openai/gpt-5" }, c) === "openai/gpt-5", "");
check("nothing anywhere is null, not an empty string", agentModelId(null, parseAgentConfig("")) === null, "");

// A REF THE GATEWAY TAKES. The control plane writes `kortix/<model>`; behind
// the gateway the remainder is the id. Sending the prefix through cost a turn:
// 2026-09-10 the first session to receive its own KORTIX_MODEL asked for
// `kortix/deepseek-v4-flash` and ended `the model produced nothing`.
check("a kortix/ ref loses its prefix; a bare id and a provider/model ref are untouched",
  gatewayModelId("kortix/deepseek-v4-flash") === "deepseek-v4-flash"
    && gatewayModelId("kortix/anthropic/claude-opus-5") === "anthropic/claude-opus-5"
    && gatewayModelId("deepseek-v4-flash") === "deepseek-v4-flash"
    && gatewayModelId("") === null && gatewayModelId(null) === null, "");

// ---- the /agent list
const list = agentList(c, "reviewer", agentShape);
check("the picker lists every agent the project declares, with its description, mode and model",
  list.length === 2 && list[0].name === "reviewer" && list[0].description === "Reviews a change" && list[0].mode === "primary"
    && list[0].model.providerID === "anthropic" && list[0].model.modelID === "claude-opus-5" && list[1].mode === "subagent", JSON.stringify(list).slice(0, 240));
check("a project with no agents gets no list — the cell's own single entry stands", agentList(parseAgentConfig(""), "kortix", agentShape) === null, "");

// ---- the cell reads it
//
// THROUGH THE CONTROL PLANE'S OWN PUSH, and checked where it matters: in the
// request the model receives. apps/api sends the compiled config as runtime
// keys (sandbox-session-push.ts `opencodeEnv`/`runtimeEnv`) under the
// session's bearer, and the gateway mock records the system prompt and the
// model id of every turn — so "the agent runs the project's prompt" is read
// off the wire, not off the cell's opinion of itself.
const TOKEN = "tok-agent-config";
const gw = await startGatewayMock({ reply: () => ({ text: "ok" }) });
// apps/api stamps every push with a `revision`; kortixd and the cell refuse one without it.
let revision = 0;
const push = (h, body) => h.fetch("/kortix/env", {
  method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ revision: `r${++revision}`, ...body }),
});
/** One turn through the runtime verb; the gateway request it produced. */
async function turn(h, session, text) {
  const before = gw.seen.length;
  const res = await h.fetch(`/kortix/runtime/sessions/${rootIdOf(session)}/prompt`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ message_id: newMessageId(), parts: [{ type: "text", text }] }),
  });
  await h.drain();
  return { status: res.status, sent: gw.seen.slice(before).at(-1)?.body ?? null };
}
{
  const h = makeCell(AgentCell, { KORTIX_SESSION_ID: "s", KORTIX_TOKEN: TOKEN, KORTIX_AGENT_NAME: "scribe", KORTIX_LLM_BASE_URL: gw.url });
  const cell = h.cell;
  const res = await push(h, { env: {}, runtimeEnv: { KORTIX_COMPILED_AGENT_CONFIG: CONFIG, KORTIX_COMPILED_AGENT_CONFIG_ETAG: "abc123" } });
  const pushed = await res.json();
  check("the compiled config arrives as runtime keys under the session's bearer, the way apps/api pushes it",
    res.status === 200 && pushed.runtime_env_names.join(",") === "KORTIX_COMPILED_AGENT_CONFIG,KORTIX_COMPILED_AGENT_CONFIG_ETAG", JSON.stringify(pushed).slice(0, 200));
  check("the cell runs the agent it was told to, with that agent's prompt",
    cell.agentConfig().name === "scribe" && cell.agentName() === "scribe" && (await cell.preparePrompt()).system === "You write docs.",
    `${cell.agentConfig().name} / ${(await cell.preparePrompt()).system.slice(0, 40)}`);
  const agents = await (await h.fetch("/agent")).json();
  check("and GET /agent answers the project's agents, not one invented entry",
    Array.isArray(agents) && agents.map((a) => a.name).join(",") === "reviewer,scribe", JSON.stringify(agents).slice(0, 200));
  const health = await (await h.fetch("/kortix/health")).json();
  check("/kortix/health reports the config's etag, so 'is this session on the latest config?' is answerable",
    health.agent_config_etag === "abc123", JSON.stringify(health).slice(0, 160));
  check("the agent's model reaches model resolution as a FALLBACK under KORTIX_AGENT_MODEL",
    cell.modelEnv().KORTIX_AGENT_MODEL === "anthropic/claude-sonnet-5", JSON.stringify(cell.modelEnv().KORTIX_AGENT_MODEL));
  let t = await turn(h, "s", "document the module");
  check("a turn asks the gateway for the agent's model, with the gateway prefix stripped",
    t.status === 202 && t.sent?.model === "anthropic/claude-sonnet-5", `${t.status} ${t.sent?.model}`);
  check("and the system prompt the model receives IS the agent's `.md` body",
    systemPromptOf(t.sent).startsWith("You write docs."), JSON.stringify(systemPromptOf(t.sent).slice(0, 60)));
  // A REF THE GATEWAY TAKES, end to end: the control plane's KORTIX_MODEL
  // wins over the agent's, and leaves the cell as the bare id.
  await push(h, { env: {}, runtimeEnv: { KORTIX_MODEL: "kortix/deepseek-v4-flash" } });
  t = await turn(h, "s", "again");
  check("the control plane's KORTIX_MODEL wins, and reaches the gateway as the id it knows, not the kortix/ ref",
    t.status === 202 && t.sent?.model === "deepseek-v4-flash", String(t.sent?.model));
  await push(h, { env: {}, runtimeEnv: { KORTIX_AGENT_NAME: "reviewer" } });
  check("switching the session's agent switches the prompt without a restart",
    cell.agentConfig().name === "reviewer" && (await cell.preparePrompt()).system.startsWith("You review"), cell.agentConfig().name);
  t = await turn(h, "s", "review this");
  check("and the very next turn the model receives carries the new agent's prompt",
    systemPromptOf(t.sent).startsWith("You review code"), JSON.stringify(systemPromptOf(t.sent).slice(0, 60)));
  check("the pre-W3 `opencodeEnv` name is still read, for an API deploy that sends it",
    (await (await push(h, { env: {}, opencodeEnv: { KORTIX_COMPILED_AGENT_CONFIG_ETAG: "def456" } })).json()).runtime_env_names.join(",") === "KORTIX_COMPILED_AGENT_CONFIG_ETAG"
      && (await (await h.fetch("/kortix/health")).json()).agent_config_etag === "def456", "");
}
{
  const bare = makeCell(AgentCell, { KORTIX_SESSION_ID: "s2", KORTIX_TOKEN: TOKEN, KORTIX_LLM_BASE_URL: gw.url });
  const bareList = await (await bare.fetch("/agent")).json();
  const t = await turn(bare, "s2", "hello");
  check("a cell with no compiled config keeps the built-in prompt and answers a one-agent list",
    (await bare.cell.preparePrompt()).system.startsWith("You are a coding agent") && bareList.length === 1 && bareList[0].name === "kortix",
    JSON.stringify(bareList).slice(0, 120));
  check("and the model receives that built-in prompt",
    systemPromptOf(t.sent).startsWith("You are a coding agent"), JSON.stringify(systemPromptOf(t.sent).slice(0, 60)));
}
await gw.close();

console.log(bad ? `\n${bad} FAILED` : "\nall claims hold");
process.exit(bad ? 1 : 0);
