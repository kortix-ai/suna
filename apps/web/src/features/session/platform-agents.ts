import type { ProjectConfigSummary } from '@kortix/sdk';
import type { Agent } from '@kortix/sdk/react';

/**
 * Platform-owned agents (today: the Kortix AGI) — the control agents the
 * platform ships into every workspace. The project-config entry carries
 * `platform_owned: true`; the OpenCode `Agent` shape the pickers render does
 * NOT, so the names have to be carried alongside the roster.
 *
 * `platform_owned === true` is the only sanctioned marker. Never match on the
 * agent's name and never branch on `source` — `source: 'platform'` is a
 * descriptive signal, the boolean is the contract. Workspace agents omit the
 * field entirely, so this is an identity check, not a truthiness check.
 */
export function platformOwnedAgentNames(
  config: Pick<ProjectConfigSummary, 'agents'> | undefined | null,
): string[] {
  if (!config?.agents) return [];
  return config.agents.filter((a) => a.platform_owned === true).map((a) => a.name);
}

/**
 * Split a picker roster into the elevated platform agents and the workspace's
 * own agents, preserving the incoming order within each bucket.
 *
 * `names` empty (no `agi` flag, or the caller never wired it) yields an empty
 * `platform` bucket and a `workspace` bucket identical to the input — the
 * picker then renders exactly what it rendered before this existed.
 */
export function splitPlatformAgents<T extends { name: string }>(
  agents: readonly T[],
  names: readonly string[],
): { platform: T[]; workspace: T[] } {
  if (names.length === 0) return { platform: [], workspace: [...agents] };
  const owned = new Set(names);
  const platform: T[] = [];
  const workspace: T[] = [];
  for (const agent of agents) {
    (owned.has(agent.name) ? platform : workspace).push(agent);
  }
  return { platform, workspace };
}

/** Longest lead clause we'll promote to a title before it reads as a sentence. */
const MAX_LEAD_TITLE_LENGTH = 40;

/**
 * Presentation copy for an elevated agent.
 *
 * Platform descriptions lead with the product name and an em dash
 * ("Kortix AGI — the control agent that…"), which carries a far better title
 * than the kebab-case slug the generic picker would `capitalize` into
 * "Kortix-Agi". Split on that dash when it produces a short lead and a
 * non-empty remainder; otherwise fall back to the raw name and description, so
 * a reworded description degrades to today's rendering instead of breaking.
 */
export function platformAgentCopy(agent: Pick<Agent, 'name' | 'description'>): {
  title: string;
  titleIsFromDescription: boolean;
  description: string | null;
} {
  const description = agent.description?.trim() || null;
  const dash = description?.indexOf('—') ?? -1;
  if (description && dash > 0) {
    const lead = description.slice(0, dash).trim();
    const rest = description.slice(dash + 1).trim();
    if (lead && rest && lead.length <= MAX_LEAD_TITLE_LENGTH) {
      return {
        title: lead,
        titleIsFromDescription: true,
        description: rest.charAt(0).toUpperCase() + rest.slice(1),
      };
    }
  }
  return { title: agent.name, titleIsFromDescription: false, description };
}
