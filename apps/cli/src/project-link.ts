import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

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
interface ProjectLink {
  project_id: string;
  account_id: string;
  /** Named host (from ~/.config/kortix/config.json) this project lives on. */
  host?: string;
  /** Snapshot of the host's URL at link time. Informational. */
  host_url?: string;
  linked_at: string;
}

const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function linkFilePath(cwd = process.cwd()): string {
  return resolve(cwd, '.kortix', 'link.json');
}

export function normalizeProjectId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return PROJECT_ID_RE.test(trimmed) ? trimmed : null;
}

/** Is the cwd plausibly a Kortix project? We require either an existing
 *  `.kortix/` directory (from `kortix init`) or a `kortix.toml` at the
 *  root. Refusing to auto-create `.kortix/` from a random directory
 *  prevents stray folders. */
export function isKortixProject(cwd = process.cwd()): boolean {
  return existsSync(resolve(cwd, '.kortix')) || existsSync(resolve(cwd, 'kortix.toml'));
}

export function loadLink(cwd = process.cwd()): ProjectLink | null {
  const path = linkFilePath(cwd);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ProjectLink>;
    const projectId = normalizeProjectId(parsed.project_id);
    if (!projectId) return null;
    return {
      project_id: projectId,
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
  const projectId = normalizeProjectId(link.project_id);
  if (!projectId) throw new Error('Invalid project id');
  const path = linkFilePath(cwd);
  mkdirSync(dirname(path), { recursive: true });
  // Order keys so the file is human-friendly + diffs predictable.
  const ordered = {
    project_id: projectId,
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
 *   2. KORTIX_PROJECT_ID env
 *   3. .kortix/link.json in cwd
 * Returns null if none of those are set.
 */
export function resolveProjectId(projectArg?: string): string | null {
  if (projectArg !== undefined) return normalizeProjectId(projectArg);
  if (process.env.KORTIX_PROJECT_ID !== undefined) {
    return normalizeProjectId(process.env.KORTIX_PROJECT_ID);
  }
  const link = loadLink();
  return link?.project_id ?? null;
}
