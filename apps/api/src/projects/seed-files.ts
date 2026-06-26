import type { StarterTemplateId } from '@kortix/starter';
import { buildInstallBatch } from '../marketplace/install-service';
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

  if (input.marketplaceItems.length > 0) {
    const marketplace = await buildInstallBatch({
      ids: input.marketplaceItems,
      configDir: '.kortix/opencode',
      existingLockRaw: null,
      legacyLockRaw: null,
      now: input.now,
    });
    files = mergeSeedFiles(files, marketplace.files);
  }

  return { files, baseFiles };
}
