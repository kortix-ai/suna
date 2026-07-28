import { config } from '../../config';
import { managedGithubAppConfig } from '../../platform/services/managed-github-app';
import { managedGithubConnectionService } from '../../platform/services/managed-github-runtime';
import {
  type GitHubAuthContext,
  addCollaborator,
  createInstallationToken,
  createRepo as ghCreateRepo,
  deleteRepo as ghDeleteRepo,
  isGithubAppConfigured,
  isOrgAccount,
  plainGitHubEnv,
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
    plainGitHubEnv('MANAGED_GIT_GITHUB_OWNER') ||
    null
  );
}

export function managedGithubInstallId(): string | null {
  return (
    managedGithubAppConfig().installationId?.trim() ||
    plainGitHubEnv('MANAGED_GIT_GITHUB_INSTALL_ID') ||
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
  return managedGithubAppConfig().pat?.trim() || plainGitHubEnv('MANAGED_GIT_GITHUB_TOKEN');
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

export interface ManagedGithubBackendCredential {
  connectionId: string;
  installationId: string;
  owner: string;
  ownerType: 'Organization';
  token: string;
}

export interface GithubBackendDependencies {
  credentialMode(): 'nango_preferred' | 'nango_only';
  resolveManagedCredential(): Promise<ManagedGithubBackendCredential>;
  legacyConfigured(): Promise<boolean>;
  resolveLegacyAdminAuth(): Promise<GitHubAuthContext>;
  mintLegacyWriteToken(ref: GitConnectionRef): Promise<string>;
  createRepo: typeof ghCreateRepo;
  deleteRepo(
    input: Omit<Parameters<typeof ghDeleteRepo>[0], 'auth'> & { auth: GitHubAuthContext },
  ): ReturnType<typeof ghDeleteRepo>;
  addCollaborator(
    input: Omit<Parameters<typeof addCollaborator>[0], 'auth'> & { auth: GitHubAuthContext },
  ): ReturnType<typeof addCollaborator>;
  seedRepo: typeof seedRepoViaGitPush;
}

interface ResolvedBackendAuth {
  auth: GitHubAuthContext;
  connectionId: string | null;
  installationId: string | null;
}

export function createGithubBackend(dependencies: GithubBackendDependencies): GitHostBackend {
  const resolveManaged = async (): Promise<ResolvedBackendAuth> => {
    const managed = await dependencies.resolveManagedCredential();
    return {
      auth: {
        token: managed.token,
        source: 'nango',
        owner: managed.owner,
        ownerType: managed.ownerType,
        installationId: managed.installationId,
      },
      connectionId: managed.connectionId,
      installationId: managed.installationId,
    };
  };

  const resolveAdmin = async (): Promise<ResolvedBackendAuth> => {
    try {
      return await resolveManaged();
    } catch (error) {
      if (dependencies.credentialMode() === 'nango_only') throw error;
      const auth = await dependencies.resolveLegacyAdminAuth();
      return {
        auth,
        connectionId: null,
        installationId: auth.installationId ?? null,
      };
    }
  };

  const assertConnectionMatch = (ref: GitConnectionRef, resolved: ResolvedBackendAuth): void => {
    if (
      resolved.connectionId &&
      ((ref.credentialRef && ref.credentialRef !== resolved.connectionId) ||
        (ref.installationId && ref.installationId !== resolved.installationId))
    ) {
      throw new Error('Managed GitHub connection does not match the selected Nango connection.');
    }
  };

  const resolveWriteToken = async (ref: GitConnectionRef): Promise<string> => {
    try {
      const resolved = await resolveManaged();
      assertConnectionMatch(ref, resolved);
      return resolved.auth.token;
    } catch (error) {
      if (dependencies.credentialMode() === 'nango_only') throw error;
      return dependencies.mintLegacyWriteToken(ref);
    }
  };

  return {
    id: 'github',

    async isConfigured(): Promise<boolean> {
      try {
        await dependencies.resolveManagedCredential();
        return true;
      } catch {
        return dependencies.credentialMode() === 'nango_preferred'
          ? dependencies.legacyConfigured()
          : false;
      }
    },

    async createRepo(input: ProvisionInput): Promise<ProvisionedRepo> {
      const resolved = await resolveAdmin();
      const repo = await dependencies.createRepo({
        name: input.slug,
        owner: resolved.auth.owner,
        isPrivate: input.isPrivate,
        autoInit: false,
        auth: resolved.auth,
      });
      return {
        provider: 'github',
        upstreamUrl: repo.clone_url,
        externalRepoId: String(repo.id),
        repoOwner: resolved.auth.owner ?? null,
        repoName: repo.name,
        installationId: resolved.installationId,
        credentialRef: resolved.connectionId,
        defaultBranch: repo.default_branch || input.defaultBranch,
        initialToken: null,
      };
    },

    async deleteRepo(ref: GitConnectionRef): Promise<void> {
      if (!ref.repoOwner || !ref.repoName) return;
      const resolved = await resolveAdmin();
      assertConnectionMatch(ref, resolved);
      await dependencies.deleteRepo({
        owner: ref.repoOwner,
        repo: ref.repoName,
        auth: resolved.auth,
      });
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
      await dependencies.seedRepo({
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
      const resolved = await resolveAdmin();
      assertConnectionMatch(ref, resolved);
      const invitation = await dependencies.addCollaborator({
        owner: ref.repoOwner,
        repo: ref.repoName,
        username,
        permission: scope === 'write' ? 'push' : 'pull',
        auth: resolved.auth,
      });
      return {
        username,
        permission: scope === 'write' ? 'push' : 'pull',
        invitationUrl: invitation?.html_url ?? null,
        alreadyCollaborator: invitation === null,
      };
    },

    async authedPushUrl(ref: GitConnectionRef): Promise<string> {
      const token = await resolveWriteToken(ref);
      return injectGitCredential(ref.upstreamUrl, token);
    },
  };
}

async function legacyGithubConfigured(): Promise<boolean> {
  const owner = managedGithubOwner();
  if (!owner) return false;
  if (managedGithubToken()) return true;
  return Boolean(managedGithubInstallId() && isGithubAppConfigured());
}

export const githubBackend: GitHostBackend = createGithubBackend({
  credentialMode: () => config.GITHUB_CREDENTIAL_RESOLUTION,
  resolveManagedCredential: async () => {
    const resolved = await managedGithubConnectionService.resolveSelectedCredential();
    return {
      connectionId: resolved.credential.connectionId,
      installationId: resolved.credential.installationId,
      owner: resolved.setting.owner.login,
      ownerType: resolved.setting.owner.type,
      token: resolved.credential.installationToken,
    };
  },
  legacyConfigured: legacyGithubConfigured,
  resolveLegacyAdminAuth: managedAdminAuth,
  mintLegacyWriteToken: mintManagedWriteToken,
  createRepo: ghCreateRepo,
  deleteRepo: ghDeleteRepo,
  addCollaborator,
  seedRepo: seedRepoViaGitPush,
});

export { managedGithubToken };
