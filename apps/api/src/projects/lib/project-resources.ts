/**
 * Project resource registry + per-resource list filtering.
 *
 * Agents and skills are file-based (kortix.yaml `agents:` / harness-native
 * agent markdown files and skills/<slug>/SKILL.md), so their stable identity is:
 *   - agent  → its `name` (also what service_accounts.agent_name keys on);
 *   - skill  → its directory `slug` (derived from the SKILL.md path), which is
 *     stable even when the display name changes.
 *
 * `iam_resource_grants.resource_id` keys on exactly these ids. This module is the
 * one place that maps a ProjectConfigSummary → those ids, so the grant-validation
 * routes, the picker the UI renders, and the list-filter all agree on the key.
 */
import type { ProjectConfigSummary } from '../git/types';
import { filterAccessibleProjectResources, hasAnyResourceGrants } from '../../iam';
import { loadProjectConfig, listRepoFiles } from '../git';
import { withProjectGitAuth } from './git';

/**
 * Load a project's config WITH its repo file list. File-based agents/skills
 * (harness-native agent markdown files, `skills/<slug>/`) are discovered by scanning the
 * files passed to loadProjectConfig — calling it with `[]` finds NONE. Every
 * resource path (the grant picker, the visibility denier) must go through this.
 */
export async function loadConfigWithFiles(
  row: Parameters<typeof withProjectGitAuth>[0] & { defaultBranch: string },
): Promise<ProjectConfigSummary> {
  const gitProject = await withProjectGitAuth(row);
  let files: Awaited<ReturnType<typeof listRepoFiles>> = [];
  try {
    files = await listRepoFiles(gitProject, row.defaultBranch);
  } catch {
    // Repo momentarily unreachable — fall back to manifest-only discovery.
  }
  return loadProjectConfig(gitProject, files);
}

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
    agents: (config.agents ?? []).map((a) => ({ id: a.name, name: a.name, description: a.description })),
    skills: (config.skills ?? []).map((s) => ({
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
  const agentIds = (config.agents ?? []).map((a) => a.name);
  const skillIds = (config.skills ?? []).map((s) => skillSlugFromPath(s.path) ?? s.name);
  const [okAgents, okSkills] = await Promise.all([
    filterAccessibleProjectResources(ctx.userId, ctx.accountId, ctx.projectId, 'agent', agentIds, ctx.actingTokenId),
    filterAccessibleProjectResources(ctx.userId, ctx.accountId, ctx.projectId, 'skill', skillIds, ctx.actingTokenId),
  ]);
  const okAgentSet = new Set(okAgents);
  const okSkillSet = new Set(okSkills);
  return {
    ...config,
    agents: (config.agents ?? []).filter((a) => okAgentSet.has(a.name)),
    skills: (config.skills ?? []).filter((s) => okSkillSet.has(skillSlugFromPath(s.path) ?? s.name)),
  };
}

// ─── Visibility isolation: deny reading the FILES of scoped-out resources ────
// The list-filter above hides ungranted agents/skills from the config, but a
// member could still read the raw markdown via the file routes. This denier
// centralizes "which repo paths is this member scoped out of" so every read
// surface (file content/list/search + the Slack picker) filters consistently —
// the red-team's root-cause fix for route-by-route forgetting.

function trimPath(p: string): string {
  return p.replace(/^\.?\//, '');
}

export interface ResourceDenier {
  /** true = this repo path belongs to an agent/skill the member is scoped out of. */
  isDenied: (path: string) => boolean;
  /** true = an archive/listing rooted at `subtree` ('' = whole repo) would
   *  INCLUDE a denied file — used to refuse a zip that can't be stripped. */
  containsDenied: (subtree: string) => boolean;
  /** The denied path prefixes/files — for logging. */
  denied: string[];
}

/**
 * Build a denier from an already-loaded config + the member's accessible set.
 * Returns null when nothing is denied (admin/owner/SA, or every resource is
 * accessible) so callers can skip filtering entirely.
 */
export async function denierFromConfig(
  config: ProjectConfigSummary,
  ctx: { userId: string; accountId: string; projectId: string; actingTokenId?: string },
): Promise<ResourceDenier | null> {
  const agentIds = (config.agents ?? []).map((a) => a.name);
  const skillIds = (config.skills ?? []).map((s) => skillSlugFromPath(s.path) ?? s.name);
  const [okAgents, okSkills] = await Promise.all([
    filterAccessibleProjectResources(ctx.userId, ctx.accountId, ctx.projectId, 'agent', agentIds, ctx.actingTokenId),
    filterAccessibleProjectResources(ctx.userId, ctx.accountId, ctx.projectId, 'skill', skillIds, ctx.actingTokenId),
  ]);
  return buildResourceDenier(config, new Set(okAgents), new Set(okSkills));
}

/**
 * PURE — the path-matching core, split out so it's unit-testable without the DB/
 * engine. Given the member's ACCESSIBLE agent names / skill slugs, returns the
 * denier that blocks the files of everything NOT accessible. Returns null when
 * nothing is denied. Skill dirs are matched with a trailing-slash prefix so a
 * sibling whose slug merely prefixes a denied one (`lead-research-v2`) is safe.
 */
export function buildResourceDenier(
  config: ProjectConfigSummary,
  okAgent: Set<string>,
  okSkill: Set<string>,
): ResourceDenier | null {
  // Denied agents → block their exact file (runtime-native agents are single
  // .md files in the current OpenCode harness; a kortix.yaml agent has no
  // separate file, only the shared manifest).
  const deniedExact = new Set<string>();
  for (const a of config.agents ?? []) {
    if (!okAgent.has(a.name) && (a.source === 'runtime' || a.source === 'opencode') && a.path) {
      deniedExact.add(trimPath(a.path));
    }
  }
  // Denied skills → block the whole skill directory (SKILL.md + references/…).
  const deniedPrefixes: string[] = [];
  for (const s of config.skills ?? []) {
    const slug = skillSlugFromPath(s.path) ?? s.name;
    if (!okSkill.has(slug)) {
      const trimmed = trimPath(s.path);
      const dir = trimmed.slice(0, trimmed.lastIndexOf('/') + 1); // ".../skills/<slug>/"
      if (dir) deniedPrefixes.push(dir);
    }
  }

  if (deniedExact.size === 0 && deniedPrefixes.length === 0) return null;
  const isDenied = (path: string) => {
    const p = trimPath(path);
    if (deniedExact.has(p)) return true;
    return deniedPrefixes.some((pre) => p === pre.slice(0, -1) || p.startsWith(pre));
  };
  const containsDenied = (subtree: string) => {
    const root = trimPath(subtree || '');
    if (!root) return true; // whole-repo archive always includes the denied files
    if (isDenied(root)) return true; // the subtree root itself is/under a denied resource
    const under = root + '/';
    for (const d of deniedExact) if (d.startsWith(under)) return true;
    for (const pre of deniedPrefixes) if (pre.startsWith(under)) return true;
    return false;
  };
  return { isDenied, containsDenied, denied: [...deniedExact, ...deniedPrefixes] };
}

/**
 * Route helper: build a denier for the current request, loading the config only
 * when the project actually scopes something (the common case is zero work — two
 * memo hits and out). Returns null = no filtering needed. On a config-load
 * failure with active scoping we log and return null (fail-open here is bounded:
 * the airtight version is the git-proxy tier that stops the files reaching the
 * sandbox at all; /detail degrades identically during the same outage).
 */
export async function resourceDenierForRequest(ctx: {
  userId: string;
  accountId: string;
  projectId: string;
  actingTokenId?: string;
  row: Parameters<typeof withProjectGitAuth>[0] & { defaultBranch: string };
}): Promise<ResourceDenier | null> {
  if (!(await hasAnyResourceGrants(ctx.projectId))) return null;
  let config: ProjectConfigSummary;
  try {
    config = await loadConfigWithFiles(ctx.row);
  } catch (err) {
    console.warn('[resource-denier] config load failed; skipping file-path scoping', {
      projectId: ctx.projectId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  return denierFromConfig(config, ctx);
}
