import { interpolateVars, type StarterTemplateId } from '@kortix/starter';
import { parseManifestText } from '@kortix/manifest-schema';
import { findCatalogEntryByName, getCatalogEntry } from '../marketplace/catalog';
import { buildStarterFiles } from './starter';

export interface ProjectSeedFilesInput {
  projectName: string;
  repoFullName: string;
  template: StarterTemplateId;
  /** Accepted for API back-compat; no longer deterministically installed at
   *  provision time — see docs/specs/2026-07-13-marketplace-as-projects.md.
   *  Adding a marketplace item to a project is now an agent import
   *  (POST /:projectId/marketplace/install-session), which needs a session
   *  (and therefore an already-existing project) to run. */
  marketplaceItems: string[];
  now: string;
}

export function normalizeMarketplaceItems(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];
  return [...new Set(raw
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean))];
}

function mergeSeedFiles(
  base: Array<{ path: string; content: string }>,
  extra: Array<{ path: string; content: string }>,
): Array<{ path: string; content: string }> {
  const byPath = new Map(base.map((file) => [file.path, file.content] as const));
  for (const file of extra) byPath.set(file.path, file.content);
  return [...byPath.entries()]
    .map(([path, content]) => ({ path, content }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Seed a brand-new project's deterministic scaffold: just the starter's own
 * runtime files (kortix.yaml, opencode config, base skills) for `template`.
 * No lock, no dependency engine — marketplace items are never deterministically
 * installed at provision time; adding one to a project is an agent import.
 */
export async function buildProjectSeedFiles(input: ProjectSeedFilesInput): Promise<{
  files: Array<{ path: string; content: string }>;
  baseFiles: Array<{ path: string; content: string }>;
}> {
  const baseFiles = buildStarterFiles({
    projectName: 'kortix-project',
    repoFullName: 'kortix/kortix-project',
    template: input.template,
  });
  const files = buildStarterFiles({
    projectName: input.projectName,
    repoFullName: input.repoFullName,
    template: input.template,
  });

  return { files, baseFiles };
}

export interface ProjectSeedFilesFromItemInput {
  /** Catalog id of a `registry:project` item, e.g. `kortix-projects:support-agent-kit`. */
  id: string;
  projectName: string;
  repoFullName: string;
  /** Accepted for API back-compat; no longer deterministically installed —
   *  see `ProjectSeedFilesInput.marketplaceItems`. */
  extraMarketplaceItems: string[];
  now: string;
}

/**
 * Seed a brand-new project by cloning a `registry:project` marketplace item.
 * The minimal starter gives the new repo its opencode runtime (tools,
 * plugins, opencode.jsonc, base skills) exactly like any other new project;
 * the project item's own files (its kortix.yaml, agent personas, …) are
 * already inline on the catalog entry (`entry.item.files`, see
 * `buildProjectTemplateRegistry` in apps/api/src/marketplace/catalog.ts) — no
 * install engine, no lock, just a plain file union with the destination
 * project's name interpolated in.
 */
export async function buildProjectSeedFilesFromItem(input: ProjectSeedFilesFromItemInput): Promise<{
  files: Array<{ path: string; content: string }>;
  baseFiles: Array<{ path: string; content: string }>;
}> {
  const baseFiles = buildStarterFiles({
    projectName: 'kortix-project',
    repoFullName: 'kortix/kortix-project',
    template: 'minimal',
  });
  const starterFiles = buildStarterFiles({
    projectName: input.projectName,
    repoFullName: input.repoFullName,
    template: 'minimal',
  });

  const entry = (await getCatalogEntry(input.id)) ?? (await findCatalogEntryByName(input.id));
  if (!entry) throw new Error(`unknown item "${input.id}"`);

  // Project-item catalog content ships with `{{var}}` placeholders unresolved
  // (see `buildProjectTemplateRegistry` in apps/api/src/marketplace/catalog.ts)
  // so they can be resolved here against the real destination project's name
  // instead of a generic catalog-display placeholder. Reuses @kortix/starter's
  // own `{{var}}` convention rather than a local reimplementation.
  const vars = { projectName: input.projectName, repoFullName: input.repoFullName };
  const ownFiles = (entry.item.files ?? [])
    .filter((f) => typeof f.content === 'string')
    .map((f) => ({ path: f.path, content: interpolateVars(f.content as string, vars) }));

  const files = mergeSeedFiles(starterFiles, ownFiles);

  return { files, baseFiles };
}

/**
 * Best-effort extraction of a seeded `kortix.yaml`'s top-level `default_agent`
 * from a file list POST /projects/provision is about to push. Used to stamp
 * `project.metadata.default_agent` (the read-optimized mirror session creation
 * and the LLM gateway's model-default resolution consult — see
 * projects/lib/sessions.ts and llm-gateway/resolution/default-model.ts) at
 * project-creation time, the same value `PUT /:projectId/default-agent`
 * writes later. Without this, a brand-new project's manifest declares a
 * default agent (the starter template ships `default_agent: kortix`) that the
 * DB mirror never learns about — every session then stores the non-binding
 * `'default'` sentinel instead, and any agent-scope model pin set on the real
 * agent name is silently never applied (the bug this closes).
 *
 * Never throws: a parse failure here must not fail project creation —
 * session creation's own manifest read (for MANDATORY DECLARED AGENTS
 * projects) is the actual source of truth and will surface a real error if
 * the manifest is genuinely broken.
 */
export function defaultAgentFromSeedFiles(
  files: Array<{ path: string; content: string }>,
  manifestPath: string,
): string | null {
  const manifestFile = files.find((f) => f.path === manifestPath) ?? files.find((f) => f.path === 'kortix.yaml');
  if (!manifestFile) return null;
  try {
    const raw = parseManifestText(manifestFile.content, 'yaml');
    const defaultAgent = raw.default_agent;
    return typeof defaultAgent === 'string' && defaultAgent.trim() ? defaultAgent.trim() : null;
  } catch {
    return null;
  }
}
