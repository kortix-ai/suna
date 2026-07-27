/**
 * Platform-owned agents in the project's agent LIST — the discovery half of
 * R-34/R-35 (docs/specs/2026-07-26-agi-autonomous-operations.md §9).
 *
 * The AGI was already *reachable*: `grantFromLoadedAgents` /
 * `resolveGovernedAgentGrant` (../agents.ts) answer the reserved name before
 * the manifest roster is consulted, and `withPlatformAgiAgent`
 * (./agi-agent-behavior.ts) folds its behavior into the session config. What it
 * was not is *discoverable* — it appeared in no list, so no picker could offer
 * it and the only way to run it was to already know the name.
 *
 * This module closes that WITHOUT weakening R-35. It composes the AGI entry ON
 * TOP of a finished `ProjectConfigSummary`, so:
 *
 *   - `loadProjectAgents` / `extractAgents` are untouched — the AGI still needs
 *     no `agents:` block and still never enters the manifest roster. Everything
 *     that reads the roster (grant resolution, the mandatory-declared-agents
 *     gate, `projectHasResource`, the resource-grant picker) sees exactly what
 *     it saw before.
 *   - The composition is the LAST word: whatever the manifest produced is
 *     filtered first, so a project that declares `agents.kortix-agi` cannot
 *     shadow, narrow, widen, or disable the platform entry.
 *
 * The reserved name is stripped from the workspace roster whether or not the
 * AGI is listed. That is not tidiness — it is truthfulness. Selecting an entry
 * named `kortix-agi` runs the PLATFORM agent (the grant resolver and the
 * behavior fold both key on the literal name), so listing a workspace entry by
 * that name would advertise a scope/description that could never take effect.
 */

import { AGI_AGENT_NAME, isAgiAgentName } from '../agents';
import type { ProjectConfigSummary } from '../git/types';
import { agiOpencodeAgentConfig } from './agi-agent-behavior';

/** One entry of `ProjectConfigSummary.agents` — the wire shape a picker renders. */
export type ProjectConfigAgent = ProjectConfigSummary['agents'][number];

/**
 * The AGI's `path`. Every other entry's `path` is repo-relative and readable
 * through the file routes; the AGI has no repo file (R-35/R-36 — its behavior
 * ships bundled and arrives through the environment). A URI, not a path, so it
 * can never collide with a real repo path, stays a stable list key, and is
 * self-evidently not something to open in the file viewer.
 */
export const AGI_AGENT_PATH = `kortix://platform/agents/${AGI_AGENT_NAME}.md`;

/**
 * Shown only if the bundled behavior file can't be read (a packaging defect —
 * see `agiOpencodeAgentConfig`). The live description comes from that file's
 * frontmatter so the picker cannot describe an agent that differs from the one
 * that actually boots.
 */
export const AGI_AGENT_FALLBACK_DESCRIPTION =
  'Kortix AGI — the control agent that runs this workspace. It holds the goals, keeps the task board moving, and gets work done by spawning sessions rather than doing the work itself.';

/**
 * `mode: 'primary'` is asserted, not read from the file: the mode decides
 * whether the agent is offerable at all (pickers drop `subagent`), and R-37
 * requires the AGI to be offered in every workspace. A bad frontmatter edit
 * must not be able to delete it from every picker on the platform.
 */
export function agiAgentListEntry(): ProjectConfigAgent {
  const behavior = agiOpencodeAgentConfig();
  return {
    name: AGI_AGENT_NAME,
    path: AGI_AGENT_PATH,
    description: behavior?.description?.trim() || AGI_AGENT_FALLBACK_DESCRIPTION,
    mode: 'primary',
    source: 'platform',
    enabled: true,
    platform_owned: true,
  };
}

/**
 * Compose the platform-owned agents into a loaded project config.
 *
 * `agiEnabled` is the project's `agi` experimental key (R-44): off means the
 * AGI is ABSENT, not disabled-but-listed — same rule as every other AGI
 * surface, whose routes 404 rather than 403 when the key is off.
 *
 * Elevation (R-37) is expressed twice, on purpose: `platform_owned: true` is
 * the field a client branches on, and FIRST position is the ordering a client
 * gets for free if it renders the list as-is.
 *
 * Returns the input object unchanged when there is nothing to compose, so a
 * caller can hand this a config it intends to keep using by reference.
 */
export function withPlatformAgents(
  config: ProjectConfigSummary,
  opts: { agiEnabled: boolean },
): ProjectConfigSummary {
  const declared = config.agents ?? [];
  const workspaceAgents = declared.filter((agent) => !isAgiAgentName(agent.name));

  if (!opts.agiEnabled) {
    if (workspaceAgents.length === declared.length) return config;
    return { ...config, agents: workspaceAgents };
  }
  return { ...config, agents: [agiAgentListEntry(), ...workspaceAgents] };
}
