/**
 * The one typed cause for "this create can never work with this credential".
 *
 * GitHub does not accept a GitHub App INSTALLATION token on `POST /user/repos`
 * — the endpoint is absent from its "endpoints available for GitHub App
 * installation access tokens" while `POST /orgs/{org}/repos` is present — so a
 * repository under a personal owner needs a user access token instead. Thrown
 * before the request, so callers map one cause instead of pattern-matching
 * GitHub's 403 text.
 *
 * Its own leaf module, NOT `projects/github.ts`, for the reason
 * `github-installation-errors.ts` records: several suites replace that module
 * wholesale with `mock.module`, and a factory that does not spread the real
 * module deletes every export it does not name — so a new name there turns into
 * `SyntaxError: Export named 'X' not found` in files the change never touched.
 * This module has no imports and is never mocked.
 */
export const GITHUB_PERSONAL_ACCOUNT_CREATE_UNSUPPORTED =
  'github_personal_account_create_unsupported';

export class GitHubPersonalAccountCreateUnsupportedError extends Error {
  readonly code = GITHUB_PERSONAL_ACCOUNT_CREATE_UNSUPPORTED;

  constructor(readonly owner: string) {
    super(
      `GitHub does not let the Kortix app create repositories in the personal account ${owner}. ` +
        'Create the repository on GitHub, then import it.',
    );
    this.name = 'GitHubPersonalAccountCreateUnsupportedError';
  }
}
