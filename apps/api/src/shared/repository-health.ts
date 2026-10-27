/**
 * One root-cause state for "Kortix can no longer reach this project's GitHub
 * repository" (KRTX-2955).
 *
 * When a GitHub org uninstalls the Kortix App, suspends it, or drops the repo
 * from its repository selection, every installation-token mint for the project
 * fails. Before this module each surface reported its own symptom: a manifest
 * read became `unknown_reason: unreadable`, a session start became "machine
 * could not be reached" or "agent not declared", the git proxy forwarded a
 * credential-less request and GitHub answered `Repository not found`, and the
 * API logged one warning per request.
 *
 * Now the mint failure is classified once, stored on the project's git
 * connection (see {@link GitHealth}), and thrown as {@link RepositoryDisconnectedError},
 * which `http-errors.ts` answers as 409 `repository_disconnected` on every route.
 *
 * Structural, no import of `projects/github.ts` (see github-installation-errors.ts
 * for why: suites replace that module wholesale with `mock.module`).
 */

export const REPOSITORY_DISCONNECTED_CODE = 'repository_disconnected';

export type RepositoryDisconnectedReason = 'app_uninstalled' | 'app_suspended' | 'repo_not_accessible';

const REASONS: ReadonlySet<string> = new Set<RepositoryDisconnectedReason>([
  'app_uninstalled',
  'app_suspended',
  'repo_not_accessible',
]);

/**
 * While disconnected, GitHub is asked again at most once per interval per
 * project. A fix on GitHub's side (reinstall, re-grant) is therefore seen
 * within 5 minutes; reconnecting through Kortix clears the state at once.
 */
export const PROBE_INTERVAL_MS = 5 * 60_000;

/**
 * Classify a failed `POST /app/installations/<id>/access_tokens`.
 *
 * GitHub's answers on that endpoint: 404 = the installation does not exist for
 * this App (uninstalled, or the App identity changed); 403 "suspended" = an org
 * owner suspended it; 422 = the repo-scoped token names a repository the
 * installation cannot see (deleted, renamed, or removed from the selection — an
 * installation token cannot tell those apart). 5xx/429/network are transient
 * and never flip the state. Everything else (401 = our JWT, 403 permission) is
 * a server-side problem that a reinstall does not fix.
 */
export function classifyInstallationTokenError(
  error: unknown,
): RepositoryDisconnectedReason | 'transient' | 'other' {
  const e = (error ?? {}) as { name?: unknown; status?: unknown; path?: unknown; message?: unknown };
  if (e.name !== 'GitHubApiError' || typeof e.status !== 'number') return 'transient';
  if (e.status >= 500 || e.status === 429) return 'transient';
  if (typeof e.path !== 'string' || !e.path.includes('/access_tokens')) return 'other';
  if (e.status === 404) return 'app_uninstalled';
  if (e.status === 422) return 'repo_not_accessible';
  if (e.status === 403 && typeof e.message === 'string' && /suspended/i.test(e.message)) return 'app_suspended';
  return 'other';
}

/**
 * The stored state lives on the existing `project_git_connections` columns:
 * `status = 'error'`, `last_error_code = <reason>`, `last_error_message`, and
 * `last_validated_at` = when GitHub was last asked. Any other combination is
 * healthy. The web Git settings already render `status` and
 * `last_error_message`.
 */
export interface GitHealth {
  reason: RepositoryDisconnectedReason;
  installationId: string | null;
  checkedAt: Date;
}

export function readGitHealth(
  connection: { status?: string | null; lastErrorCode?: string | null; lastValidatedAt?: Date | null; installationId?: string | null } | null | undefined,
): GitHealth | null {
  if (!connection || connection.status !== 'error') return null;
  const reason = connection.lastErrorCode;
  if (!reason || !REASONS.has(reason) || !connection.lastValidatedAt) return null;
  return {
    reason: reason as RepositoryDisconnectedReason,
    installationId: connection.installationId ?? null,
    checkedAt: connection.lastValidatedAt,
  };
}

export function shouldProbeRepository(health: GitHealth | null, nowMs: number): boolean {
  if (!health) return true;
  return nowMs - health.checkedAt.getTime() >= PROBE_INTERVAL_MS;
}

export function repositoryDisconnectedMessage(reason: RepositoryDisconnectedReason, repository: string): string {
  const owner = repository.split('/')[0] || repository;
  switch (reason) {
    case 'app_uninstalled':
      return `Kortix cannot reach ${repository}: the Kortix GitHub App was uninstalled from ${owner}. A GitHub owner of ${owner} must reinstall it: Project settings → Git → Reconnect GitHub.`;
    case 'app_suspended':
      return `Kortix cannot reach ${repository}: the Kortix GitHub App is suspended on ${owner}. A GitHub owner of ${owner} must unsuspend it in GitHub → Settings → GitHub Apps.`;
    case 'repo_not_accessible':
      return `Kortix cannot reach ${repository}: the repository was deleted, renamed, or removed from the Kortix GitHub App. A GitHub owner of ${owner} must add it again under GitHub → Settings → GitHub Apps → Kortix → Repository access, or reconnect it in Project settings → Git.`;
  }
}

export class RepositoryDisconnectedError extends Error {
  readonly code = REPOSITORY_DISCONNECTED_CODE;
  readonly status = 409;
  readonly reason: RepositoryDisconnectedReason;
  readonly repository: string;
  readonly installationId: string | null;

  constructor(input: { reason: RepositoryDisconnectedReason; repository: string; installationId: string | null }) {
    super(repositoryDisconnectedMessage(input.reason, input.repository));
    this.name = 'RepositoryDisconnectedError';
    this.reason = input.reason;
    this.repository = input.repository;
    this.installationId = input.installationId;
  }
}

export function isRepositoryDisconnectedError(error: unknown): error is RepositoryDisconnectedError {
  const e = error as { name?: unknown; code?: unknown } | null;
  return !!e && e.name === 'RepositoryDisconnectedError' && e.code === REPOSITORY_DISCONNECTED_CODE;
}

/** The 409 body every route answers. `error` is the message clients print. */
export function repositoryDisconnectedBody(error: RepositoryDisconnectedError, installUrl: string | null = null) {
  return {
    error: error.message,
    code: REPOSITORY_DISCONNECTED_CODE,
    reason: error.reason,
    repository: error.repository,
    installation_id: error.installationId,
    install_url: installUrl,
  };
}
