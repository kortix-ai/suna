// THE OPENCODE BOOT SURFACE AND THE TRANSCRIPT'S IDS, without a cell.
//
// Two defects on the real pi-js UI, 2026-09-09, session 5192652f: a refresh
// never connected (every boot route 404), and every message showed twice (the
// transcript read named messages by row number while the stream had named
// them by wire id, and painted pi's thinking as a visible part).
// EXPECTED_PASSES=23
import { bootAnswer, isBootRoute, configModel, agentNameFrom } from "../src/opencode-boot.js";
import { transcriptMessages, partType, messageIdFor } from "../src/transcript-read.js";

let bad = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `  — ${detail}`}`);
  if (!ok) bad++;
};

{
  const ctx = { sessionId: "s1", agentName: "kortix", projectId: "p1", provider: "openrouter", modelId: "deepseek-v4-flash", cwd: "/work", createdAt: 1700 };
  for (const p of ["/agent", "/command", "/global/config", "/config", "/project/current", "/permission", "/question", "/lsp/diagnostics"]) {
    const a = bootAnswer("GET", p, ctx);
    check(`GET ${p} is answered 200 — the client's boot must not 404`, a?.status === 200, JSON.stringify(a));
  }
  const agent = bootAnswer("GET", "/agent", ctx).body;
  check("the agent list names the session's agent, primary, with a model the client can read",
    Array.isArray(agent) && agent[0]?.name === "kortix" && agent[0].mode === "primary" &&
    agent[0].model?.providerID === "openrouter" && agent[0].model?.modelID === "deepseek-v4-flash" &&
    typeof agent[0].permission?.edit === "string" && typeof agent[0].tools === "object", JSON.stringify(agent).slice(0, 160));
  const cfg = bootAnswer("GET", "/global/config", ctx).body;
  check("config.model is `provider/model` — the client splits it on the first slash",
    cfg.model === "openrouter/deepseek-v4-flash" && cfg.model.split("/")[0] === "openrouter", JSON.stringify(cfg));
  const proj = bootAnswer("GET", "/project/current", ctx).body;
  check("the project names the workspace the cell's tools run in",
    proj.id === "p1" && proj.worktree === "/work" && proj.time?.created === 1700, JSON.stringify(proj));
  check("permission, question are empty LISTS and diagnostics an OBJECT — the shapes the client iterates",
    Array.isArray(bootAnswer("GET", "/permission", ctx).body) && Array.isArray(bootAnswer("GET", "/question", ctx).body) &&
    !Array.isArray(bootAnswer("GET", "/lsp/diagnostics", ctx).body) && Array.isArray(bootAnswer("GET", "/command", ctx).body), "");
  check("PATCH /global/config is accepted and answers the effective config",
    bootAnswer("PATCH", "/global/config", ctx)?.status === 200 && bootAnswer("PATCH", "/global/config", ctx).body.model === "openrouter/deepseek-v4-flash", "");
  check("an unconfigured cell still boots: no model means no `model` key, not a crash",
    bootAnswer("GET", "/global/config", { sessionId: "s1" }).body.model === undefined &&
    bootAnswer("GET", "/agent", { sessionId: "s1" }).body[0].model === undefined, "");
  check("a real route is never a boot route — nothing here can shadow /session or /global/event",
    !isBootRoute("GET", "/session") && !isBootRoute("GET", "/global/event") && !isBootRoute("POST", "/agent") && bootAnswer("GET", "/nope", ctx) === null, "");
  check("the agent name is a STRING from the env, never `[object Object]` — a live cell hands an object",
    agentNameFrom({ KORTIX_AGENT: { name: "researcher", model: "x" } }) === "researcher" &&
    agentNameFrom({ KORTIX_AGENT_NAME: "coder", KORTIX_AGENT: { name: "other" } }) === "coder" &&
    agentNameFrom({ KORTIX_AGENT: { model: "x" } }) === "kortix" && agentNameFrom({}) === "kortix" &&
    bootAnswer("GET", "/agent", { agentName: { name: "obj" } }).body[0].name === "kortix", "");
  check("configModel needs both halves", configModel("x", undefined) === undefined && configModel(undefined, "y") === undefined, "");
}

{
  const rows = [
    { i: 1, role: "user", json: JSON.stringify({ role: "user", content: [{ type: "text", text: "suppp" }] }), ts: 10, wire_id: "msg_0879abc" },
    { i: 2, role: "assistant", json: JSON.stringify({ role: "assistant", content: [{ type: "thinking", thinking: "the user greets" }, { type: "text", text: "sup!" }] }), ts: 20, wire_id: "msg_cell_00000001" },
    { i: 3, role: "assistant", json: JSON.stringify({ role: "assistant", content: [{ type: "text", text: "old row" }] }), ts: 30 },
  ];
  const out = transcriptMessages(rows, "s1");
  check("a user message is named by the id the client sent — the optimistic bubble reconciles",
    out[0].info.id === "msg_0879abc" && out[0].parts[0].messageID === "msg_0879abc", JSON.stringify(out[0]));
  check("an assistant message is named by the id the stream used, parts included",
    out[1].info.id === "msg_cell_00000001" && out[1].parts[0].id === "msg_cell_00000001-p0" && out[1].parts[1].id === "msg_cell_00000001-p1", JSON.stringify(out[1].parts.map((p) => p.id)));
  check("pi's thinking block is a `reasoning` part, which the SDK hides by default — not a second answer",
    out[1].parts[0].type === "reasoning" && out[1].parts[0].text === "the user greets" && out[1].parts[1].type === "text", JSON.stringify(out[1].parts));
  check("a row from before the column falls back to its row number — exactly what the read used to emit",
    out[2].info.id === "3" && out[2].parts[0].id === "3-p0", JSON.stringify(out[2]));
  check("partType: thinking and reasoning both hide; text is text; tools keep their name",
    partType("thinking") === "reasoning" && partType("reasoning") === "reasoning" && partType("text") === "text" && partType(undefined) === "text" && partType("toolCall") === "toolCall", "");
  check("messageIdFor ignores a blank wire id", messageIdFor({ i: 7, wire_id: "  " }) === "7" && messageIdFor({ i: 7, wire_id: "w" }) === "w", "");
}

console.log(bad ? `\n  ${bad} failed` : "");
process.exit(bad ? 1 : 0);
