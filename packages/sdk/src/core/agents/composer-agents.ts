import type { Agent } from '../runtime/runtime-types';

import type { ProjectConfigSummary } from '../rest/projects-client';
import { isSelectableAgent } from '../rest/projects-client/project-agents';

/**
 * The session composer's agent list — framework-free, so every host (web,
 * mobile) builds the picker and resolves the agent to send with the same rules.
 */

/**
 * Put the declared project default first so every consumer's ordinary
 * "first visible agent" fallback agrees with the project contract. Explicit
 * per-session/user picks still resolve by name and therefore keep precedence.
 */
export function projectConfigAgentsToRuntimeAgents(config: ProjectConfigSummary): Agent[] {
  const agents = config.agents.map(projectConfigAgentToOpenCodeAgent);
  const defaultName = config.default_agent ?? config.open_code_default_agent;
  if (!defaultName) return agents;
  return agents.sort((left, right) => {
    if (left.name === defaultName) return -1;
    if (right.name === defaultName) return 1;
    return 0;
  });
}

function projectConfigAgentToOpenCodeAgent(agent: ProjectConfigSummary['agents'][number]): Agent {
  return {
    name: agent.name,
    description: agent.description ?? undefined,
    mode: agent.mode ?? undefined,
    source: agent.source,
    hidden: agent.enabled === false,
  } as unknown as Agent;
}

/**
 * The agents a composer may offer: `isSelectableAgent` (#8007), the one rule
 * every agent picker applies — not hidden, not disabled, not a subagent, and
 * project-only agents (`project-manager`) only with `featureFlags.enableProjects`.
 *
 * Subagents are dispatched BY an agent, never picked as the one to prompt, so
 * "the roster is empty" means the same thing to `resolveComposerAgent` as to
 * the control that renders it. `includeSubagents: true` keeps them (the runtime
 * roster the composer cycles through).
 */
export function composerSelectableAgents(
  agents: Agent[] | undefined,
  options?: { includeSubagents?: boolean },
): Agent[] {
  if (!Array.isArray(agents)) return [];
  const includeSubagents = options?.includeSubagents === true;
  return agents.filter((a) => isSelectableAgent(includeSubagents ? { ...a, mode: null } : a));
}

export type ComposerAgentReason =
  /** The roster has not loaded yet — nothing is refused on a pending query. */
  | 'loading'
  /** The caller's own pick is accessible and stands. */
  | 'selected'
  /** No pick; the session's immutable creation agent stands. */
  | 'bound'
  /** No pick (or an inaccessible one); the project default is accessible. */
  | 'default'
  /** Neither the pick nor the default is accessible; first grant wins. */
  | 'first_accessible'
  /** Nothing is accessible. The composer must refuse the send. */
  | 'no_access';

export interface ComposerAgentResolution {
  /** The agent name to display AND to send. `null` only when nothing runs. */
  selected: string | null;
  /** No agent can run: disable the picker and the send control. */
  disabled: boolean;
  reason: ComposerAgentReason;
}

/**
 * Which agent the composer will actually run, given the roster the server is
 * willing to hand this user.
 *
 * Project agents are deny-by-default for a `member`: the roster only contains
 * agents an explicit `iam_resource_grant` names them (or one of their groups)
 * on. So the roster can be legitimately EMPTY (the send must be refused, or it
 * silently runs the manifest default or 403s), and the project's
 * `default_agent` may not be in it (the picker must show the agent that will
 * actually run). This is the single answer to "what is selected, and can we
 * send".
 */
export function resolveComposerAgent(input: {
  /** The accessible roster. `undefined` means the query is still in flight. */
  agents: Agent[] | undefined;
  /**
   * The session's immutable creation agent, when this composer belongs to an
   * existing project session. It is what the server RUNS for this session
   * regardless of roster membership, so with no explicit pick it is the truth
   * to display — never `selectable[0]`, which is somebody else's first grant.
   */
  boundAgent?: string | null;
  /** The project's declared default agent, accessible or not. */
  defaultAgent?: string | null;
  /** The caller's current pick (session slot, last-used, …), if any. */
  selectedAgent?: string | null;
}): ComposerAgentResolution {
  const bound = input.boundAgent?.trim() || null;
  // A pending roster is not an empty one. Refusing the send here would disable
  // the composer on every cold mount for a beat, which reads as broken. Show
  // the pick, else the session's bound agent — the one name known to be right
  // before any query lands.
  if (!Array.isArray(input.agents)) {
    const picked = input.selectedAgent?.trim();
    if (picked) return { selected: picked, disabled: false, reason: 'loading' };
    return { selected: bound, disabled: false, reason: 'loading' };
  }

  const selectable = composerSelectableAgents(input.agents);
  if (selectable.length === 0) {
    // A bound session still runs its own agent server-side; an empty roster
    // refuses only unbound composers.
    if (bound) return { selected: bound, disabled: false, reason: 'bound' };
    return { selected: null, disabled: true, reason: 'no_access' };
  }

  const picked = input.selectedAgent?.trim();
  if (picked && selectable.some((a) => a.name === picked)) {
    return { selected: picked, disabled: false, reason: 'selected' };
  }

  // No pick: the session's own agent outranks the project default — an
  // existing session must never re-prompt under a different agent than the
  // one it was created with just because a default or grant order says so.
  if (bound) {
    return { selected: bound, disabled: false, reason: 'bound' };
  }

  const declaredDefault = input.defaultAgent?.trim();
  if (declaredDefault && selectable.some((a) => a.name === declaredDefault)) {
    return { selected: declaredDefault, disabled: false, reason: 'default' };
  }

  // The default is not ours to run. Pre-select the first agent we DO have, so
  // the picker shows the agent that will actually run and the same name is
  // what the send carries.
  return { selected: selectable[0].name, disabled: false, reason: 'first_accessible' };
}

// Pre-W4 names, kept until the next major. The runtime is OpenCode or pi.
/** @deprecated Renamed to `projectConfigAgentsToRuntimeAgents`. Removed in the next major. */
export const projectConfigAgentsToOpenCodeAgents = projectConfigAgentsToRuntimeAgents;
