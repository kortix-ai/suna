/** Validate the selected agent against the sandbox roster before forwarding a prompt. */

export interface RuntimeAgentRoster {
  /** Agent names the runtime reports, or `null` when it could not be read. */
  names: readonly string[] | null;
}

export interface AgentDeliveryResolution {
  /** The name to send, or `null` to send no `agent` field at all. */
  agent: string | null;
}

/** Refuse unknown agents and unreadable rosters; never substitute the default. */
export function resolveDeliverableAgent(
  requested: string | null | undefined,
  roster: RuntimeAgentRoster,
): AgentDeliveryResolution {
  const name = requested?.trim();
  if (!name) return { agent: null };
  if (roster.names === null) {
    throw new Error(`Cannot verify runtime agent "${name}": agent roster unavailable`);
  }
  if (roster.names.includes(name)) return { agent: name };
  throw new Error(`Runtime agent "${name}" is not registered`);
}

/** Names out of the runtime's `GET /agent` body, tolerant of shape drift. */
export function parseRuntimeAgentNames(body: unknown): string[] | null {
  const list = Array.isArray(body)
    ? body
    : Array.isArray((body as { agents?: unknown } | null)?.agents)
      ? ((body as { agents: unknown[] }).agents as unknown[])
      : null;
  if (!list) return null;
  const names: string[] = [];
  for (const entry of list) {
    const name = (entry as { name?: unknown } | null)?.name;
    if (typeof name === 'string' && name.trim()) names.push(name.trim());
  }
  return names;
}

/**
 * How long one reading of a runtime's roster is believed.
 *
 * The roster changes when the workspace's agent files change — a restart, a
 * config sync — not per prompt, so a short cache turns "one extra hop per
 * queued prompt" into "one extra hop per session per minute". Short enough
 * that an agent added mid-session is deliverable within the minute.
 */
export const RUNTIME_AGENT_ROSTER_TTL_MS = 60_000;

interface CacheEntry {
  names: string[] | null;
  atMs: number;
}

const rosterCache = new Map<string, CacheEntry>();

/**
 * Read (and cache) the agent names a session's runtime reports.
 *
 * `read` is injected so the delivery path can hand in its own authenticated
 * fetch and the tests need no sandbox. A THROWN read is cached as `null` for
 * the same TTL: a runtime that cannot answer must not be re-probed once per
 * prompt in a burst.
 */
export async function runtimeAgentRoster(
  cacheKey: string,
  read: () => Promise<string[] | null>,
  nowMs: number = Date.now(),
): Promise<RuntimeAgentRoster> {
  const cached = rosterCache.get(cacheKey);
  if (cached && nowMs - cached.atMs < RUNTIME_AGENT_ROSTER_TTL_MS) {
    return { names: cached.names };
  }
  let names: string[] | null = null;
  try {
    names = await read();
  } catch {
    names = null;
  }
  rosterCache.set(cacheKey, { names, atMs: nowMs });
  return { names };
}
