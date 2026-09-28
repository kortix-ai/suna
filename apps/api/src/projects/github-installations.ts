import type { GitHubInstallationToken, GitHubAppInstallation, GitHubOrganizationMembership } from "./github-installation-types";
import { createInstallationTokenCache } from "./github-installation-token-cache";
const installationTokens = createInstallationTokenCache();
import { createGitHubAppJwt, githubAppId, resolveGitHubAppPermissions } from "./github-app";
import { GitHubApiError, GitHubAppPermissionError, GitHubIpAllowListError, GitHubSamlSsoError, ghFetch, ghFetchAllPages, isGitHubIpAllowListRefusal } from "./github-http";
export async function getGitHubAppInstallation(installationId: string): Promise<GitHubAppInstallation> {
  const id = installationId.trim();
  if (!id) throw new Error('installation_id is required');
  return ghFetch<GitHubAppInstallation>(
    `/app/installations/${encodeURIComponent(id)}`,
    { method: 'GET' },
    { token: createGitHubAppJwt() },
  );
}

/**
 * The GitHub login a user access token authorizes, or a throw. One call, used
 * to verify a token before it is stored and to record whose it is — a token
 * must never be kept without knowing which account it can act as.
 */
export async function resolveGitHubUserLogin(userToken: string): Promise<string> {
  const token = userToken.trim();
  if (!token) throw new Error('GitHub authorization is required');

  let user: { login?: string };
  try {
    user = await ghFetch<{ login?: string }>('/user', { method: 'GET' }, { token });
  } catch {
    throw new Error('GitHub user authorization is invalid or expired');
  }

  const login = user.login?.trim();
  if (!login) throw new Error('GitHub did not return the authorized user login');
  return login;
}

export async function listLinkableGitHubAppInstallations(
  userToken: string,
): Promise<{ githubLogin: string; installations: GitHubAppInstallation[] }> {
  const token = userToken.trim();
  if (!token) throw new Error('GitHub authorization is required to list installations');

  let user: { login?: string };
  try {
    user = await ghFetch<{ login?: string }>('/user', { method: 'GET' }, { token });
  } catch {
    throw new Error('GitHub user authorization is invalid or expired');
  }

  const githubLogin = user.login?.trim();
  if (!githubLogin) throw new Error('GitHub did not return the authorized user login');

  const appInstallations = await ghFetchAllPages<GitHubAppInstallation>('/app/installations', {
    token: createGitHubAppJwt(),
  });

  let memberships: GitHubOrganizationMembership[] = [];
  try {
    memberships = await ghFetchAllPages<GitHubOrganizationMembership>(
      '/user/memberships/orgs?state=active',
      { token },
    );
  } catch (error) {
    if (!(error instanceof GitHubApiError) || error.status !== 403) throw error;
    // Organization installations drop out of the list below. Say why once:
    // `resolveGitHubAppPermissions()` logs a missing `members` permission.
    const app = await resolveGitHubAppPermissions();
    console.warn(
      `[github-app] GET /user/memberships/orgs returned 403 for ${githubLogin}; ` +
        `organization installations are omitted (App missing: ${app.missing.join(', ') || 'none'})`,
    );
  }

  const adminOrganizations = new Set(
    memberships
      .filter((membership) => membership.state === 'active' && membership.role === 'admin')
      .map((membership) => membership.organization?.login?.trim().toLowerCase())
      .filter((login): login is string => Boolean(login)),
  );
  const normalizedLogin = githubLogin.toLowerCase();
  const installations = appInstallations.filter((installation) => {
    const ownerLogin = installation.account?.login?.trim().toLowerCase();
    if (!ownerLogin) return false;
    const ownerType = installation.account?.type ?? installation.target_type;
    if (ownerType === 'User') return ownerLogin === normalizedLogin;
    return adminOrganizations.has(ownerLogin);
  });

  return { githubLogin, installations };
}

/**
 * Status for a failed `verifyGitHubInstallationAdmin`. An App without the
 * permission is an instance fault (502, same as the other upstream-GitHub
 * failures on these routes); everything else is the caller's access (403).
 */
export function githubVerificationStatus(error: unknown): 403 | 502 {
  return error instanceof GitHubAppPermissionError && error.scope === 'app' ? 502 : 403;
}

