/**
 * The kortix-managed system skills, as data.
 *
 * These are the `kortix-*` markdown skills that tell an agent how Kortix itself
 * works (sessions, sandboxes, the executor/approval loop, memory, channels, the
 * CLI). Until now they were only reachable two ways: scaffolded into a project's
 * git tree by `kortix init`, or baked into the sandbox image at
 * `/opt/kortix/managed-skills` and overlaid per session. Both require being
 * *inside* Kortix. An agent in Claude Code / Codex / OpenCode holding nothing but
 * the `kortix` binary and a token had no way to read them.
 *
 * SOURCE OF TRUTH: `@kortix/starter`. This module runs the exact same extraction
 * as `packages/starter/scripts/write-managed-skills.ts` (the script that bakes the
 * sandbox image) — same `getStarterFiles()` call, same `projectName: 'Kortix'`
 * interpolation, same `isKortixManagedSkillName()` filter — so what the API serves
 * is byte-identical to what a session gets overlaid. `@kortix/starter` is already
 * an apps/api dependency and its `templates/` tree is COPYed into the API image
 * (see apps/api/Dockerfile), so the served text ships with the deploy and cannot
 * drift from the running version. No git clone, no network fetch, no cache to
 * invalidate.
 *
 * `getMarketplaceFiles()` is included alongside the starter walk because one
 * managed name — `kortix-computer` — lives in the `marketplace` template layer
 * rather than the base/general-knowledge-worker layers. Without it that skill
 * would be listed in `KORTIX_MANAGED_SKILL_NAMES` but unresolvable here.
 */

import { parseFrontmatter } from '@kortix/registry';
import {
  getManagedSkillFiles,
  getMarketplaceFiles,
  getStarterFiles,
  isKortixManagedSkillName,
} from '@kortix/starter';

/** Where skills live inside a Kortix project (and inside the starter templates). */
const SKILLS_PREFIX = '.kortix/opencode/skills/';
/** The skill body every skill has; everything else under the dir is a reference. */
const SKILL_ENTRYPOINT = 'SKILL.md';

export interface ManagedSkillFile {
  /** Path relative to the skill directory, e.g. `references/opencode/tools.md`. */
  path: string;
  content: string;
}

export interface ManagedSkill {
  name: string;
  /** Frontmatter `description` — the agent-facing "load this when…" trigger. */
  description: string;
  /** Full SKILL.md text, frontmatter included. */
  body: string;
  /** Every other file in the skill dir, sorted by path. */
  references: ManagedSkillFile[];
  /** Total bytes of body + references — what a `--full` read costs. */
  bytes: number;
}

export interface ManagedSkillSummary {
  name: string;
  description: string;
  referenceCount: number;
  bytes: number;
}

/**
 * Walk the starter + marketplace template trees and group the managed `kortix-*`
 * skills by name. Pure (no I/O beyond @kortix/starter's own template read) and
 * exported for unit tests; production callers use the memoized `managedSkills()`.
 */
export function buildManagedSkills(): Map<string, ManagedSkill> {
  const files = [
    ...getManagedSkillFiles(),
    ...getStarterFiles({ projectName: 'Kortix', template: 'general-knowledge-worker' }),
    ...getMarketplaceFiles(),
  ];

  const grouped = new Map<string, ManagedSkillFile[]>();
  for (const file of files) {
    if (!file.path.startsWith(SKILLS_PREFIX)) continue;
    const rest = file.path.slice(SKILLS_PREFIX.length);
    const slash = rest.indexOf('/');
    if (slash <= 0) continue;
    const name = rest.slice(0, slash);
    if (!isKortixManagedSkillName(name)) continue;
    const entry = { path: rest.slice(slash + 1), content: file.content };
    const bucket = grouped.get(name);
    if (bucket) bucket.push(entry);
    else grouped.set(name, [entry]);
  }

  const skills = new Map<string, ManagedSkill>();
  for (const [name, entries] of [...grouped].sort((a, b) => a[0].localeCompare(b[0]))) {
    const body = entries.find((e) => e.path === SKILL_ENTRYPOINT)?.content;
    // A directory with no SKILL.md is not a loadable skill — omit it rather than
    // serve a body-less entry a caller would have to special-case.
    if (!body) continue;
    const references = entries
      .filter((e) => e.path !== SKILL_ENTRYPOINT)
      .sort((a, b) => a.path.localeCompare(b.path));
    skills.set(name, {
      name,
      description: parseFrontmatter(body).description ?? '',
      body,
      references,
      bytes: entries.reduce((total, e) => total + e.content.length, 0),
    });
  }
  return skills;
}

// The template tree is immutable for the lifetime of a deploy, so build once.
let cached: Map<string, ManagedSkill> | null = null;

export function managedSkills(): Map<string, ManagedSkill> {
  if (!cached) cached = buildManagedSkills();
  return cached;
}

/** Test-only: drop the memo so a test can rebuild against a mutated fixture. */
export function _resetManagedSkillsCache(): void {
  cached = null;
}

/**
 * The cheap list. Bodies are large (kortix-system's SKILL.md alone is ~41 KB, its
 * full tree ~230 KB), so listing deliberately carries no content — only the
 * frontmatter `description`, which is written as the agent's routing signal and is
 * the one field it needs to pick correctly. The whole list is ~7 KB for 10 skills.
 */
export function listManagedSkills(): ManagedSkillSummary[] {
  return [...managedSkills().values()].map((skill) => ({
    name: skill.name,
    description: skill.description,
    referenceCount: skill.references.length,
    bytes: skill.bytes,
  }));
}

export function getManagedSkill(name: string): ManagedSkill | null {
  return managedSkills().get(name) ?? null;
}

/**
 * One reference file by its skill-relative path. Lookup is an exact match against
 * the built index, so `../` and absolute paths simply miss — there is no filesystem
 * read here to traverse out of.
 */
export function getManagedSkillFile(name: string, path: string): ManagedSkillFile | null {
  const skill = managedSkills().get(name);
  if (!skill) return null;
  if (path === SKILL_ENTRYPOINT) return { path: SKILL_ENTRYPOINT, content: skill.body };
  return skill.references.find((f) => f.path === path) ?? null;
}
