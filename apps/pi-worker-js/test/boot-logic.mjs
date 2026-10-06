// THE OPENCODE BOOT SURFACE, without a cell.
//
// A defect on the real pi-js UI, 2026-09-09, session 5192652f: a refresh never
// connected, because every route the client calls at boot answered 404. These
// claims pin each boot answer's shape (src/opencode-boot.js, pure).
//
// The transcript-id half of this suite (src/transcript-read.js) went with that
// module in e7ba174195: the transcript is now kept in the wire shape as it is
// streamed (src/kortix/transcript.js), so there is no read-time id derivation
// left to pin. kortix-contract-logic.mjs pins the ids it serves.
// EXPECTED_PASSES=23
import { bootAnswer, isBootRoute, configModel, agentNameFrom } from "../src/opencode-boot.js";

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
