/**
 * One popup, one retry: creating a repository inside a PERSONAL GitHub account.
 *
 * GitHub refuses `POST /user/repos` for a GitHub App installation token and
 * accepts a user access token, so `POST /projects/create-repo` answers `409
 * github_user_authorization_required` when it holds no usable token for the
 * caller. That is an ASK, not a failure: authorize, store the token, and send
 * the same create again. An organization never reaches this path — its
 * installation token can create the repository by itself.
 *
 * Injected dependencies, so the decision is testable without a window or a
 * request.
 */

import type { CreateProjectRepoInput, KortixProject } from '@kortix/sdk';

export const GITHUB_USER_AUTHORIZATION_REQUIRED = 'github_user_authorization_required';

export interface GitHubAuthorizationDeps {
  create: (payload: CreateProjectRepoInput) => Promise<KortixProject>;
  /** Opens the GitHub authorization popup and resolves the user token. */
  requestProof: () => Promise<string>;
  storeToken: (input: {
    account_id: string;
    github_user_token: string;
  }) => Promise<{ ok: true; github_login: string }>;
}

function needsUserAuthorization(error: unknown): boolean {
  return (error as { code?: string } | null | undefined)?.code === GITHUB_USER_AUTHORIZATION_REQUIRED;
}

export async function createRepoWithGitHubAuthorization(
  payload: CreateProjectRepoInput,
  deps: GitHubAuthorizationDeps,
): Promise<KortixProject> {
  try {
    return await deps.create(payload);
  } catch (error) {
    if (!needsUserAuthorization(error)) throw error;

    // The popup's own failure is the one to report: "GitHub verification was
    // cancelled" tells the user what happened; the server's 409 does not.
    const token = await deps.requestProof();
    await deps.storeToken({
      account_id: payload.account_id as string,
      github_user_token: token,
    });

    // Exactly one retry, with the SAME payload — a second name would create a
    // different repository. If the server still has no token after a store that
    // reported success, asking again cannot help, so that 409 is raised.
    return await deps.create(payload);
  }
}