async function membersPermissionError(
  installation: GitHubAppInstallation,
): Promise<GitHubAppPermissionError> {
  const owner = installation.account?.login?.trim() ?? 'this organization';
  const app = await resolveGitHubAppPermissions();
  if (app.missing.includes('members')) {
    console.error(
      `[github-app] cannot verify organization installation ${installation.id} (${owner}): ` +
        'the App has no "Members: read" organization permission',
    );
    return new GitHubAppPermissionError(
      'This Kortix instance cannot verify GitHub organizations: its GitHub App is missing the ' +
        '"Members: read" organization permission. Your GitHub role is not the cause. ' +
        'Contact the instance operator.',
      'app',
      ['members'],
    );
  }
  const where = installation.html_url ? ` at ${installation.html_url}` : ' in its GitHub App settings';
  return new GitHubAppPermissionError(
    `${owner} has not granted the Kortix GitHub App the "Members: read" permission. ` +
      `An owner of ${owner} must accept the updated permissions${where}, then verify again.`,
    'installation',
    ['members'],
  );
}

export async function verifyGitHubInstallationAdmin(
  userToken: string,
  installation: GitHubAppInstallation,
): Promise<{ login: string }> {
  const token = userToken.trim();
  if (!token) throw new Error('GitHub authorization is required to link this installation');

  const ownerLogin = installation.account?.login?.trim();
  if (!ownerLogin) throw new Error('GitHub installation did not include an owner account');

  let user: { login?: string };
  try {
    user = await ghFetch<{ login?: string }>('/user', { method: 'GET' }, { token });
  } catch {
    throw new Error('GitHub user authorization is invalid or expired');
  }

  const login = user.login?.trim();
  if (!login) throw new Error('GitHub did not return the authorized user login');

  const ownerType = installation.account?.type ?? installation.target_type;
  if (ownerType === 'User') {
    if (login.toLowerCase() !== ownerLogin.toLowerCase()) {
      throw new Error('The authorized GitHub user does not own this installation');
    }
    return { login };
  }

  // `GET /app/installations/{id}` reports what THIS installation was granted.
  // Without `members`, GitHub answers 403 below for an organization owner too.
  if (installation.permissions && !installation.permissions.members) {
    throw await membersPermissionError(installation);
  }

  let membership: { state?: string; role?: string };
  try {
    membership = await ghFetch<{ state?: string; role?: string }>(
      `/orgs/${encodeURIComponent(ownerLogin)}/memberships/${encodeURIComponent(login)}`,
      { method: 'GET' },
      { token },
    );
  } catch (error) {
    if (isGitHubIpAllowListRefusal(error)) throw new GitHubIpAllowListError(ownerLogin);
    if (error instanceof GitHubApiError && error.status === 403 && /SAML/i.test(error.message)) {
      throw new GitHubSamlSsoError(ownerLogin);
    }
    if (
      error instanceof GitHubApiError &&
      error.status === 403 &&
      error.message.includes('Resource not accessible by integration')
    ) {
      throw await membersPermissionError(installation);
    }
    throw new Error('GitHub organization admin access is required to link this installation');
  }

  if (membership.state !== 'active' || membership.role !== 'admin') {
    throw new Error('GitHub organization admin access is required to link this installation');
  }
  return { login };
}

export async function createInstallationToken(
  installationId: string,
  /**
   * When provided, the minted token is scoped to ONLY these repos (by name,
   * within the installation's owner). Used for managed repos so a project's
   * sandbox gets a least-privilege token that can touch its own repo and no
   * other repo under the managed org.
   */
  repositories?: string[],
): Promise<GitHubInstallationToken> {
  const id = installationId.trim();
  if (!id) throw new Error('installation_id is required');
  const scoped = (repositories ?? []).map((r) => r.trim()).filter(Boolean);
  // Keyed by App id too: a stored installation minted under a previous App
  // identity must not be answered from the new identity's cache.
  return installationTokens.get(githubAppId()?.trim() ?? '', id, scoped, (installId, repos) =>
    ghFetch<GitHubInstallationToken>(
      `/app/installations/${encodeURIComponent(installId)}/access_tokens`,
      {
        method: 'POST',
        ...(repos.length ? { body: JSON.stringify({ repositories: repos }) } : {}),
      },
      { token: createGitHubAppJwt() },
    ),
  );
}
