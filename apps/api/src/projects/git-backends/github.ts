import { managedGithubAppConfig } from '../../platform/services/managed-github-app';
import {
  type GitHubAuthContext,
  addCollaborator,
  createInstallationToken,
  createRepo as ghCreateRepo,
  deleteRepo as ghDeleteRepo,
  isGithubAppConfigured,
  isOrgAccount,
} from '../github';
import { seedRepoViaGitPush } from './seed';
import {
  type GitConnectionRef,
  type GitHostBackend,
  type GitScope,
  type InviteResult,
  type ProvisionInput,
  type ProvisionedRepo,
  type SeedFile,
  type UpstreamGit,
  basicAuthHeader,
} from './types';

// DB-first, env-fallback — see projects/github.ts for the matching App
// creds accessors. The in-app self-host setup flow (platform/routes/
// github-app.ts) stores `owner`/`installationId` here once an admin installs
// the App; until then this resolves to the existing env vars unchanged.
export function managedGithubOwner(): string | null {
  const dbConfig = managedGithubAppConfig();
  // PAT owner first (a self-host admin who just switched to a PAT should see
  // its owner take effect immediately, ahead of any stale App-installation
  // owner still sitting in the same row), then the App-installation owner,
  // then the env fallback (covers both the App-via-env and PAT-via-env cases).
  return (
    dbConfig.patOwner?.trim() ||
    dbConfig.owner?.trim() ||
    process.env.MANAGED_GIT_GITHUB_OWNER?.trim() ||
    null
  );
}

export function managedGithubInstallId(): string | null {
  return (
    managedGithubAppConfig().installationId?.trim() ||
    process.env.MANAGED_GIT_GITHUB_INSTALL_ID?.trim() ||
    null
  );
}

/**
 * The stored account type for the App-installation owner (install-callback
 * records `account.type` straight off the installation payload — see
 * platform/routes/github-app.ts). `undefined` for configs written before this
 * field existed, or when running on env vars only; callers fall back to a
 * live `isOrgAccount` lookup in that case (see `managedAdminAuth` below).
 */
export function managedGithubOwnerType(): 'User' | 'Organization' | undefined {
  return managedGithubAppConfig().ownerType;
}

/**
 * A straight org PAT for the managed org — the "one server-side key" model.
 * When set it takes precedence over the
 * GitHub App: simpler to operate, no install/permission dance. Trade-off: a
 * long-lived, org-wide token (vs the App's short-lived, repo-scoped, auto-
 * rotating installation tokens). Either way the token stays server-side — the
 * sandbox only ever sees KORTIX_TOKEN via the proxy.
 */
function managedGithubToken(): string | null {
  return (
    managedGithubAppConfig().pat?.trim() || process.env.MANAGED_GIT_GITHUB_TOKEN?.trim() || null
  );
}

/** Embed an `x-access-token:<token>` basic credential into an https git URL. */
function injectGitCredential(upstreamUrl: string, token: string): string {
  const u = new URL(upstreamUrl);
  u.username = 'x-access-token';
  u.password = token;
  return u.toString();
}

/**
 * Resolve a repo-scoped RUNTIME write token for a managed repo — the same
 * credential model as `resolveProjectGitAuth`'s managed-GitHub branch: the org
 * PAT when set, else a least-privilege installation token scoped to this repo.
 */
async function mintManagedWriteToken(ref: GitConnectionRef): Promise<string> {
  const pat = managedGithubToken();
  if (pat) return pat;
  const installId = ref.installationId ?? managedGithubInstallId();
  if (!installId) {
    throw new Error(
      'Managed GitHub git not configured (set MANAGED_GIT_GITHUB_TOKEN or _INSTALL_ID)',
    );
  }
  const minted = await createInstallationToken(
    installId,
    ref.repoName ? [ref.repoName] : undefined,
  );
  return minted.token;
}

/**
 * Admin-capable credential for managed-org operations that need org/repo-admin
 * scope (create repo, delete repo, add collaborator). PAT first, else an App
 * installation token (org-wide — NOT repo-scoped, since `createRepo` needs org
 * scope before the repo exists). Per-project RUNTIME tokens are minted
 * repo-scoped separately in `resolveProjectGitAuth`.
 */
