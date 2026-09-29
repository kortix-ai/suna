// The ONE canonical shape of the project Git write data. Both
// `registerLinkedProject` (project-registration.ts) and
// `persistProjectRepositoryReplacement` (repository-replacement.ts) hand-built
// these literals and had drifted. The DB writes stay at the call sites: both
// run inside `db.transaction`, and `upsertProjectGitConnection` (lib/git.ts)
// writes on the pooled `db` handle, so it cannot join those transactions.
import type { GitHubRepo } from '../github';

/** App auth carries the installation id it stores + the permissions it records on the row. */
export type ProjectGitWriteAuth =
  | { method: 'github_app'; installationId: string | null; permissions: Record<string, unknown> }
  | { method: 'project_credential' };

/**
 * The `project_git_connections` row values for a GitHub project; the caller
 * prepends `accountId`/`projectId` and runs the insert + onConflictDoUpdate.
 * `upstreamUrl`/`webhookId` reproduce the original shapes exactly: undefined
 * leaves the key out of both the insert and the conflict `set` (registration
 * never wrote them; its conflict branch is unreachable on a fresh project id),
 * replacement passes them so its `set` keeps resetting both columns.
 */
export function buildProjectGitConnectionValues(input: {
  repo: GitHubRepo;
  defaultBranch: string;
  auth: ProjectGitWriteAuth;
  credentialRef: string | null;
  /** True when Kortix provisioned the repo. */
  managed: boolean;
  upstreamUrl?: string | null;
  webhookId?: string | null;
  /** Replacement's App grant stamps the row metadata with it. */
  projectGrant: boolean;
  now: Date;
}) {
  const owner = input.repo.full_name.split('/')[0] ?? null;
  const app = input.auth.method === 'github_app' ? input.auth : null;
  return {
    provider: 'github',
    repoUrl: input.repo.clone_url,
    ...(input.upstreamUrl !== undefined ? { upstreamUrl: input.upstreamUrl } : {}),
    managed: input.managed,
    repoOwner: owner,
    repoName: input.repo.name,
    externalRepoId: String(input.repo.id),
    defaultBranch: input.defaultBranch,
    authMethod: app ? 'github_app' : 'project_credential',
    installationId: app?.installationId ?? null,
    credentialRef: input.credentialRef,
    permissions: app?.permissions ?? {},
    visibility: input.repo.private ? 'private' : 'public',
    ...(input.webhookId !== undefined ? { webhookId: input.webhookId } : {}),
    status: 'connected',
    lastValidatedAt: input.now,
    lastErrorCode: null,
    lastErrorMessage: null,
    metadata: {
      full_name: input.repo.full_name,
      html_url: input.repo.html_url,
      ssh_url: input.repo.ssh_url,
      ...(input.projectGrant ? { project_grant: true } : {}),
    },
    updatedAt: input.now,
  };
}

/**
 * The `metadata.git` / `metadata.github` blocks; the caller spreads its own
 * prior metadata beneath them. `githubInstallationId` is preserved drift:
 * registration records the legacy `github.installation_id` slot, replacement
 * never rewrites it — so replacement passes nothing.
 */
export function buildProjectGitMetadata(input: {
  repo: GitHubRepo;
  defaultBranch: string;
  auth: ProjectGitWriteAuth;
  /** True when Kortix provisioned the repo. */
  managed: boolean;
  /** Replacement's App grant stamps `git.auth` with it. */
  projectGrant: boolean;
  githubInstallationId?: string | null;
}) {
  const owner = input.repo.full_name.split('/')[0] ?? null;
  const app = input.auth.method === 'github_app' ? input.auth : null;
  return {
    git: {
      url: input.repo.clone_url,
      default_branch: input.defaultBranch,
      provider: 'github',
      owner,
      name: input.repo.name,
      external_repo_id: String(input.repo.id),
      managed: input.managed,
      auth: app
        ? { method: 'github_app', installation_id: app.installationId, ...(input.projectGrant ? { project_grant: true } : {}) }
        : { method: 'project_credential' },
    },
    github: {
      repo_id: String(input.repo.id),
      full_name: input.repo.full_name,
      html_url: input.repo.html_url,
      private: input.repo.private,
      auth_source: app ? 'app_installation' : 'pat',
      ...(app && input.githubInstallationId ? { installation_id: input.githubInstallationId } : {}),
    },
  };
}
