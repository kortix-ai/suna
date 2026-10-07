/**
 * Memory repos: each project's memory, and each person's, kept in its own git
 * repository that follows the Agent Memory Repo spec.
 *
 * - `company`: the project's shared memory, one repo per project.
 * - `user`: the personal memory of one person in one account. A session only
 *   ever reaches the repo of the user it belongs to.
 *
 * Both live in the managed git org, are created on first use, and are reached
 * through this proxy at `/v1/git/<projectId>/memory/<company|user>.git` with the
 * session's own Kortix token, exactly like the project repo (git-proxy/index.ts). The repo names are
 * derived from ids, so no table records them. Pushes go straight to `main`:
 * memory is written by agents with no human in the loop.
 */
import { config } from '../../config';
import { resolveGitBackend } from '../../platform/services/managed-git-backend';
import { deriveKortixApiRoot } from './serializers';

export const MEMORY_REPO_KINDS = ['company', 'user'] as const;
export type MemoryRepoKind = (typeof MEMORY_REPO_KINDS)[number];

export function parseMemoryRepoKind(raw: string): MemoryRepoKind | null {
  const kind = raw.replace(/\.git$/, '');
  return (MEMORY_REPO_KINDS as readonly string[]).includes(kind) ? (kind as MemoryRepoKind) : null;
}

/**
 * The managed repo a memory request reaches, or null when the caller has no
 * such repo. A user repo needs a caller that is a person (a session acts for
 * the user who started it); an API key carries no user and has none.
 */
export function memoryRepoName(
  kind: MemoryRepoKind,
  project: { projectId: string; accountId: string },
  principal: { kind: string; userId?: string | null },
): string | null {
  if (kind === 'company') return `memory-${project.projectId}`;
  const userId = principal.kind === 'session' || principal.kind === 'user' ? principal.userId : null;
  return userId ? `memory-${project.accountId}-${userId}` : null;
}

export function memoryGitUrl(projectId: string, kind: MemoryRepoKind): string {
  return `${deriveKortixApiRoot(config.KORTIX_URL)}/v1/git/${projectId}/memory/${kind}.git`;
}

/**
 * `KORTIX_MEMORY_REPOS` for a session: the company repo, plus the personal repo
 * of the user who started it. Empty (the daemon then keeps the project's
 * in-repo `memory/` folder) when the deployment has no managed git backend, or
 * the session gets no repository access.
 */
export function buildMemoryReposEnv(input: {
  projectId: string;
  userId: string | null | undefined;
  repositoryAccess: boolean;
}): Record<string, string> {
  if (!input.repositoryAccess || !resolveGitBackend()) return {};
  const repos: Array<{ name: string; url: string; label: string }> = [
    {
      name: 'company',
      url: memoryGitUrl(input.projectId, 'company'),
      label: 'company memory, shared by everyone in this project',
    },
  ];
  if (input.userId) {
    repos.push({
      name: `user-${input.userId.slice(0, 8).toLowerCase()}`,
      url: memoryGitUrl(input.projectId, 'user'),
      label: 'personal memory of the user who started this session; only their sessions load it',
    });
  }
  return { KORTIX_MEMORY_REPOS: JSON.stringify(repos) };
}
