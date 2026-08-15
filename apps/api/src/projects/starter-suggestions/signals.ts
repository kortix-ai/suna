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
import { getPipedreamCatalogApps, pipedreamConfigured } from '../../connectors/pipedream';
import { compareByProminence, type CatalogApp } from '../../connectors/pipedream-search';
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
  /**
   * Real, connectable catalog apps the project has NOT already connected —
   * an offer list for the generator, not a workspace signal. Populated from
   * the in-process Pipedream catalog snapshot (`getPipedreamCatalogApps`),
   * fail-open to `[]` when Pipedream isn't configured, the snapshot is still
   * warming, or the read throws. See `renderSignalBundle`: this field is
   * deliberately excluded from `hasSignals`.
   */
  availableConnectors: Array<{ slug: string; name: string }>;
}

/** Per-section + whole-bundle caps for `renderSignalBundle` (chars unless noted). */
export const MEMORY_CAP = 3000;
export const README_CAP = 1500;
export const FILE_PATHS_MAX_ENTRIES = 100;
export const SESSIONS_CAP = 1500;
export const AGENTS_SKILLS_CAP = 1000;
export const AVAILABLE_CONNECTORS_CAP = 600;
export const BUNDLE_CAP = 8000;

/** Cap on how many catalog apps `selectAvailableConnectors` offers per run —
 *  keeps the rendered section (and the prompt's connector_slug choices)
 *  bounded regardless of catalogue size. */
