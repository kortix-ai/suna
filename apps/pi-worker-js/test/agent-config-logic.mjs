// THE PROJECT'S AGENT, INSIDE THE CELL. Kortix compiles `agents:` into an
// OpenCode config and hands it down as KORTIX_COMPILED_AGENT_CONFIG; before
// this the cell ignored it and every session ran the built-in prompt as
// "kortix". Pure over the config, plus the cell's own reading of it.
// EXPECTED_PASSES=27
import { DatabaseSync } from "node:sqlite";
import { watchClaims } from "../../tools/crash-reporter.mjs";
import { makeCell, installWorkerGlobals } from "./cell-harness.mjs";
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
{
  const h = makeCell(AgentCell, { KORTIX_SESSION_ID: "s", KORTIX_AGENT_NAME: "scribe" });
  const cell = h.cell ?? h;
  await h.fetch("/kortix/env?c=s", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ env: { KORTIX_COMPILED_AGENT_CONFIG: CONFIG, KORTIX_COMPILED_AGENT_CONFIG_ETAG: "abc123", KORTIX_AGENT_NAME: "scribe" } }) });
  check("the cell runs the agent it was told to, with that agent's prompt",
    cell.agent().name === "scribe" && cell.systemPrompt() === "You write docs.", `${cell.agent().name} / ${cell.systemPrompt().slice(0, 40)}`);
  const agents = await (await h.fetch("/agent?c=s")).json();
  check("and GET /agent answers the project's agents, not one invented entry",
    Array.isArray(agents) && agents.map((a) => a.name).join(",") === "reviewer,scribe", JSON.stringify(agents).slice(0, 200));
  const health = await (await h.fetch("/kortix/health?c=s")).json();
  check("/kortix/health reports the config's etag, so 'is this session on the latest config?' is answerable",
    health.agent_config_etag === "abc123", JSON.stringify(health).slice(0, 160));
  check("the agent's model reaches model resolution as a FALLBACK — the control plane's KORTIX_MODEL still wins",
    cell.modelEnv().KORTIX_AGENT_MODEL === "anthropic/claude-sonnet-5", JSON.stringify(cell.modelEnv().KORTIX_AGENT_MODEL));
  {
    const g = makeCell(AgentCell, { KORTIX_SESSION_ID: "s3" });
    await g.fetch("/kortix/env?c=s3", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ env: { KORTIX_LLM_BASE_URL: "https://gw.example/v1/llm", KORTIX_TOKEN: "t", KORTIX_MODEL: "kortix/deepseek-v4-flash" } }) });
    const m = await (await g.fetch("/model?c=s3")).json();
    check("the session's own model reaches the gateway as the id it knows, not the kortix/ ref",
      m.active?.id === "deepseek-v4-flash", JSON.stringify(m.active));
  }
  await h.fetch("/kortix/env?c=s", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ env: { KORTIX_AGENT_NAME: "reviewer" } }) });
  check("switching the session's agent switches the prompt without a restart",
    cell.agent().name === "reviewer" && cell.systemPrompt().startsWith("You review"), cell.agent().name);
  // THE TURN'S agent, not just the cell's opinion of the prompt.
  check("the agent a turn is built with carries the project's prompt, however it is called",
    cell.buildAgent("s").state.systemPrompt.startsWith("You review code")
      && cell.buildAgent("s", undefined, undefined).state.systemPrompt.startsWith("You review code"),
    JSON.stringify(cell.buildAgent("s").state.systemPrompt.slice(0, 60)));
  const bare = makeCell(AgentCell, { KORTIX_SESSION_ID: "s2" });
  const bareCell = bare.cell ?? bare;
  // A request first: a cell makes its tables on the first one, and building an
  // agent reaches for them.
  const bareList = await (await bare.fetch("/agent?c=s2")).json();
  check("a cell with no compiled config keeps the built-in prompt and answers a one-agent list",
    bareCell.systemPrompt().startsWith("You are a coding agent") && bareCell.buildAgent("s2").state.systemPrompt.startsWith("You are a coding agent")
      && bareList.length === 1, bareCell.systemPrompt().slice(0, 40));
}

console.log(bad ? `\n${bad} FAILED` : "\nall claims hold");
process.exit(bad ? 1 : 0);
