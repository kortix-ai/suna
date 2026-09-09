// THE ROUTES AN OPENCODE CLIENT CALLS BEFORE IT WILL TALK TO A SESSION.
//
// The web client is an OpenCode client. On a microVM the OpenCode daemon
// answers `/agent`, `/command`, `/global/config`, `/project/current`,
// `/permission`, `/question` and `/lsp/diagnostics` at boot; a cell has no
// daemon, so the worker must. Measured on dev 2026-09-09, session 5192652f,
// on a page refresh: every one of those answered `404 unknown route` (the
// cell, in 12-36 ms), the client retried `/agent` eight times over 17 s, and
// the page never connected. Before the catch-all became an honest 404 it
// answered 200 to anything — which is why the page ever booted, on garbage.
//
// Pure: given the request and what the cell knows, the answer. No storage, no
// model, so every shape is asserted rather than discovered from a browser.
// Shapes are `@opencode-ai/sdk` 1.18 (`types.gen.d.ts`: Agent, Command,
// Config, Project, Permission).

const BOOT_ROUTES = new Set([
  "/agent", "/command", "/global/config", "/config", "/project/current",
  "/permission", "/question", "/lsp/diagnostics",
]);

/** Is this a route the boot surface answers? Used before doing any work. */
export function isBootRoute(method, path) {
  if (!BOOT_ROUTES.has(path)) return false;
  return method === "GET" || (method === "PATCH" && (path === "/global/config" || path === "/config"));
}

/**
 * The agent's NAME from what the cell was handed, which is not always a string.
 * Measured on dev 2026-09-09: `KORTIX_AGENT` on a live cell is an OBJECT (the
 * agent's config), and `String()` of it named the agent "[object Object]" in
 * the client's agent picker. A string wins; an object contributes its `name`;
 * anything else is the product's default agent.
 */
export function agentNameFrom(env = {}) {
  for (const v of [env.KORTIX_AGENT_NAME, env.AGENT, env.KORTIX_AGENT]) {
    if (typeof v === "string" && v.trim()) return v.trim();
    if (v && typeof v === "object" && typeof v.name === "string" && v.name.trim()) return v.name.trim();
  }
  return "kortix";
}

/** `provider/model`, the form `config.model` takes and the client splits on. */
export function configModel(provider, modelId) {
  return provider && modelId ? `${provider}/${modelId}` : undefined;
}

/**
 * The answer, or null when the route is not part of the boot surface.
 *
 * `ctx`: sessionId, agentName, projectId, provider, modelId, cwd, createdAt.
 * A missing value degrades to the shape's minimum, never to a 500: a client
 * booting against a cell that has not been configured yet still gets a list,
 * an object, a project — and asks again when the runtime is ready.
 */
export function bootAnswer(method, path, ctx = {}) {
  if (!isBootRoute(method, path)) return null;
  const sessionId = String(ctx.sessionId ?? "");
  const agentName = typeof ctx.agentName === "string" && ctx.agentName.trim() ? ctx.agentName.trim() : "kortix";
  const model = configModel(ctx.provider, ctx.modelId);
  switch (path) {
    case "/agent":
      return { status: 200, body: [agentShape(agentName, ctx.provider, ctx.modelId)] };
    case "/command":
      return { status: 200, body: [] };
    case "/global/config":
    case "/config":
      // PATCH is accepted and answered with the effective config: the cell
      // holds no mutable config of its own, so there is nothing to write and
      // nothing to refuse — the client merges what it gets back.
      return { status: 200, body: model ? { model } : {} };
    case "/project/current":
      return {
        status: 200,
        body: {
          id: String(ctx.projectId || sessionId || "cell"),
          worktree: String(ctx.cwd || "/work"),
          time: { created: Number(ctx.createdAt) || 0 },
        },
      };
    case "/permission":
    case "/question":
      return { status: 200, body: [] };
    case "/lsp/diagnostics":
      return { status: 200, body: {} };
    default:
      return null;
  }
}

function agentShape(name, provider, modelId) {
  return {
    name,
    description: "The session's agent, running in a cell.",
    mode: "primary",
    builtIn: false,
    // A cell's tools run in the workspace with no permission prompts: there is
    // no daemon to ask, and the product's cell path has never had one.
    permission: { edit: "allow", bash: { "*": "allow" } },
    ...(provider && modelId ? { model: { providerID: provider, modelID: modelId } } : {}),
    tools: { bash: true, read: true, write: true },
    options: {},
  };
}
