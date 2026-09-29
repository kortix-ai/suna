import type { projectGitConnections } from '@kortix/db';
import type { GitHubRepo } from '../github';

/**
 * The one shape of a `project_git_connections` row write.
 *
 * `registerLinkedProject` (project-registration.ts) and
 * `persistProjectRepositoryReplacement` (repository-replacement.ts) both
 * hand-build this row and the `metadata.git`/`metadata.github` blocks, and
 * the two literals had already drifted. These builders are the single
 * implementation of both shapes; the intentional per-path differences are
 * explicit options.
 *
 * `upsertProjectGitConnection` (git.ts) is the canonical writer for the row,
 * but both current call sites write inside their own `db.transaction`, which
 * the pooled `db` handle behind it cannot join — so the call sites keep their
 * transaction-scoped inserts and share these value builders instead.
 */

/** How the project's git connection authenticates. */
export type ProjectGitWriteAuth =
  | {
      kind: 'github_app';
      installationId: string;
      /** GitHub App permissions echoed into the connection row. */
      permissions?: Record<string, unknown> | null;
      /** True for a repository-grant connection (repository replacement). */
      projectGrant?: boolean;
    }
  | { kind: 'project_credential' };

export type ProjectGitConnectionValues = Omit<
  typeof projectGitConnections.$inferInsert,
  'accountId' | 'projectId'
>;

export function buildProjectGitConnectionValues(
  repo: GitHubRepo,
  auth: ProjectGitWriteAuth,
  opts: {
    defaultBranch: string;
    /** Credential row id for a project-credential connection; null otherwise. */
    credentialRef: string | null;
    now: Date;
    /** True when Kortix provisioned the repository. */
    managed?: boolean;
    /** Real upstream host git URL, distinct from the client-facing repoUrl. */
    upstreamUrl?: string | null;
  },
): ProjectGitConnectionValues {
  const { defaultBranch, credentialRef, now, managed, upstreamUrl } = opts;
  const owner = repo.full_name.split('/')[0] ?? null;
  const app = auth.kind === 'github_app' ? auth : null;
  return {
    provider: 'github',
    repoUrl: repo.clone_url,
    upstreamUrl: upstreamUrl ?? null,
    managed: managed ?? false,
    repoOwner: owner,
    repoName: repo.name,
    externalRepoId: String(repo.id),
    defaultBranch,
    authMethod: app ? 'github_app' : 'project_credential',
    installationId: app?.installationId ?? null,
    credentialRef,
    permissions: app ? (app.permissions ?? {}) : {},
    visibility: repo.private ? 'private' : 'public',
    webhookId: null,
    status: 'connected',
    lastValidatedAt: now,
    lastErrorCode: null,
    lastErrorMessage: null,
    metadata: {
      full_name: repo.full_name,
      html_url: repo.html_url,
      ssh_url: repo.ssh_url,
      ...(app?.projectGrant ? { project_grant: true } : {}),
    },
    updatedAt: now,
  };
}

export type ProjectGitMetadataBlock = {
  git: {
    url: string;
    default_branch: string;
    provider: 'github';
    owner: string | null;
    name: string;
    external_repo_id: string;
    managed: boolean;
    auth:
      | { method: 'github_app'; installation_id: string; project_grant?: true }
      | { method: 'project_credential' };
  };
  github: {
    repo_id: string;
    full_name: string;
    html_url: string;
    private: boolean;
    auth_source: 'app_installation' | 'pat';
    installation_id?: string;
  };
};

/**
 * The `metadata.git` / `metadata.github` block both writers store on the
 * project row. `previous` spreads first — the caller's trusted server-owned
 * metadata at registration, the project's current metadata on replacement —
 * so a fresh `repository_generation` stays a caller concern: the replacement
 * adds one AFTER this spread.
 */
export function buildProjectGitMetadata(
  repo: GitHubRepo,
  auth: ProjectGitWriteAuth,
  previous: Record<string, unknown> | null | undefined,
  opts: {
    defaultBranch: string;
    /** True when Kortix provisioned the repository. */
    managed?: boolean;
    /**
     * The legacy `github` block echoes `installation_id` on the registration
     * path only; the replacement path never wrote it. Kept exactly — the
     * drift predates this builder and unifying it would change stored rows.
     */
    githubInstallationId?: boolean;
  },
): ProjectGitMetadataBlock & Record<string, unknown> {
  const { defaultBranch, managed, githubInstallationId } = opts;
  const owner = repo.full_name.split('/')[0] ?? null;
  const app = auth.kind === 'github_app' ? auth : null;
  return {
    ...(previous ?? {}),
    git: {
      url: repo.clone_url,
      default_branch: defaultBranch,
      provider: 'github',
      owner,
      name: repo.name,
      external_repo_id: String(repo.id),
      managed: managed ?? false,
      auth: app
        ? {
            method: 'github_app',
            installation_id: app.installationId,
            ...(app.projectGrant ? { project_grant: true as const } : {}),
          }
        : { method: 'project_credential' },
    },
    github: {
      repo_id: String(repo.id),
      full_name: repo.full_name,
      html_url: repo.html_url,
      private: repo.private,
      auth_source: app ? 'app_installation' : 'pat',
      ...(app && githubInstallationId ? { installation_id: app.installationId } : {}),
    },
  };
}
