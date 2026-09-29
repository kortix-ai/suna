/**
 * The ONE canonical shape of the project Git write data.
 *
 * `registerLinkedProject` (project-registration.ts) and
 * `persistProjectRepositoryReplacement` (repository-replacement.ts) used to
 * hand-build the same `project_git_connections` values and the same
 * `metadata.git` / `metadata.github` blocks, and the two literals had already
 * drifted (`project_grant`, `upstream_url`, the legacy `github.installation_id`
 * slot). Both now build through the builders here, and the intentional
 * differences are explicit options instead of copy-paste divergences.
 *
 * The DB writes stay at the call sites: both run inside `db.transaction`, and
 * `upsertProjectGitConnection` (projects/lib/git.ts) writes on the pooled
 * `db` handle, so it cannot join those transactions.
 */
import type { GitHubRepo } from '../github';

/**
 * The auth both write paths resolve before persisting. App auth carries the
 * installation id it will store and the permissions it records on the row;
 * a PAT project stores a project credential row instead.
 */
export type ProjectGitWriteAuth =
  | { method: 'github_app'; installationId: string | null; permissions: Record<string, unknown> }
  | { method: 'project_credential' };

/**
 * The `project_git_connections` row values for a GitHub project. The caller
 * prepends `accountId`/`projectId` and runs the insert + onConflictDoUpdate
 * inside its transaction.
 *
 * `upstreamUrl` and `webhookId` reproduce each call site's original shape
 * exactly: LEFT OUT (undefined) the keys stay out of both the insert and the
 * conflict `set` (registration never wrote them — the columns are nullable
 * with no default, and its conflict branch is unreachable on a fresh project
 * id). Replacement passes them, so its `set` keeps resetting both columns.
 */
export function buildProjectGitConnectionValues(input: {
  repo: GitHubRepo;
  defaultBranch: string;
  auth: ProjectGitWriteAuth;
  /** Credential row id for a PAT project; null for App auth. */
  credentialRef: string | null;
  /** True when Kortix provisioned the repo (the create-repo flow). */
  managed: boolean;
  /** Real upstream host git URL; undefined leaves the key out (registration). */
  upstreamUrl?: string | null;
  /** Webhook id; undefined leaves the key out (registration never wrote it). */
  webhookId?: string | null;
  /** Repository replacement's App grant stamps the row metadata with it. */
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
 * The `metadata.git` / `metadata.github` blocks of a GitHub project. The
 * caller spreads its own prior metadata beneath them.
 */
export function buildProjectGitMetadata(input: {
  repo: GitHubRepo;
  defaultBranch: string;
  auth: ProjectGitWriteAuth;
  /** True when Kortix provisioned the repo (the create-repo flow). */
  managed: boolean;
  /** Repository replacement's App grant stamps `git.auth` with it. */
  projectGrant: boolean;
  /**
   * Legacy `github.installation_id` slot. Registration records it for an App
   * connection; repository replacement never rewrites the slot, so it passes
   * nothing — the shapes stay exactly as they were before the dedupe.
   */
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
