// Per-project "signals" for personalized starter-prompt suggestions: gathers
// the context an LLM prompts on (onboarding answers, repo memory/README/file
// tree, recent session titles/prompts, configured agents/skills, connected
// connectors) and renders it into one capped text bundle.
//
// `renderSignalBundle` is pure and fully unit-tested. `collectSignalSources`
// does the real reads and composes existing git/db/config helpers — every
// sub-read is individually try/caught to its documented empty value, so one
// missing repo file or one failed query never blanks the whole bundle.

import { and, desc, eq } from 'drizzle-orm';
import { connectorConnections, connectors, projectSessions } from '@kortix/db';
import { db } from '../../shared/db';
import { withProjectGitAuth } from '../lib/git';
import type { ProjectRow } from '../lib/serializers';
import {
  loadProjectConfig,
  listRepoFiles,
  readRepoFile,
  type GitBackedProject,
} from '../git';

/** Per-project context gathered for the starter-suggestion generator prompt. */
export interface SignalSources {
  onboarding: Record<string, unknown> | null;
  memory: Array<{ path: string; content: string }>;
  readme: string | null;
  filePaths: string[];
  sessions: Array<{ title: string | null; initialPrompt: string | null }>;
  agents: Array<{ name: string; description?: string }>;
  skills: Array<{ name: string; description?: string }>;
  connectors: string[];
}

/** Per-section + whole-bundle caps for `renderSignalBundle` (chars unless noted). */
export const MEMORY_CAP = 3000;
export const README_CAP = 1500;
export const FILE_PATHS_MAX_ENTRIES = 100;
export const SESSIONS_CAP = 1500;
export const AGENTS_SKILLS_CAP = 1000;
export const BUNDLE_CAP = 8000;

function truncate(text: string, cap: number): string {
  return text.length <= cap ? text : text.slice(0, cap);
}

