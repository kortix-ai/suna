import { managedGithubConnectionService } from '../../platform/services/managed-github-runtime';
import { recordGithubCredentialState } from '../nango/telemetry';
import {
  type GitHubAuthContext,
  addCollaborator,
  createRepo as ghCreateRepo,
  deleteRepo as ghDeleteRepo,
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

/** Embed an `x-access-token:<token>` basic credential into an https git URL. */
function injectGitCredential(upstreamUrl: string, token: string): string {
  const u = new URL(upstreamUrl);
  u.username = 'x-access-token';
  u.password = token;
  return u.toString();
}

export interface ManagedGithubBackendCredential {
  connectionId: string;
  installationId: string;
  owner: string;
  ownerType: 'Organization';
  token: string;
}

export interface GithubBackendDependencies {
  resolveManagedCredential(): Promise<ManagedGithubBackendCredential>;
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
    const resolved = await resolveManaged();
    assertConnectionMatch(ref, resolved);
    return resolved.auth.token;
  };

  return {
    id: 'github',

    async isConfigured(): Promise<boolean> {
      try {
        await dependencies.resolveManagedCredential();
        return true;
      } catch {
        return false;
      }
    },

    async createRepo(input: ProvisionInput): Promise<ProvisionedRepo> {
      const resolved = await resolveManaged();
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
      const resolved = await resolveManaged();
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
      const resolved = await resolveManaged();
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

export const githubBackend: GitHostBackend = createGithubBackend({
  resolveManagedCredential: async () => {
    try {
      const resolved = await managedGithubConnectionService.resolveSelectedCredential();
      recordGithubCredentialState({
        scope: 'managed',
        state: 'connected',
        outcome: 'success',
      });
      return {
        connectionId: resolved.credential.connectionId,
        installationId: resolved.credential.installationId,
        owner: resolved.setting.owner.login,
        ownerType: resolved.setting.owner.type,
        token: resolved.credential.installationToken,
      };
    } catch (error) {
      const code =
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        typeof error.code === 'string'
          ? error.code
          : 'github_reconnect_required';
      recordGithubCredentialState({
        scope: 'managed',
        state: code === 'github_reconnect_required' ? 'needs_reconnect' : 'error',
        outcome: 'error',
        errorCode: code,
      });
      throw error;
    }
  },
  createRepo: ghCreateRepo,
  deleteRepo: ghDeleteRepo,
  addCollaborator,
  seedRepo: seedRepoViaGitPush,
});
