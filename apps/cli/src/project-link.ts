import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { defaultProject } from './api/config.ts';
import { sandboxEnvValue } from './api/sandbox-env.ts';

/**
 * `.kortix/link.json` — the per-repo binding between a working
 * directory and a Kortix cloud project.
 *
 * Lives inside `.kortix/` (alongside `Dockerfile` + `opencode/`), so
 * the link travels with the branch when teammates clone the repo —
 * they don't have to re-link. Also stores which host the project
 * belongs to so commands always hit the right Kortix instance even if
 * the user's globally-active host is a different one.
 */
export interface ProjectLink {
  project_id: string;
  account_id: string;
  /** Named host (from ~/.config/kortix/config.json) this project lives on. */
  host?: string;
  /** Snapshot of the host's URL at link time. Informational. */
  host_url?: string;
  linked_at: string;
}

export function linkFilePath(cwd = process.cwd()): string {
  return resolve(cwd, '.kortix', 'link.json');
}

/** Is the cwd plausibly a Kortix project? We require either an existing
 *  `.kortix/` directory (from `kortix init`) or a manifest (`kortix.toml`
 *  or `kortix.yaml`) at the root. Refusing to auto-create `.kortix/` from a
 *  random directory prevents stray folders. */
export function isKortixProject(cwd = process.cwd()): boolean {
  return (
    existsSync(resolve(cwd, '.kortix')) ||
    existsSync(resolve(cwd, 'kortix.toml')) ||
    existsSync(resolve(cwd, 'kortix.yaml')) ||
    existsSync(resolve(cwd, 'kortix.yml'))
  );
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
      host: typeof parsed.host === 'string' && parsed.host ? parsed.host : undefined,
      host_url:
        typeof parsed.host_url === 'string' && parsed.host_url ? parsed.host_url : undefined,
      linked_at: parsed.linked_at ?? new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export function saveLink(link: ProjectLink, cwd = process.cwd()): void {
  const path = linkFilePath(cwd);
  mkdirSync(dirname(path), { recursive: true });
  // Order keys so the file is human-friendly + diffs predictable.
  const ordered = {
    project_id: link.project_id,
    account_id: link.account_id,
    host: link.host,
    host_url: link.host_url,
    linked_at: link.linked_at,
  };
  writeFileSync(path, JSON.stringify(ordered, null, 2) + '\n', 'utf8');
}

export function clearLink(cwd = process.cwd()): void {
  const path = linkFilePath(cwd);
  if (existsSync(path)) rmSync(path, { force: true });
}

/**
 * Resolve which project a CLI command should operate on, in order:
 *   1. --project / projectArg
 *   2. KORTIX_PROJECT_ID env (platform-injected inside a sandbox)
 *   3. .kortix/link.json in cwd (per-repo binding)
 *   4. the active host's global default project (`kortix projects use`)
 * Returns null if none of those are set.
 */
export function resolveProjectId(projectArg?: string): string | null {
  return resolveProjectRef(projectArg)?.projectId ?? null;
}

/** Where a resolved project came from. `link` and `default` are the CLI
 *  config's own principal (a logged-in host and its project); `env` is the
 *  platform-injected sandbox pair. The two must never be mixed — see the
 *  one-principal guard in resolveProjectContext. */
export type ProjectSource = 'flag' | 'env' | 'link' | 'default';

export interface ProjectRef {
  projectId: string;
  source: ProjectSource;
}

/**
 * resolveProjectId with the winning source attached.
 *
 * `preferConfigured` flips env and the configured side for callers whose
 * project IS the user's explicit configuration (the change-request commands):
 * link.json → the active host's default project → the ambient sandbox pair.
 * When the configured side names the same project the env pair already
 * carries, the env source is kept — the ambient session token is a valid
 * credential for its own project.
 */
export function resolveProjectRef(
  projectArg?: string,
  opts?: { preferConfigured?: boolean },
): ProjectRef | null {
  if (projectArg) return { projectId: projectArg, source: 'flag' };
  const envProjectId = sandboxEnvValue('KORTIX_PROJECT_ID');
  const link = loadLink();
  const defaultRef = defaultProject();
  const configured: ProjectRef | null = link?.project_id
    ? { projectId: link.project_id, source: 'link' }
    : defaultRef?.project_id
      ? { projectId: defaultRef.project_id, source: 'default' }
      : null;
  const env: ProjectRef | null = envProjectId ? { projectId: envProjectId, source: 'env' } : null;
  if (opts?.preferConfigured) {
    const chosen = configured ?? env;
    if (chosen && env && chosen.projectId === env.projectId) return env;
    return chosen;
  }
  return env ?? configured;
}
