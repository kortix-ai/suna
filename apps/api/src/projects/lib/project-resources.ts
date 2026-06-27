/**
 * Project resource registry + per-resource list filtering.
 *
 * Agents and skills are file-based (kortix.toml [[agents]] / .opencode/agent/*.md
 * and .opencode/skills/<slug>/SKILL.md), so their stable identity is:
 *   - agent  → its `name` (also what service_accounts.agent_name keys on);
 *   - skill  → its directory `slug` (derived from the SKILL.md path), which is
 *     stable even when the display name changes.
 *
 * `iam_resource_grants.resource_id` keys on exactly these ids. This module is the
 * one place that maps a ProjectConfigSummary → those ids, so the grant-validation
 * routes, the picker the UI renders, and the list-filter all agree on the key.
 */
import type { ProjectConfigSummary } from '../git/types';
import { filterAccessibleProjectResources } from '../../iam';

export interface ProjectResourceItem {
  /** Stable grant key — agent name / skill slug. */
  id: string;
  /** Display name (may differ from the slug for skills). */
  name: string;
  description: string | null;
}

export interface ProjectResources {
  agents: ProjectResourceItem[];
  skills: ProjectResourceItem[];
}

const SKILL_SLUG_RE = /\/skills\/(.+?)\/SKILL\.md$/;

/** Stable slug for a skill from its SKILL.md path; falls back to null. */
export function skillSlugFromPath(path: string): string | null {
  const m = SKILL_SLUG_RE.exec(path);
  return m ? m[1] : null;
}

/** Map a loaded project config → the grantable agent/skill resource ids. */
export function projectResourcesFromConfig(config: ProjectConfigSummary): ProjectResources {
  return {
    agents: config.agents.map((a) => ({ id: a.name, name: a.name, description: a.description })),
    skills: config.skills.map((s) => ({
      id: skillSlugFromPath(s.path) ?? s.name,
      name: s.name,
      description: s.description,
    })),
  };
}

/** Validate a (resourceType, resourceId) against what the project actually has. */
export function projectHasResource(
  config: ProjectConfigSummary,
  resourceType: 'agent' | 'skill',
  resourceId: string,
): boolean {
  const res = projectResourcesFromConfig(config);
  const set = resourceType === 'agent' ? res.agents : res.skills;
  return set.some((r) => r.id === resourceId);
}

/**
 * Return a copy of the config with `agents`/`skills` narrowed to the ones the
 * user may access (per-resource scoping). Owner/admins/SAs see the full lists.
 * One memoized grant load per type — no N×authorize round-trips.
 */
export async function filterConfigResourcesForUser(
  config: ProjectConfigSummary,
  ctx: { userId: string; accountId: string; projectId: string; actingTokenId?: string },
): Promise<ProjectConfigSummary> {
  const agentIds = config.agents.map((a) => a.name);
  const skillIds = config.skills.map((s) => skillSlugFromPath(s.path) ?? s.name);
  const [okAgents, okSkills] = await Promise.all([
    filterAccessibleProjectResources(ctx.userId, ctx.accountId, ctx.projectId, 'agent', agentIds, ctx.actingTokenId),
    filterAccessibleProjectResources(ctx.userId, ctx.accountId, ctx.projectId, 'skill', skillIds, ctx.actingTokenId),
  ]);
  const okAgentSet = new Set(okAgents);
  const okSkillSet = new Set(okSkills);
  return {
    ...config,
    agents: config.agents.filter((a) => okAgentSet.has(a.name)),
    skills: config.skills.filter((s) => okSkillSet.has(skillSlugFromPath(s.path) ?? s.name)),
  };
}
