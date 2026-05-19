import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface ProjectLink {
  project_id: string;
  account_id: string;
  linked_at: string;
}

export function linkFilePath(cwd = process.cwd()): string {
  return resolve(cwd, '.kortix', 'link.json');
}

export function loadLink(cwd = process.cwd()): ProjectLink | null {
  const path = linkFilePath(cwd);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ProjectLink>;
    if (typeof parsed.project_id !== 'string' || !parsed.project_id) return null;
    return {
      project_id: parsed.project_id,
      account_id: parsed.account_id ?? '',
      linked_at: parsed.linked_at ?? new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export function saveLink(link: ProjectLink, cwd = process.cwd()): void {
  const path = linkFilePath(cwd);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(link, null, 2) + '\n', 'utf8');
}

export function clearLink(cwd = process.cwd()): void {
  const path = linkFilePath(cwd);
  if (existsSync(path)) rmSync(path, { force: true });
}

/**
 * Resolve which project a CLI command should operate on, in order:
 *   1. --project / projectArg
 *   2. KORTIX_PROJECT_ID env
 *   3. .kortix/link.json in cwd
 * Returns null if none of those are set.
 */
export function resolveProjectId(projectArg?: string): string | null {
  if (projectArg) return projectArg;
  if (process.env.KORTIX_PROJECT_ID) return process.env.KORTIX_PROJECT_ID;
  const link = loadLink();
  return link?.project_id ?? null;
}
