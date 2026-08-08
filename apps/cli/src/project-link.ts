import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { defaultWorkspace } from './api/config.ts';
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
  /** Canonical Workspace identifier. */
  workspace_id: string;
  /** @deprecated Compatibility alias for `workspace_id`. */
  project_id: string;
  account_id: string;
  /** Named host (from ~/.config/kortix/config.json) this project lives on. */
  host?: string;
  /** Snapshot of the host's URL at link time. Informational. */
  host_url?: string;
  linked_at: string;
}

export type ProjectLinkInput = Omit<ProjectLink, 'workspace_id' | 'project_id'> & {
  workspace_id?: string;
  project_id?: string;
};

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
    const workspaceId =
      typeof parsed.workspace_id === 'string' && parsed.workspace_id
        ? parsed.workspace_id
        : typeof parsed.project_id === 'string' && parsed.project_id
          ? parsed.project_id
          : null;
    if (!workspaceId) return null;
    return {
      workspace_id: workspaceId,
      project_id: workspaceId,
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

export function saveLink(link: ProjectLinkInput, cwd = process.cwd()): void {
  const workspaceId = link.workspace_id ?? link.project_id;
  if (!workspaceId) throw new Error('workspace_id is required');
  const path = linkFilePath(cwd);
  mkdirSync(dirname(path), { recursive: true });
  // Order keys so the file is human-friendly + diffs predictable.
  const ordered = {
    workspace_id: workspaceId,
    // Deprecated compatibility alias for installed CLIs and external tooling.
    project_id: workspaceId,
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
 *   2. KORTIX_WORKSPACE_ID env (canonical platform-injected value)
 *   3. KORTIX_PROJECT_ID env (deprecated compatibility value)
 *   4. .kortix/link.json in cwd (per-repo binding)
 *   5. the active host's global default workspace (`kortix workspaces use`)
 * Returns null if none of those are set.
 */
export function resolveProjectId(projectArg?: string): string | null {
  if (projectArg) return projectArg;
  const envProjectId =
    sandboxEnvValue('KORTIX_WORKSPACE_ID') ?? sandboxEnvValue('KORTIX_PROJECT_ID');
  if (envProjectId) return envProjectId;
  const link = loadLink();
  if (link?.workspace_id) return link.workspace_id;
  return defaultWorkspace()?.workspace_id ?? null;
}

export const resolveWorkspaceId = resolveProjectId;
export const isKortixWorkspace = isKortixProject;
