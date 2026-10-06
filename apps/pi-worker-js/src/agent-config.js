// THE PROJECT'S AGENT, INSIDE THE CELL.
//
// Kortix compiles a project's `agents:` map into an OpenCode-shaped config —
// each agent's `.md` body as its `prompt`, its frontmatter as `model`, `mode`,
// `description`, `permission` — and hands it to a runtime as
// `KORTIX_COMPILED_AGENT_CONFIG` (apps/api projects/lib/compile-agent-config.ts).
// The microVM worker reads it (kortix-worker main.ts `bakedOverlay`); the cell
// did not, so every session ran the worker's built-in three-sentence prompt and
// answered as "kortix" whatever the project declared. Measured on dev
// 2026-09-10: a live cell session's env held five keys, none of them this one.
//
// Pure over the config string, so every shape is asserted without a cell.

/** `{ agents, model, names }` from the compiled JSON — never throws. */
export function parseAgentConfig(raw) {
  const empty = { agents: {}, model: null, names: [] };
  if (typeof raw !== "string" || !raw.trim()) return empty;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return empty; }
  if (!parsed || typeof parsed !== "object") return empty;
  const agents = parsed.agent && typeof parsed.agent === "object" && !Array.isArray(parsed.agent) ? parsed.agent : {};
  const names = Object.keys(agents).filter((n) => agents[n] && typeof agents[n] === "object" && !agents[n].disable);
  return { agents, model: typeof parsed.model === "string" && parsed.model.trim() ? parsed.model.trim() : null, names };
}

/**
 * WHICH agent this session is running: the one it was told, if the config has
 * it; else the config's only/first; else null.
 *
 * A name the config does not carry is NOT an error — a project can name an
 * agent whose `.md` failed to compile, and the session still has to answer.
 */
export function selectAgent(config, wanted) {
  const name = typeof wanted === "string" ? wanted.trim() : "";
  if (name && config.agents[name] && !config.agents[name].disable) return { name, agent: config.agents[name] };
  const first = config.names[0];
  if (first) return { name: first, agent: config.agents[first] };
  return { name: name || null, agent: null };
}

/**
 * The system prompt: the agent's `.md` body when it has one, else the cell's
 * own. An agent with an empty body is an agent with no prompt, not a project
 * asking for silence.
 */
export function agentSystemPrompt(agent, fallback) {
  const prompt = typeof agent?.prompt === "string" ? agent.prompt.trim() : "";
  return prompt || fallback;
}

/**
 * The model ref this agent asks for, in the form the gateway takes.
 *
 * Kortix writes `kortix/<provider>/<model>` for a gateway model and
 * `<provider>/<model>` for a native one; behind the gateway the whole
 * remainder is the model id (kortix-worker main.ts does the same). Returns
 * null when neither the agent nor the config names one — the session's own
 * `KORTIX_MODEL` and the platform default still apply, in that order.
 */
export function agentModelId(agent, config) {
  return gatewayModelId((typeof agent?.model === "string" && agent.model.trim()) || config?.model || "");
}

/**
 * A Kortix model ref as the GATEWAY names it.
 *
 * The control plane writes `kortix/<model>` (and `kortix/<provider>/<model>`)
 * for a model served by the Kortix gateway; behind the gateway the whole
 * remainder is the id — the same rule kortix-worker's `bakedOverlay` applies.
 * Sending the prefixed form through cost a whole turn: measured 2026-09-10,
 * the first session to receive its own `KORTIX_MODEL` asked the gateway for
 * `kortix/deepseek-v4-flash` and the turn ended `the model produced nothing`.
 */
export function gatewayModelId(ref) {
  const raw = typeof ref === "string" ? ref.trim() : "";
  if (!raw) return null;
  return (raw.startsWith("kortix/") ? raw.slice("kortix/".length) : raw).trim() || null;
}

/**
 * Every agent the project declares, in the client's `/agent` shape — so the
 * picker lists what the project has instead of one invented entry. `shape` is
 * opencode-boot.js's agentShape; the selected agent keeps its own model, the
 * rest report theirs.
 */
export function agentList(config, selectedName, shape) {
  if (!config.names.length) return null;
  return config.names.map((name) => {
    const agent = config.agents[name];
    const model = agentModelId(agent, config);
    const [provider, ...rest] = String(model ?? "").split("/");
    const base = shape(name, rest.length ? provider : undefined, rest.length ? rest.join("/") : undefined);
    return {
      ...base,
      ...(typeof agent?.description === "string" && agent.description.trim() ? { description: agent.description.trim() } : {}),
      ...(agent?.mode === "primary" || agent?.mode === "subagent" || agent?.mode === "all" ? { mode: agent.mode } : {}),
      ...(name === selectedName ? {} : {}),
    };
  });
}