async function managedAdminAuth(): Promise<GitHubAuthContext> {
  const owner = managedGithubOwner();
  if (!owner) throw new Error('Managed GitHub git not configured (MANAGED_GIT_GITHUB_OWNER)');
  const pat = managedGithubToken();
  if (pat) {
    // owner may be a personal account (e.g. a throwaway bot user, not an org)
    // → createRepo must hit /user/repos, not /orgs/{owner}/repos. Detected
    // live every time (self-host operators can point MANAGED_GIT_GITHUB_OWNER
    // at either kind of account; there is no "prod always means org"
    // assumption that holds across deployments) — cached by isOrgAccount so
    // this is a one-time lookup per owner login, not a lookup per request.
    const ownerType = (await isOrgAccount(owner, { token: pat })) ? 'Organization' : 'User';
    return { token: pat, source: 'pat', owner, ownerType };
  }
  const installId = managedGithubInstallId();
  if (!installId) {
    throw new Error(
      'Managed GitHub git not configured (set MANAGED_GIT_GITHUB_TOKEN or _INSTALL_ID)',
    );
  }
  const token = await createInstallationToken(installId);
  // Prefer the ownerType install-callback already resolved and stored from
  // GitHub's own `account.type` (no extra API call). Configs written before
  // that field existed (or set purely via env vars) fall back to a live
  // lookup — same personal-vs-org detection as the PAT path above, using the
  // installation token we already have in hand.
  const ownerType =
    managedGithubOwnerType() ??
    ((await isOrgAccount(owner, { token: token.token })) ? 'Organization' : 'User');
  return {
    token: token.token,
    source: 'app_installation',
    owner,
    ownerType,
    installationId: installId,
  };
}

export const githubBackend: GitHostBackend = {
  id: 'github',

  async isConfigured(): Promise<boolean> {
    const owner = managedGithubOwner();
    if (!owner) return false;
    // PAT path: a straight org token needs no App creds at all.
    if (managedGithubToken()) return true;
    // App-installation path: an installation id is useless without the App's
    // own id+private key to sign the JWT that mints installation tokens — so
    // this flips true only once appId+privateKey+owner+installationId are ALL
    // present (matches the DB config the in-app setup flow writes across its
    // two steps: manifest-callback stores appId/privateKey, install-callback
    // stores owner/installationId).
    return Boolean(managedGithubInstallId() && isGithubAppConfigured());
  },

  async createRepo(input: ProvisionInput): Promise<ProvisionedRepo> {
    const auth = await managedAdminAuth();
    const repo = await ghCreateRepo({
      name: input.slug,
      owner: auth.owner,
      isPrivate: input.isPrivate,
      autoInit: false,
      auth,
    });
    return {
      provider: 'github',
      upstreamUrl: repo.clone_url,
      externalRepoId: String(repo.id),
      repoOwner: auth.owner ?? null,
      repoName: repo.name,
      // Recorded for the App path; null when running on a PAT.
      installationId: managedGithubToken() ? null : managedGithubInstallId(),
      credentialRef: null,
      defaultBranch: repo.default_branch || input.defaultBranch,
      initialToken: null,
    };
  },

  async deleteRepo(ref: GitConnectionRef): Promise<void> {
    if (!ref.repoOwner || !ref.repoName) return;
    const auth = await managedAdminAuth();
    await ghDeleteRepo({ owner: ref.repoOwner, repo: ref.repoName, auth });
  },

  buildUpstream(ref: GitConnectionRef, token: string | null, _scope: GitScope): UpstreamGit {
    return { url: ref.upstreamUrl, headers: token ? basicAuthHeader(token) : {} };
  },

  async seedFiles(
    ref: GitConnectionRef,
    token: string,
    files: SeedFile[],
    opts: { branch: string; message: string; baseFiles?: SeedFile[] },
  ): Promise<void> {
    await seedRepoViaGitPush({
      upstreamUrl: ref.upstreamUrl,
      token,
      files,
      branch: opts.branch,
      commitMessage: opts.message,
      // Deterministic base commit (constant-var render) — committed FIRST so
      // every project of this starter shares an identical root SHA with the
      // image-baked scaffold (snapshots/build-context.ts). Without forwarding
      // this, the project root was the project-named files commit → unrelated
      // to the baked scaffold → every fresh session full-cloned through the
      // tunnel instead of delta-fetching one tiny commit (2026-06-13).
      baseFiles: opts.baseFiles,
    });
  },

  /**
   * Invite a GitHub user as a collaborator on a managed repo — lets the project
   * creator pull "their" repo into their own GitHub account (clone/work on
   * github.com directly). GitHub sends a pending invitation they accept.
   */
  async inviteCollaborator(
    ref: GitConnectionRef,
    username: string,
    scope: GitScope,
  ): Promise<InviteResult> {
    if (!ref.managed) throw new Error('collaborator invites are only for managed repos');
    if (!ref.repoOwner || !ref.repoName) throw new Error('repo coordinates are required');
    const auth = await managedAdminAuth();
    const invitation = await addCollaborator({
      owner: ref.repoOwner,
      repo: ref.repoName,
      username,
      permission: scope === 'write' ? 'push' : 'pull',
      auth,
    });
    return {
      username,
      permission: scope === 'write' ? 'push' : 'pull',
      invitationUrl: invitation?.html_url ?? null,
      alreadyCollaborator: invitation === null,
    };
  },

  async authedPushUrl(ref: GitConnectionRef): Promise<string> {
    const token = await mintManagedWriteToken(ref);
    return injectGitCredential(ref.upstreamUrl, token);
  },
};

export { managedGithubToken };
