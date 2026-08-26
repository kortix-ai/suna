/**
 * THE AGENT A PROMPT IS DELIVERED UNDER, CHECKED AGAINST THE RUNTIME THAT HAS
 * TO RUN IT.
 *
 * A prompt carries the composer's agent pick verbatim
 * (`overrides.agent` → `postPrompt`'s `agent` field). The name is resolved by
 * the browser against the IAM roster (`resolveComposerAgent`), which answers a
 * different question from the one that matters at delivery: whether the
 * SANDBOX has an agent by that name. The two diverge in a shape that is
 * routine rather than exotic — a session row bound to `agent_name = 'kortix'`
 * on a project whose workspace never materialised that agent — and the
 * divergence used to DESTROY the message:
 *
 *   MEASURED, local stack 2026-08-26, session 65216cc6 (runtime roster:
 *   build, compaction, explore, general, plan, summary, title):
 *     POST .../prompts {overrides:{agent:"kortix"}}  → 202 queued
 *     … 400ms later                                   → delivering, attempts 1
 *     … 800ms later                                   → row GONE
 *     ledger turn d0fd8134                            → ended `abandoned` +3.3s
 *     transcript                                      → NO user message,
 *                                                       NO assistant message
 *   The same prompt with `agent:"build"` was answered normally.
 *
 * `POST /session/:id/prompt_async` answers **204 for an agent it cannot run**
 * (verified directly against the daemon), so the delivery loop reads the
 * forward as a success, retires the inbox row, opens a ledger turn — and the
 * user's text is gone with no queue row, no transcript bubble, no error, and
 * nothing to retry. Reported from the deployed surface as a queued prompt
 * whose turn read `Agent not found: "kortix". Available agents: build,
 * explore, general, plan`.
 *
 * The rule this file adds is deliberately narrow: an agent the runtime does
 * not have is DROPPED from the delivery, never substituted and never used to
 * refuse the prompt. Dropping it runs the prompt under the runtime's own
 * default — which is what an identical send with no pick has always done — and
 * that is strictly better than deleting the message. Refusing instead would
 * lock out every session whose bound agent is missing, which is the whole
 * population this repairs.
 */

export interface RuntimeAgentRoster {
  /** Agent names the runtime reports, or `null` when it could not be read. */
  names: readonly string[] | null;
}

export interface AgentDeliveryResolution {
  /** The name to send, or `null` to send no `agent` field at all. */
  agent: string | null;
  /** The requested name was dropped because the runtime does not have it. */
  dropped: boolean;
}

/**
 * Which agent name may go on the wire.
 *
 * Pure, so every branch below is asserted rather than observed in a sandbox.
 *
 * An UNREADABLE roster (`names === null`) keeps the request untouched: a read
 * that failed is not evidence, and dropping a legitimate pick because a health
 * probe timed out would silently reroute a correct send.
 */
export function resolveDeliverableAgent(
  requested: string | null | undefined,
  roster: RuntimeAgentRoster,
): AgentDeliveryResolution {
  const name = requested?.trim();
  if (!name) return { agent: null, dropped: false };
  if (roster.names === null) return { agent: name, dropped: false };
  if (roster.names.includes(name)) return { agent: name, dropped: false };
  return { agent: null, dropped: true };
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

/** Test seam + restart hygiene: forget every cached roster. */
export function clearRuntimeAgentRosterCache(): void {
  rosterCache.clear();
}

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
