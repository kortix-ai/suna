/**
 * One humanized answer for "this account's GitHub connection no longer works".
 *
 * GitHub answers `POST /app/installations/<id>/access_tokens` with a 404
 * whenever the installation does not belong to the App that signed the JWT —
 * which is what every stored connection looks like after the instance App
 * identity changes, and also what an uninstall looks like. Raw, that reached
 * clients as `GitHub /app/installations/42/access_tokens failed (404): Not
 * Found`, which tells a user nothing they can act on.
 */

export const GITHUB_INSTALLATION_UNREACHABLE = 'github_installation_unreachable';

/**
 * Deliberately STRUCTURAL, not `instanceof GitHubApiError`.
 *
 * Importing that class would add an import edge from every route into
 * `projects/github.ts`, a module a dozen suites replace wholesale with
 * `mock.module` — and `mock.module` deletes every export the factory does not
 * name, so one new edge turns into `SyntaxError: Export named 'X' not found`
 * in files this change never touched (see .claude/skills/learnings/SKILL.md,
 * "A new import edge into a widely-mocked graph…"). Reading the two fields
 * that define the failure also survives two copies of the class, which
 * `instanceof` does not.
 */
export function isGitHubInstallationUnreachable(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: unknown; status?: unknown; path?: unknown };
  return (
    candidate.name === 'GitHubApiError' &&
    candidate.status === 404 &&
    typeof candidate.path === 'string' &&
    candidate.path.includes('/access_tokens')
  );
}

export interface GitHubInstallationUnreachableBody {
  error: typeof GITHUB_INSTALLATION_UNREACHABLE;
  message: string;
  installation_id: string;
  install_url: string | null;
}

export function githubInstallationUnreachableBody(
  installationId: string,
  installUrl: string | null,
): GitHubInstallationUnreachableBody {
  return {
    error: GITHUB_INSTALLATION_UNREACHABLE,
    message: 'This GitHub connection is no longer valid. Reconnect it in Settings → Git.',
    installation_id: installationId,
    install_url: installUrl,
  };
}