function isNonEmptyText(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function formatNamed(items: Array<{ name: string; description?: string }>): string {
  return items
    .map((item) => (isNonEmptyText(item.description) ? `- ${item.name}: ${item.description}` : `- ${item.name}`))
    .join('\n');
}

/**
 * Pure renderer: turns collected `SignalSources` into one labeled text
 * bundle for the generator prompt. Sections that have no content are omitted
 * entirely (no empty `## Heading` with nothing under it). Caps are applied
 * per-section first, then the whole joined bundle is truncated to
 * `BUNDLE_CAP` (tail truncation — a mid-section cut is acceptable, the caller
 * only needs a bounded prompt).
 */
export function renderSignalBundle(s: SignalSources): { text: string; hasSignals: boolean } {
  const sections: string[] = [];

  const onboardingHasContent =
    s.onboarding !== null && typeof s.onboarding === 'object' && Object.keys(s.onboarding).length > 0;
  if (onboardingHasContent) {
    sections.push(`## Onboarding\n${JSON.stringify(s.onboarding)}`);
  }

  const memoryEntries = s.memory.filter((m) => isNonEmptyText(m.content));
  const memoryHasContent = memoryEntries.length > 0;
  if (memoryHasContent) {
    const combined = memoryEntries.map((m) => `### ${m.path}\n${m.content}`).join('\n\n');
    sections.push(`## Memory\n${truncate(combined, MEMORY_CAP)}`);
  }

  const readmeHasContent = isNonEmptyText(s.readme);
  if (readmeHasContent) {
    sections.push(`## README\n${truncate(s.readme as string, README_CAP)}`);
  }

  const filePathsHasContent = s.filePaths.length > 0;
  if (filePathsHasContent) {
    sections.push(`## Files\n${s.filePaths.slice(0, FILE_PATHS_MAX_ENTRIES).join('\n')}`);
  }

  const sessionEntries = s.sessions.filter(
    (session) => isNonEmptyText(session.title) || isNonEmptyText(session.initialPrompt),
  );
  const sessionsHasContent = sessionEntries.length > 0;
  if (sessionsHasContent) {
    const combined = sessionEntries
      .map((session) => {
        const title = isNonEmptyText(session.title) ? session.title : '(untitled)';
        return isNonEmptyText(session.initialPrompt) ? `- ${title}: ${session.initialPrompt}` : `- ${title}`;
      })
      .join('\n');
    sections.push(`## Recent sessions\n${truncate(combined, SESSIONS_CAP)}`);
  }

  const agentsHasContent = s.agents.length > 0;
  const skillsHasContent = s.skills.length > 0;
  if (agentsHasContent || skillsHasContent) {
    const parts: string[] = [];
    if (agentsHasContent) parts.push(`## Agents\n${formatNamed(s.agents)}`);
    if (skillsHasContent) parts.push(`## Skills\n${formatNamed(s.skills)}`);
    sections.push(truncate(parts.join('\n\n'), AGENTS_SKILLS_CAP));
  }

  const connectorNames = s.connectors.filter((c) => isNonEmptyText(c));
  const connectorsHasContent = connectorNames.length > 0;
  if (connectorsHasContent) {
    sections.push(`## Connectors\n${connectorNames.join(', ')}`);
  }

  const hasSignals =
    onboardingHasContent ||
    memoryHasContent ||
    readmeHasContent ||
    filePathsHasContent ||
    sessionsHasContent ||
    agentsHasContent ||
    skillsHasContent ||
    connectorsHasContent;

  const text = truncate(sections.join('\n\n'), BUNDLE_CAP);

  return { text, hasSignals };
}

/** `metadata->>'<key>'` semantics, in TypeScript: a jsonb scalar reads as
 *  text, a missing/non-scalar key as null. Same idiom as
 *  `session-title-generate.ts`'s `metadataText` (not exported from there). */
function metadataText(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : null;
}

function extractOnboarding(projectRow: ProjectRow): Record<string, unknown> | null {
  const metadata = (projectRow.metadata ?? {}) as Record<string, unknown>;
  const onboarding = metadata.onboarding;
  if (onboarding !== null && typeof onboarding === 'object' && !Array.isArray(onboarding)) {
    return onboarding as Record<string, unknown>;
  }
  return null;
}

async function readReadme(project: GitBackedProject): Promise<string | null> {
  try {
    return await readRepoFile(project, 'README.md', project.defaultBranch);
  } catch {
    // README.md missing at this ref, or the read failed — no readme signal.
    return null;
  }
}

async function readFilePaths(project: GitBackedProject): Promise<string[]> {
  try {
    const entries = await listRepoFiles(project, project.defaultBranch);
    return entries.map((entry) => entry.path);
  } catch {
    // Repo tree listing failed (mirror refresh, auth, …) — no file-path signal.
    return [];
  }
}

async function readConfig(
  project: GitBackedProject,
): Promise<{ agents: Array<{ name: string; description?: string }>; skills: Array<{ name: string; description?: string }> }> {
  try {
    const config = await loadProjectConfig(project);
    return {
      agents: config.agents.map((a) => (a.description ? { name: a.name, description: a.description } : { name: a.name })),
      skills: config.skills.map((s) => (s.description ? { name: s.name, description: s.description } : { name: s.name })),
    };
  } catch {
    // Manifest/config parsing failed — no agents/skills signal.
    return { agents: [], skills: [] };
  }
}

/**
 * `.kortix/memory/MEMORY.md` first, then the remaining `.md` files under
 * `.kortix/memory/` (alphabetical), reading only as many as fit the
 * `MEMORY_CAP` read budget — `renderSignalBundle` re-truncates the combined
 * text regardless, this just avoids fetching megabytes of memory files we'd
 * throw away anyway.
 */
async function readMemoryFiles(project: GitBackedProject): Promise<Array<{ path: string; content: string }>> {
  let entries: Array<{ path: string }>;
  try {
    entries = await listRepoFiles(project, project.defaultBranch, '.kortix/memory');
  } catch {
    // `.kortix/memory` doesn't exist, or the listing failed — no memory signal.
    return [];
  }

  const mdPaths = entries.map((entry) => entry.path).filter((path) => path.endsWith('.md'));
  const primary = mdPaths.filter((path) => path.endsWith('/MEMORY.md') || path === 'MEMORY.md');
  const rest = mdPaths.filter((path) => !primary.includes(path)).sort();
  const orderedPaths = [...primary, ...rest];

  const results: Array<{ path: string; content: string }> = [];
  let budget = MEMORY_CAP;
  for (const path of orderedPaths) {
    if (budget <= 0) break;
    try {
      const content = await readRepoFile(project, path, project.defaultBranch);
      results.push({ path, content });
      budget -= content.length;
    } catch {
      // This one memory file vanished/failed between list and read — skip it,
      // keep collecting the rest.
    }
  }
  return results;
}

async function readSessions(
  projectId: string,
): Promise<Array<{ title: string | null; initialPrompt: string | null }>> {
  try {
    const rows = await db
      .select({ metadata: projectSessions.metadata })
      .from(projectSessions)
      .where(eq(projectSessions.projectId, projectId))
      .orderBy(desc(projectSessions.updatedAt))
      .limit(10);
    return rows.map((row) => {
      const metadata = (row.metadata ?? {}) as Record<string, unknown>;
      const title = metadataText(metadata, 'custom_name') ?? metadataText(metadata, 'name');
      const initialPrompt = metadataText(metadata, 'initial_prompt');
      return { title, initialPrompt };
    });
  } catch {
    // Session query failed — no session signal.
    return [];
  }
}

async function readConnectors(projectId: string): Promise<string[]> {
  try {
    const rows = await db
      .select({ name: connectors.name })
      .from(connectorConnections)
      .innerJoin(connectors, eq(connectors.connectorId, connectorConnections.connectorId))
      .where(and(eq(connectorConnections.projectId, projectId), eq(connectorConnections.status, 'active')));
    // De-dup: two connections can point at the same connector (e.g. two Slack
    // workspaces) — one signal entry per distinct connector name.
    return Array.from(new Set(rows.map((row) => row.name)));
  } catch {
    // Connector query failed — no connector signal.
    return [];
  }
}

/**
 * Does the real reads and composes `SignalSources` for one project. Not unit
 * tested directly (pure IO composition) — every sub-read above is
 * independently try/caught to its empty value, and Task 4's orchestrator
 * tests exercise this shape via injected sources.
 */
export async function collectSignalSources(projectRow: ProjectRow): Promise<SignalSources> {
  const onboarding = extractOnboarding(projectRow);

  let gitProject: GitBackedProject | null = null;
  try {
    gitProject = await withProjectGitAuth(projectRow);
  } catch {
    // No resolvable git auth for this project — every git-backed read below
    // is skipped and returns its empty value.
    gitProject = null;
  }

  const [memory, readme, filePaths, config, sessions, connectorNames] = await Promise.all([
    gitProject ? readMemoryFiles(gitProject) : Promise.resolve([]),
    gitProject ? readReadme(gitProject) : Promise.resolve(null),
    gitProject ? readFilePaths(gitProject) : Promise.resolve([]),
    gitProject ? readConfig(gitProject) : Promise.resolve({ agents: [], skills: [] }),
    readSessions(projectRow.projectId),
    readConnectors(projectRow.projectId),
  ]);

  return {
    onboarding,
    memory,
    readme,
    filePaths,
    sessions,
    agents: config.agents,
    skills: config.skills,
    connectors: connectorNames,
  };
}
