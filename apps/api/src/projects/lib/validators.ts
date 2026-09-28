export function normalizeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function normalizeBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return null;
}

export function normalizeRepoUrl(value: unknown): string | null {
  const repoUrl = normalizeString(value);
  if (!repoUrl) return null;
  const normalized = repoUrl.replace(/\/+$/, '');
  if (/^http:\/\//i.test(normalized)) {
    throw new Error('repo_url must use HTTPS or git@github.com SSH');
  }
  if (!parseGitHubRepoUrl(normalized)) {
    throw new Error('repo_url must be a GitHub repository URL');
  }
  return normalized;
}

export function hasOwn(body: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key);
}

export function deriveKortixApiRoot(kortixUrl: string): string {
  return (kortixUrl || 'https://api.kortix.com')
    .replace(/\/+$/, '')
    .replace(/\/v1\/router$/, '')
    .replace(/\/v1$/, '');
}

// Display cap for user-supplied project names. Well under the projects.name
// varchar(255) column so every write path (provision, GitHub link, PAT link)
// fits the schema even after a linked repo's derived name is substituted.
export const PROJECT_NAME_MAX_LENGTH = 120;

export function clampProjectName(name: string): string {
  return name.length > PROJECT_NAME_MAX_LENGTH
    ? name.slice(0, PROJECT_NAME_MAX_LENGTH).trimEnd()
    : name;
}

export function deriveProjectName(repoUrl: string): string {
  const cleaned = repoUrl.replace(/\/+$/, '').replace(/\.git$/, '');
  const tail = cleaned.split(/[/:]/).filter(Boolean).pop();
  if (!tail) return 'Untitled Project';
  return tail.replace(/[-_]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

const PROJECT_ROLES = ['manager', 'member'] as const;

export type ProjectGroupGrantRole = (typeof PROJECT_ROLES)[number];

export function isProjectRole(v: unknown): v is ProjectGroupGrantRole {
  return typeof v === 'string' && (PROJECT_ROLES as readonly string[]).includes(v);
}

/**
 * Parse a bounded positive integer query parameter, or report why it is invalid.
 * Shared by every paged read route (transcript, voice transcript, approvals).
 */
export function parseBoundedPositiveInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  label: string,
): { ok: true; value: number } | { ok: false; error: string } {
  if (raw === undefined || raw === '') return { ok: true, value: fallback };
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    return { ok: false, error: `${label} must be an integer between ${min} and ${max}` };
  }
  return { ok: true, value };
}

export function parseGitHubRepoUrl(repoUrl: string): { owner: string; repo: string } | null {
  // Accept https://github.com/owner/repo(.git) and git@github.com:owner/repo(.git).
  const m =
    repoUrl.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i) ??
    repoUrl.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (!m) return null;
  // biome-ignore lint/style/noNonNullAssertion: Matched capture groups are required by both patterns.
  return { owner: m[1]!, repo: m[2]! };
}
