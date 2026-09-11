// THE OPENCODE BOOT SURFACE AND THE TRANSCRIPT'S IDS, without a cell.
//
// Two defects on the real pi-js UI, 2026-09-09, session 5192652f: a refresh
// never connected (every boot route 404), and every message showed twice (the
// transcript read named messages by row number while the stream had named
// them by wire id, and painted pi's thinking as a visible part).
// EXPECTED_PASSES=35
import { bootAnswer, isBootRoute, configModel, agentNameFrom } from "../src/opencode-boot.js";
import { transcriptMessages, partType, messageIdFor, legacyIdAfter } from "../src/transcript-read.js";

let bad = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `  — ${detail}`}`);
  if (!ok) bad++;
};

{
  const ctx = { sessionId: "s1", agentName: "kortix", projectId: "p1", provider: "openrouter", modelId: "deepseek-v4-flash", cwd: "/workspace", createdAt: 1700 };
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
    proj.id === "p1" && proj.worktree === "/workspace" && proj.time?.created === 1700, JSON.stringify(proj));
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
    { i: 1, role: "user", json: JSON.stringify({ role: "user", content: [{ type: "text", text: "suppp" }] }), ts: 10, wire_id: "msg_088088c790015gYS8fAEf15ugc" },
    { i: 2, role: "assistant", json: JSON.stringify({ role: "assistant", content: [{ type: "thinking", thinking: "the user greets" }, { type: "text", text: "sup!" }] }), ts: 20, wire_id: "msg_cell_00000001" },
    { i: 3, role: "assistant", json: JSON.stringify({ role: "assistant", content: [{ type: "text", text: "old row" }] }), ts: 30 },
  ];
  const out = transcriptMessages(rows, "s1");
  check("a user message is named by the id the client sent — the optimistic bubble reconciles",
    out[0].info.id === "msg_088088c790015gYS8fAEf15ugc" && out[0].parts[0].messageID === "msg_088088c790015gYS8fAEf15ugc", JSON.stringify(out[0]));
  // A legacy counter id is placed right after the real id before it, so the
  // client's id ordering reads user, assistant, user, assistant — even when
  // the client's clock ran ahead of the cell's and packed its ids newest+1.
  const legacy = legacyIdAfter("msg_cell_00000001", out[0].info.id);
  check("a legacy msg_cell id borrows the 12-hex clock of the preceding real id and takes a tail past any random one",
    /^msg_[0-9a-f]{12}zzzzzzzzz[0-9A-Za-z]{5}$/.test(legacy ?? "") && legacy.slice(4, 16) === out[0].info.id.slice(4, 16)
      && out[1].info.id === legacy && out[1].parts.every((p) => p.messageID === legacy), `${legacy} ${out[1].info.id}`);
  check("and it sorts after that user id and before the very next clock value — the packed case measured on a46a8c1a",
    (() => { const u1 = out[0].info.id; const t = BigInt("0x" + u1.slice(4, 16)) + 1n;
             const u2 = "msg_" + t.toString(16).padStart(12, "0") + "00000000000000";
             return u1 < legacy && legacy < u2; })(), legacy);
  check("two legacy replies in one turn keep their order and both hang off the same message",
    (() => { const a1 = legacyIdAfter("msg_cell_00000007", out[0].info.id), a2 = legacyIdAfter("msg_cell_00000008", out[0].info.id);
             return a1 < a2 && a1.slice(0, 25) === a2.slice(0, 25); })(), "");
  check("with no real id before it a legacy id is left as stored", messageIdFor({ i: 3, wire_id: "msg_cell_00000001" }, null) === "msg_cell_00000001", "");
  check("a stored assistant message reads as COMPLETE (time.completed), a user message does not",
    out[1].info.time.completed === 20 && out[1].info.time.created === 20 && out[0].info.time.completed === undefined, JSON.stringify([out[0].info.time, out[1].info.time]));
  check("a real wire id is left exactly as it is", messageIdFor({ i: 9, ts: 5, wire_id: "msg_088088c790015gYS8fAEf15ugc" }) === "msg_088088c790015gYS8fAEf15ugc", "");
  check("pi's thinking block is NOT in the transcript — the stream hides it, so must the read (the chat paints a `reasoning` part as an answer)",
    out[1].parts.length === 1 && out[1].parts[0].type === "text" && out[1].parts[0].text === "sup!", JSON.stringify(out[1].parts));
  check("and the surviving part keeps the index the stream named it by — p1, not p0",
    out[1].parts[0].id === `${legacy}-p1`, out[1].parts[0].id);
  check("a row from before the column falls back to its row number — exactly what the read used to emit",
    out[2].info.id === "3" && out[2].parts[0].id === "3-p0", JSON.stringify(out[2]));
  check("partType: thinking and reasoning both hide; text is text; tools keep their name",
    partType("thinking") === "reasoning" && partType("reasoning") === "reasoning" && partType("text") === "text" && partType(undefined) === "text" && partType("toolCall") === "toolCall", "");
  check("messageIdFor ignores a blank wire id", messageIdFor({ i: 7, wire_id: "  " }) === "7" && messageIdFor({ i: 7, wire_id: "w" }) === "w", "");
}


// THREE ROUTES THE CLIENT CALLS THAT WERE NOT IN THE BOOT SET.
//
// Found 2026-09-11 by probing a live cell with every path the SDK, the web app
// and the control plane build on a sandbox base. `/project` is the LIST behind
// the project picker, `/path` is where OpenCode keeps its directories, and
// `/global/health` is the file client's own liveness probe — each answered
// `unknown route`, and each fails as something other than a missing route.
{
  const ctx = { sessionId: "s1", projectId: "p1", cwd: "/workspace", createdAt: 1700, checkedOut: true, version: "pi-cell" };
  const path = bootAnswer("GET", "/path", ctx);
  check("GET /path names every directory OpenCode asks after, and a cell has exactly one",
    path.status === 200 && path.body.worktree === "/workspace" && path.body.directory === "/workspace"
      && typeof path.body.home === "string" && typeof path.body.state === "string" && typeof path.body.config === "string",
    JSON.stringify(path?.body));
  const list = bootAnswer("GET", "/project", ctx);
  const current = bootAnswer("GET", "/project/current", ctx);
  check("GET /project is the LIST, and it holds exactly the project /project/current names",
    Array.isArray(list.body) && list.body.length === 1 && JSON.stringify(list.body[0]) === JSON.stringify(current.body),
    JSON.stringify(list?.body));
  check("a project reports `vcs: git` once there IS a checkout — that field is what makes the app offer its git surface",
    current.body.vcs === "git" && bootAnswer("GET", "/project/current", { ...ctx, checkedOut: false }).body.vcs === undefined,
    JSON.stringify(current.body));
  check("and it carries the `sandboxes` array the shape requires, empty because a cell is not a box",
    Array.isArray(current.body.sandboxes) && current.body.sandboxes.length === 0, JSON.stringify(current.body.sandboxes));
  const health = bootAnswer("GET", "/global/health", ctx);
  check("GET /global/health is the client's own probe, separate from /kortix/health which the control plane reads",
    health.status === 200 && health.body.healthy === true && typeof health.body.version === "string", JSON.stringify(health?.body));
  check("none of the three answers a write — they are reads, and a PATCH must not look accepted",
    bootAnswer("PATCH", "/path", ctx) === null && bootAnswer("POST", "/project", ctx) === null
      && bootAnswer("PATCH", "/global/health", ctx) === null, "");
}

console.log(bad ? `\n  ${bad} failed` : "");
process.exit(bad ? 1 : 0);
