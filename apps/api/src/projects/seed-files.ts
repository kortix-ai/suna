import type { StarterTemplateId } from '@kortix/starter';
import { hashContent, parseLockContent, serializeLock } from '@kortix/registry';
import { buildInstall, buildInstallBatch } from '../marketplace/install-service';
import { buildStarterFiles } from './starter';

export interface ProjectSeedFilesInput {
  projectName: string;
  repoFullName: string;
  template: StarterTemplateId;
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

function starterSkillName(path: string): string | null {
  const marker = '.kortix/opencode/skills/';
  if (!path.startsWith(marker)) return null;
  const parts = path.slice(marker.length).split('/');
  if (parts.length < 2) return null;
  return parts[0] === 'GENERAL-KNOWLEDGE-WORKER' ? parts[1] ?? null : parts[0] ?? null;
}

function starterSkillLockFile(files: Array<{ path: string; content: string }>, now: string): {
  path: string;
  content: string;
} | null {
  const grouped = new Map<string, Array<{ target: string; hash: string }>>();
  for (const file of files) {
    const name = starterSkillName(file.path);
    if (!name) continue;
    const group = grouped.get(name) ?? [];
    group.push({ target: file.path, hash: hashContent(file.content) });
    grouped.set(name, group);
  }
  if (grouped.size === 0) return null;

  const lock = parseLockContent(null);
  for (const [name, skillFiles] of grouped) {
    lock.items[name] = {
      type: 'registry:skill',
      source: 'kortix-starter',
      sourceType: 'local',
      files: skillFiles.sort((a, b) => a.target.localeCompare(b.target)),
      installedAt: now,
    };
  }
  return { path: 'registry-lock.json', content: serializeLock(lock) };
}

export async function buildProjectSeedFiles(input: ProjectSeedFilesInput): Promise<{
  files: Array<{ path: string; content: string }>;
  baseFiles: Array<{ path: string; content: string }>;
}> {
  const baseFiles = buildStarterFiles({
    projectName: 'kortix-project',
    repoFullName: 'kortix/kortix-project',
    template: input.template,
  });
  let files = buildStarterFiles({
    projectName: input.projectName,
    repoFullName: input.repoFullName,
    template: input.template,
  });

  const starterLockFile = starterSkillLockFile(files, input.now);
  if (starterLockFile) files = mergeSeedFiles(files, [starterLockFile]);

  if (input.marketplaceItems.length > 0) {
    const marketplace = await buildInstallBatch({
      ids: input.marketplaceItems,
      configDir: '.kortix/opencode',
      existingLockRaw: starterLockFile?.content ?? null,
      legacyLockRaw: null,
      now: input.now,
    });
    files = mergeSeedFiles(files, marketplace.files);
  }

  return { files, baseFiles };
}

export interface ProjectSeedFilesFromItemInput {
  /** Catalog id of a `registry:project` item, e.g. `kortix-projects:support-agent-kit`. */
  id: string;
  projectName: string;
  repoFullName: string;
  extraMarketplaceItems: string[];
  now: string;
}

/** `{{var}}` substitution matching @kortix/starter's own convention (only
 *  `\w+` identifiers, unknown ones left intact). Project-item catalog
 *  content ships with placeholders unresolved (see
 *  `buildProjectTemplateRegistry` in apps/api/src/marketplace/catalog.ts) so
 *  they can be resolved here against the real destination project's name
 *  instead of a generic catalog-display placeholder. */
function interpolateProjectVars(content: string, vars: Record<string, string>): string {
  return content.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
    name in vars ? vars[name]! : match,
  );
}

/**
 * Seed a brand-new project by cloning a `registry:project` marketplace item.
 * The minimal starter gives the new repo its opencode runtime (tools,
 * plugins, opencode.jsonc, base skills) exactly like any other new project;
 * the project item's own files (its kortix.yaml, agent personas, and any
 * `registryDependencies` skills it declares) are resolved via the normal
 * install engine and layered on top, replacing the starter's placeholder
 * kortix.yaml with the source project's real one.
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
  let files = buildStarterFiles({
    projectName: input.projectName,
    repoFullName: input.repoFullName,
    template: 'minimal',
  });

  const built = await buildInstall({
    id: input.id,
    configDir: '.kortix/opencode',
    existingLockRaw: null,
    legacyLockRaw: null,
    now: input.now,
  });
  const vars = { projectName: input.projectName, repoFullName: input.repoFullName };
  const projectFiles = built.files.map((f) => ({
    path: f.path,
    content: interpolateProjectVars(f.content, vars),
  }));
  files = mergeSeedFiles(files, projectFiles);

  if (input.extraMarketplaceItems.length > 0) {
    const extra = await buildInstallBatch({
      ids: input.extraMarketplaceItems,
      configDir: '.kortix/opencode',
      existingLockRaw: projectFiles.find((f) => f.path === 'registry-lock.json')?.content ?? null,
      legacyLockRaw: null,
      now: input.now,
    });
    files = mergeSeedFiles(files, extra.files);
  }

  return { files, baseFiles };
}