export const MAX_AVAILABLE_CONNECTORS = 20;

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

  // NOT a workspace signal — an offer list the generator may point a
  // connector-setup suggestion at. Rendered so the model has real slugs to
  // choose from, but deliberately excluded from `hasSignals` below: a project
  // with an empty workspace and zero connected connectors must still fall
  // back to static suggestions rather than "personalizing" off nothing but
  // the catalogue.
  const availableConnectorsHasContent = s.availableConnectors.length > 0;
  if (availableConnectorsHasContent) {
    const combined = s.availableConnectors.map((c) => `${c.name} (${c.slug})`).join('\n');
    sections.push(`## Available connectors\n${truncate(combined, AVAILABLE_CONNECTORS_CAP)}`);
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

/** One active connector connection, identified for cross-referencing against
 *  the Pipedream catalog and against a suggestion's enriched `connector`
 *  field (route-side connected-filter, generation-time offer exclusion). */
export interface ConnectedConnector {
  name: string;
  /** Pipedream catalog app slug — real provider identity, not a display name.
   *  Present only for `provider_type = 'pipedream'` connectors, read from
   *  `connectors.config.app` (set by `connectorConfig` in `materialize.ts`
   *  from the manifest's `app:` field — the same value `createConnectToken`
   *  sends Pipedream and `getPipedreamCatalogApps()` keys catalog entries
   *  on). Every other provider (mcp/http/channel/computer/…) has no catalog
   *  app identity here — callers fall back to case-insensitive name
   *  comparison via `isConnectedApp`. */
  slug: string | null;
  updatedAt: Date;
}

/** `connectors.config.app` for a `provider_type = 'pipedream'` row, or `null`
 *  for every other provider (no reliable catalog-app identity exists there —
 *  see `ConnectedConnector.slug`'s doc comment for the full rationale). */
function connectorAppSlug(providerType: string, config: Record<string, unknown> | null): string | null {
  if (providerType !== 'pipedream') return null;
  const app = (config ?? {}).app;
  return typeof app === 'string' && app.trim() ? app.trim() : null;
}

/** Whether `app` (a catalog offer, or a suggestion's enriched `connector`) is
 *  one of `connected`'s apps — by slug when that connection carries one
 *  (provider-verified identity), else by case-insensitive name (the only
 *  signal available for non-Pipedream providers). */
export function isConnectedApp(
  app: { slug: string; name: string },
  connected: ConnectedConnector[],
): boolean {
  return connected.some((c) =>
    c.slug ? c.slug.toLowerCase() === app.slug.toLowerCase() : c.name.toLowerCase() === app.name.toLowerCase(),
  );
}

/**
 * Pure catalog-offer selection: apps from the snapshot the project has NOT
 * already connected (see `isConnectedApp` — slug when known, name
 * otherwise), ordered popular/featured-first (`compareByProminence`, the
 * same resting order the snapshot itself uses), capped to
 * `MAX_AVAILABLE_CONNECTORS`, and stripped to exactly the `{ slug, name }`
 * shape `SignalSources.availableConnectors` carries.
 *
 * `catalogApps === null` (snapshot missing/warming) fails open to `[]` —
 * unit-tested directly here since `readAvailableConnectors` below, like every
 * other IO sub-read in this module, is not.
 */
export function selectAvailableConnectors(
  catalogApps: CatalogApp[] | null,
  connected: ConnectedConnector[],
): Array<{ slug: string; name: string }> {
  if (!catalogApps || catalogApps.length === 0) return [];
  return [...catalogApps]
    .filter((app) => !isConnectedApp(app, connected))
    .sort(compareByProminence)
    .slice(0, MAX_AVAILABLE_CONNECTORS)
    .map((app) => ({ slug: app.slug, name: app.name }));
}

/** Only when Pipedream is configured — an unconfigured deployment has no
 *  catalog to offer, same gating as `listPipedreamApps` (`db-deps.ts`). */
function readAvailableConnectors(connected: ConnectedConnector[]): Array<{ slug: string; name: string }> {
  if (!pipedreamConfigured()) return [];
  try {
    return selectAvailableConnectors(getPipedreamCatalogApps(), connected);
  } catch {
    // Catalog read failed — no available-connectors signal.
    return [];
  }
}

/**
 * Real read: this project's active connector connections, each identified by
 * `{ name, slug, updatedAt }` — one row per connection (not de-duped; two
 * connections can point at the same connector, e.g. two Slack workspaces,
 * and callers that need recency want every row's `updatedAt`).
 *
 * Reused by the `starter-suggestions` route for both the serve-time
 * connected-filter (`isConnectedApp`) and the activity-aware staleness
 * signal (`max(updatedAt)` across these rows) — one query serves both, and
 * the route wraps the call in its own try/catch (fail-open there, unlike
 * `collectSignalSources`'s use below).
 */
export async function readConnectedConnectors(projectId: string): Promise<ConnectedConnector[]> {
  const rows = await db
    .select({
      name: connectors.name,
      config: connectors.config,
      providerType: connectors.providerType,
      updatedAt: connectorConnections.updatedAt,
    })
    .from(connectorConnections)
    .innerJoin(connectors, eq(connectors.connectorId, connectorConnections.connectorId))
    .where(and(eq(connectorConnections.projectId, projectId), eq(connectorConnections.status, 'active')));
  return rows.map((row) => ({
    name: row.name,
    slug: connectorAppSlug(row.providerType, row.config),
    updatedAt: row.updatedAt,
  }));
}

async function readConnectors(projectId: string): Promise<ConnectedConnector[]> {
  try {
    return await readConnectedConnectors(projectId);
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

  const [memory, readme, filePaths, config, sessions, connected] = await Promise.all([
    gitProject ? readMemoryFiles(gitProject) : Promise.resolve([]),
    gitProject ? readReadme(gitProject) : Promise.resolve(null),
    gitProject ? readFilePaths(gitProject) : Promise.resolve([]),
    gitProject ? readConfig(gitProject) : Promise.resolve({ agents: [], skills: [] }),
    readSessions(projectRow.projectId),
    readConnectors(projectRow.projectId),
  ]);

  // One connection per connector name can be redundant for the rendered
  // "## Connectors" section (two Slack workspaces should read as one
  // "Slack" signal) — de-dup here; `selectAvailableConnectors` below needs
  // every row (it matches by slug first), so it reads `connected` directly.
  const connectorNames = Array.from(new Set(connected.map((c) => c.name)));

  // Sequenced after `connected` (not folded into the `Promise.all` above)
  // because the offer must exclude apps this project already connected — it
  // needs that result, not just the project id. The read itself is
  // synchronous/non-blocking (an in-process snapshot lookup), so there's no
  // IO cost to paying for it after the rest lands.
  const availableConnectors = readAvailableConnectors(connected);

  return {
    onboarding,
    memory,
    readme,
    filePaths,
    sessions,
    agents: config.agents,
    skills: config.skills,
    connectors: connectorNames,
    availableConnectors,
  };
}
