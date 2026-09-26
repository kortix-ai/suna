import {
  type GitBackend,
  resolveGitBackend,
} from '../../platform/services/managed-git-backend';
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

// The instance git backend is resolved WHOLE from one source — env or the
// `managed_git_backend` platform setting — by
// platform/services/managed-git-backend.ts. Owner, kind, and credential always
// come from the same source; a stored owner never pairs with an env token.
//
// These four accessors exist for callers that need one field. Anything that
// needs the credential AND the owner together reads `resolveGitBackend()` once
// (see `managedAdminAuth`), so it can never observe two different sources.

export function managedGithubOwner(): string | null {
  return resolveGitBackend()?.owner ?? null;
}

export function managedGithubInstallId(): string | null {
  const backend = resolveGitBackend();
  return backend?.kind === 'app' ? backend.installationId : null;
}

/**
 * The stored account type for the App-installation owner (install-callback
 * records `account.type` straight off the installation payload). `undefined`
 * when it was never recorded; callers fall back to a live `isOrgAccount`
 * lookup in that case (see `managedAdminAuth` below).
 */
export function managedGithubOwnerType(): 'User' | 'Organization' | undefined {
  const backend = resolveGitBackend();
  return backend?.kind === 'app' ? (backend.ownerType ?? undefined) : undefined;
}

/**
 * A straight org token for the instance backend — the "one server-side key"
 * model. Simpler to operate than an App install, at the cost of a long-lived
 * org-wide token. Either way the token stays server-side: the sandbox only
 * ever sees KORTIX_TOKEN through the git proxy.
 */
function managedGithubToken(): string | null {
  const backend = resolveGitBackend();
  return backend?.kind === 'pat' ? backend.token : null;
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
  const backend = resolveGitBackend();
  if (backend?.kind === 'pat') return backend.token;
  const installId = ref.installationId ?? (backend?.kind === 'app' ? backend.installationId : null);
  if (!installId) {
    throw new Error(
      'The instance git backend is not configured (set MANAGED_GIT_GITHUB_TOKEN or MANAGED_GIT_GITHUB_INSTALL_ID)',
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
  const backend = resolveGitBackend();
  if (!backend) {
    throw new Error(
      'The instance git backend is not configured (set MANAGED_GIT_GITHUB_OWNER with MANAGED_GIT_GITHUB_TOKEN or MANAGED_GIT_GITHUB_INSTALL_ID)',
    );
  }
  if (backend.kind === 'pat') {
    // The owner may be a personal account (a bot user, not an org) →
    // createRepo must hit /user/repos, not /orgs/{owner}/repos. Detected live,
    // cached by isOrgAccount, so this is one lookup per owner login.
    const ownerType = (await isOrgAccount(backend.owner, { token: backend.token }))
      ? 'Organization'
      : 'User';
    return { token: backend.token, source: 'pat', owner: backend.owner, ownerType };
  }
  const token = await createInstallationToken(backend.installationId);
  // Prefer the ownerType the install callback already resolved from GitHub's
  // own `account.type`; fall back to a live lookup for a backend configured by
  // env, which carries no type.
  const ownerType =
    backend.ownerType ??
    ((await isOrgAccount(backend.owner, { token: token.token })) ? 'Organization' : 'User');
  return {
    token: token.token,
    source: 'app_installation',
    owner: backend.owner,
    ownerType,
    installationId: backend.installationId,
  };
}

export const githubBackend: GitHostBackend = {
  id: 'github',

  async isConfigured(): Promise<boolean> {
    const backend = resolveGitBackend();
    if (!backend) return false;
    // PAT path: a straight org token needs no App identity at all.
    if (backend.kind === 'pat') return true;
    // App path: an installation id is useless without the App's own id and
    // private key to sign the JWT that mints installation tokens.
    return isGithubAppConfigured();
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
      // Recorded for the App path; null when running on a token.
      installationId: auth.source === 'app_installation' ? (auth.installationId ?? null) : null,
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
