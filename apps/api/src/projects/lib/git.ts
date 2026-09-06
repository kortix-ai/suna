import { auth } from '../../openapi';
import { config } from '../../config';
import { validateAccountToken } from '../../repositories/account-tokens';
import { validateSecretKey } from '../../repositories/api-keys';
import { isAccountToken, isKortixToken } from '../../shared/crypto';
import { db } from '../../shared/db';
import { getBackend, managedGithubInstallId, managedGithubToken, parseBasicAuthHeader, type GitConnectionRef, type GitScope, type UpstreamGit } from '../git-backends';
import { buildGitHubAppInstallUrl, createInstallationToken, getRepo, getRepositoryBranch, isGithubAppConfigured, type GitHubAuthContext, type GitHubRepo } from '../github';
import {
  decryptProjectSecret,
  encryptProjectSecret,
  getProjectSecretValueForConsumer,
} from '../secrets';
import { recordAuditEvent } from '../../shared/audit';
import { accountGithubInstallationStates, accountGithubInstallations, accountMembers, projectGitConnections, projectGitCredentials, projectSessions, projects, sessionSandboxes } from '@kortix/db';
import { and, eq, gt, inArray, isNull } from 'drizzle-orm';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { ttlMemo } from '../../shared/ttl-memo';
import {
  isImpersonatingAccount,
  isImpersonationBlockedAccount,
} from '../../shared/impersonation';
// Imported from the leaf modules, not the `../../iam` barrel: this file is
// pulled in by most of the project surface, and several suites mock the barrel
// with a partial shape — a barrel import here turns those into module-load
// SyntaxErrors far from anything they're testing.
import { invalidateRequestMemo, requestMemo } from '../../lib/request-context';
import { PROJECT_ACTIONS } from '../../iam/actions';
import { authorize } from '../../iam/authorize';
import { actorForToken } from '../../iam/actor';
import type { RequestContext } from '../../iam/actor';
import { registerPrincipalScopedMemo } from '../../iam/cache-invalidation';
import { accountRoleFor } from '../../iam/read-models';
import { PROJECT_GIT_AUTH_SECRET_NAME, ProjectGitConnectionRow, ProjectGitCredentialRow, ProjectRow, normalizeJsonObject, normalizeString } from './serializers';
import type { GitPrincipal } from '../../git-proxy/ref-policy';
import {
  workspaceMetadataAllowsRepositoryAccess,
} from './session-workspace-access';

// Memoized briefly (positive hits only): this runs on every project-scoped
// request. Each DB statement is a fast same-region roundtrip (~3ms measured,
// not the cross-region cost this comment used to claim), but the same
// lookup repeats across a burst of parallel requests, so caching still cuts
// redundant query volume. A revoked membership lingers for at most one TTL
// window; a fresh grant is visible immediately because null results are
// never cached.
const loadAccountMembership = ttlMemo({
  ttlMs: 15_000,
  keyFn: (userId: string, accountId: string) => `${userId}|${accountId}`,
  loader: async (userId: string, accountId: string) => {
    // Membership IS the account-scope assignment (spec §1). The
    // `account_members.account_role` column this used to read is no longer
    // written by every path — an assignment made through `assignRole()` leaves
    // it stale on purpose — so reading it here would hand a project request a
    // role the engine disagrees with.
    const accountRole = await accountRoleFor(accountId, userId);
    return accountRole ? { accountId, accountRole } : null;
  },
  shouldCache: (membership) => membership !== null,
});
// Key is `${userId}|${accountId}` → bust per principal on account-member changes.
registerPrincipalScopedMemo(loadAccountMembership);

export async function getAccountMembership(userId: string, accountId: string) {
  // Act-as: a platform admin holding a live grant on this account resolves as
  // its owner. Checked BEFORE the memo, never inside it — `loadAccountMembership`
  // is keyed `${userId}|${accountId}` and shared across requests, so caching an
  // impersonation-derived membership would hand the operator owner rights on
  // their own later, non-impersonated requests for the whole TTL window.
  if (isImpersonatingAccount(userId, accountId)) {
    return { accountId, accountRole: 'owner' as const };
  }
  // …and CONFINES: while a grant is live, the operator's own memberships are
  // out of reach. Otherwise "open the app" lands on their last project (a
  // cookie), which is theirs, under a banner naming the customer.
  if (isImpersonationBlockedAccount(userId, accountId)) return null;
  return loadAccountMembership(userId, accountId);
}


export async function listAccountGitHubInstallations(accountId: string) {
  return await db
    .select()
    .from(accountGithubInstallations)
    .where(eq(accountGithubInstallations.accountId, accountId));
}


export async function getAccountGitHubInstallation(accountId: string, installationId?: string | null) {
  const rows = await listAccountGitHubInstallations(accountId);
  if (installationId) {
    return rows.find((row) => row.installationId === installationId) ?? null;
  }
  return rows[0] ?? null;
}


export async function createGitHubInstallationInstallUrl(accountId: string, userId: string): Promise<string | null> {
  if (!isGithubAppConfigured()) return null;
  const nonce = randomUUID();
  const installUrl = buildGitHubAppInstallUrl(
    accountId,
    nonce,
    'account_link',
    config.FRONTEND_URL,
  );
  if (!installUrl) return null;
  await db.insert(accountGithubInstallationStates).values({
    stateNonce: nonce,
    accountId,
    userId,
    expiresAt: new Date(Date.now() + 30 * 60 * 1000),
  });
  return installUrl;
}


export async function consumeGitHubInstallationState(input: {
  accountId: string;
  userId: string;
  nonce: string;
  installationId: string;
}): Promise<'consumed' | 'already_consumed' | 'invalid'> {
  const now = new Date();
  const updated = await db
    .update(accountGithubInstallationStates)
    .set({
      installationId: input.installationId,
      consumedAt: now,
    })
    .where(and(
      eq(accountGithubInstallationStates.stateNonce, input.nonce),
      eq(accountGithubInstallationStates.accountId, input.accountId),
      eq(accountGithubInstallationStates.userId, input.userId),
      isNull(accountGithubInstallationStates.consumedAt),
      gt(accountGithubInstallationStates.expiresAt, now),
    ))
    .returning({ stateNonce: accountGithubInstallationStates.stateNonce });

  if (updated.length === 1) return 'consumed';

  const [state] = await db
    .select({
      installationId: accountGithubInstallationStates.installationId,
      consumedAt: accountGithubInstallationStates.consumedAt,
    })
    .from(accountGithubInstallationStates)
    .where(and(
      eq(accountGithubInstallationStates.stateNonce, input.nonce),
      eq(accountGithubInstallationStates.accountId, input.accountId),
      eq(accountGithubInstallationStates.userId, input.userId),
      gt(accountGithubInstallationStates.expiresAt, now),
    ))
    .limit(1);

  if (state?.consumedAt && state.installationId === input.installationId) {
    return 'already_consumed';
  }

  return 'invalid';
}


export class GitHubInstallationRequiredError extends Error {
  constructor(public readonly accountId: string) {
    super('GitHub App installation required for this account');
  }
}

async function resolveImportedDefaultBranch(
  repo: GitHubRepo,
  requestedBranch: string | null | undefined,
  auth: Pick<GitHubAuthContext, 'token'>,
): Promise<string> {
  const branch = requestedBranch ?? repo.default_branch ?? 'main';
  if (!requestedBranch) return branch;

  const [owner, repoName] = repo.full_name.split('/');
  try {
    await getRepositoryBranch({ owner: owner!, repo: repoName!, branch, auth });
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'status' in error &&
      error.status === 404
    ) {
      throw new Error(`Selected branch "${branch}" does not exist in ${repo.full_name}`);
    }
    throw error;
  }
  return branch;
}


export async function resolveGitHubRepoAuth(accountId: string, installationId?: string | null): Promise<{
  auth?: GitHubAuthContext;
  authSource: 'app_installation';
  installation?: typeof accountGithubInstallations.$inferSelect;
}> {
  const installation = await getAccountGitHubInstallation(accountId, installationId);
  if (installation) {
    const token = await createInstallationToken(installation.installationId);
    return {
      auth: {
        token: token.token,
        source: 'app_installation',
        owner: installation.ownerLogin,
        ownerType: installation.ownerType,
        installationId: installation.installationId,
      },
      authSource: 'app_installation',
      installation,
    };
  }
  if (installationId) {
    throw new Error('Selected GitHub installation is not connected to this account');
  }

  // GitHub backing is App-only: a per-account App installation is required.
  // (Linking an existing repo with a user-supplied token is a separate flow
  // that stores a project_credential — see resolveGitHubImportWithPat.)
  if (isGithubAppConfigured()) {
    throw new GitHubInstallationRequiredError(accountId);
  }

  throw new Error('GitHub is not configured on the server');
}


export interface ProjectGitRemote {
  /** github | gitlab | bitbucket | generic */
  provider: string;
  /** managed | github_app | pat | project_credential | none */
  authMethod: string;
  /** Deprecated managed-repo id slot — always null. */
  repoId: string | null;
  /** Auth credential reference. */
  ref: string | null;
  installationId: string | null;
  repoOwner: string | null;
  repoName: string | null;
  externalRepoId: string | null;
  /** Real upstream host git URL, distinct from the client-facing proxy URL. */
  upstreamUrl: string | null;
  /** True when Kortix provisioned the repo. */
  managed: boolean;
}


/**
 * Request-memo key for one project's git connection. Exported so the write path
 * below (and any future one) invalidates the exact same key it caches under.
 */
function gitConnectionMemoKey(projectId: string): string {
  return `project-git-connection:${projectId}`;
}

/**
 * The project's git connection row.
 *
 * Reached through four independent helpers (`withProjectGitAuth`,
 * `resolveProjectUpstream`, `hasServerManagedGitAuth`, and the `/detail`
 * response field), so a single request loads it two to three times: measured
 * 3× on `GET /:projectId/detail` and 2× on `/secrets`, `/sandbox-health` and
 * `/sessions/:id/config` (postgres.js statement trace, 2026-08-26). Each is a
 * separate serial round trip on the request's critical path.
 *
 * Memoized for the duration of ONE request only — never across requests — so a
 * caller can never observe a connection row written before its own request
 * started. The upsert below drops the entry, so a read AFTER a write in the
 * same request still sees the new row.
 */
export async function getProjectGitConnection(projectId: string): Promise<ProjectGitConnectionRow | null> {
  return requestMemo(gitConnectionMemoKey(projectId), async () => {
    const [row] = await db
      .select()
      .from(projectGitConnections)
      .where(eq(projectGitConnections.projectId, projectId))
      .limit(1);
    return row ?? null;
  });
}


export async function upsertProjectGitConnection(input: {
  accountId: string;
  projectId: string;
  provider: string;
  repoUrl: string;
  /** Real upstream host git URL (distinct from the client-facing repoUrl). */
  upstreamUrl?: string | null;
  /** True when Kortix provisioned the repo. */
  managed?: boolean;
  repoOwner?: string | null;
  repoName?: string | null;
  externalRepoId?: string | number | null;
  defaultBranch: string;
  authMethod: string;
  installationId?: string | null;
  credentialRef?: string | null;
  permissions?: Record<string, unknown> | null;
  visibility?: string | null;
  webhookId?: string | null;
  status?: string;
  lastValidatedAt?: Date | null;
  lastErrorCode?: string | null;
  lastErrorMessage?: string | null;
  metadata?: Record<string, unknown> | null;
}): Promise<ProjectGitConnectionRow> {
  const now = new Date();
  const values = {
    accountId: input.accountId,
    projectId: input.projectId,
    provider: input.provider,
    repoUrl: input.repoUrl,
    upstreamUrl: input.upstreamUrl ?? null,
    managed: input.managed ?? false,
    repoOwner: input.repoOwner ?? null,
    repoName: input.repoName ?? null,
    externalRepoId: input.externalRepoId == null ? null : String(input.externalRepoId),
    defaultBranch: input.defaultBranch,
    authMethod: input.authMethod,
    installationId: input.installationId ?? null,
    credentialRef: input.credentialRef ?? null,
    permissions: input.permissions ?? {},
    visibility: input.visibility ?? null,
    webhookId: input.webhookId ?? null,
    status: input.status ?? 'connected',
    lastValidatedAt: input.lastValidatedAt ?? now,
    lastErrorCode: input.lastErrorCode ?? null,
    lastErrorMessage: input.lastErrorMessage ?? null,
    metadata: input.metadata ?? {},
    updatedAt: now,
  };
  const [row] = await db
    .insert(projectGitConnections)
    .values(values)
    .onConflictDoUpdate({
      target: [projectGitConnections.projectId],
      set: values,
    })
    .returning();
  // The read above is request-memoized; a write inside the same request must
  // not leave the pre-write row cached behind it.
  invalidateRequestMemo(gitConnectionMemoKey(input.projectId));
  return row;
}


export async function getProjectGitCredential(
  projectId: string,
  provider: string,
): Promise<ProjectGitCredentialRow | null> {
  const [row] = await db
    .select()
    .from(projectGitCredentials)
    .where(and(
      eq(projectGitCredentials.projectId, projectId),
      eq(projectGitCredentials.provider, provider),
    ))
    .limit(1);
  return row ?? null;
}


export async function upsertProjectGitCredential(input: {
  accountId: string;
  projectId: string;
  provider: string;
  token: string;
  createdBy: string;
}): Promise<ProjectGitCredentialRow> {
  const now = new Date();
  const values = {
    accountId: input.accountId,
    projectId: input.projectId,
    provider: input.provider,
    authMethod: 'token',
    valueEnc: encryptProjectSecret(input.projectId, input.token),
    createdBy: input.createdBy,
    updatedAt: now,
  };
  const [row] = await db
    .insert(projectGitCredentials)
    .values(values)
    .onConflictDoUpdate({
      target: [projectGitCredentials.projectId, projectGitCredentials.provider],
      set: values,
    })
    .returning();
  return row;
}


export function emptyGitRemote(): ProjectGitRemote {
  return {
    provider: 'generic',
    authMethod: 'none',
    repoId: null,
    ref: null,
    installationId: null,
    repoOwner: null,
    repoName: null,
    externalRepoId: null,
    upstreamUrl: null,
    managed: false,
  };
}


export function getProjectGitRemote(project: ProjectRow, connection?: ProjectGitConnectionRow | null): ProjectGitRemote {
  if (connection) {
    return {
      provider: connection.provider,
      authMethod: connection.authMethod,
      repoId: null,
      ref: connection.credentialRef,
      installationId: connection.installationId,
      repoOwner: connection.repoOwner,
      repoName: connection.repoName,
      externalRepoId: connection.externalRepoId,
      upstreamUrl: connection.upstreamUrl ?? null,
      managed: connection.managed ?? false,
    };
  }

  const meta = (project.metadata ?? {}) as Record<string, any>;
  const git = meta.git;
  if (git && typeof git === 'object') {
    const method = String(git.auth?.method ?? 'none');
    return {
      provider: String(git.provider ?? 'generic'),
      authMethod: method,
      repoId: git.repo_id ?? null,
      ref: git.auth?.ref ?? null,
      installationId: git.auth?.installation_id ?? git.installation_id ?? null,
      repoOwner: git.owner ?? null,
      repoName: git.name ?? null,
      externalRepoId: git.external_repo_id ?? git.repo_id ?? null,
      upstreamUrl: typeof git.upstream_url === 'string' ? git.upstream_url : null,
      managed: git.managed === true || method === 'managed',
    };
  }
  if (meta.github) {
    const repo = parseGitHubRepoUrl(project.repoUrl);
    const github = normalizeJsonObject(meta.github);
    return {
      provider: 'github',
      authMethod: github.auth_source === 'pat' ? 'pat' : 'github_app',
      repoId: null,
      ref: null,
      installationId: normalizeString(github.installation_id),
      repoOwner: repo?.owner ?? null,
      repoName: repo?.repo ?? null,
      externalRepoId: normalizeString(github.repo_id),
      upstreamUrl: null,
      managed: false,
    };
  }
  return emptyGitRemote();
}

/**
 * Real upstream host git URL for a project. Prefers the explicit `upstreamUrl`
 * (set once the git-proxy refactor lands), then derives it from the provider's
 * coordinates, and finally falls back to `project.repoUrl` — correct for every
 * pre-refactor project, where repoUrl IS the real URL.
 */

export function resolveUpstreamUrl(project: ProjectRow, remote: ProjectGitRemote): string {
  if (remote.upstreamUrl) return remote.upstreamUrl;
  if (remote.provider === 'github' && remote.repoOwner && remote.repoName) {
    return `https://github.com/${remote.repoOwner}/${remote.repoName}.git`;
  }
  return project.repoUrl;
}

/** Provider-neutral connection ref consumed by git backends. */

export function buildConnectionRef(project: ProjectRow, remote: ProjectGitRemote): GitConnectionRef {
  return {
    provider: remote.provider,
    upstreamUrl: resolveUpstreamUrl(project, remote),
    externalRepoId: remote.externalRepoId,
    repoOwner: remote.repoOwner,
    repoName: remote.repoName,
    installationId: remote.installationId,
    credentialRef: remote.ref,
    defaultBranch: project.defaultBranch,
    managed: remote.managed,
    metadata: {},
  };
}


export async function hasServerManagedGitAuth(project: ProjectRow): Promise<boolean> {
  const remote = getProjectGitRemote(project, await getProjectGitConnection(project.projectId));
  if (remote.provider === 'github' && remote.authMethod === 'github_app') {
    return true;
  }
  return false;
}


/**
 * Why `resolveProjectGitAuth` could not produce a credential. Only set when
 * `authSource` is `'none'`. `installation_*` mean the ACCOUNT has to act (the
 * GitHub App is missing, or no longer mints tokens for the stored
 * installation — which is what happens when the App identity itself changes);
 * everything else is a server-side or data problem the account cannot fix by
 * reconnecting. `resolveProjectGitConnection` turns the first kind into a
 * reconnect prompt.
 */
export type GitAuthUnavailableReason =
  | 'installation_missing'
  | 'installation_unusable'
  | 'installation_mismatch'
  | 'repo_url_unparseable'
  | 'managed_git_unavailable'
  | 'no_credential';

export async function resolveProjectGitAuth(project: ProjectRow): Promise<{
  auth?: GitHubAuthContext;
  authSource: 'app_installation' | 'pat' | 'managed' | 'project_credential' | 'none';
  reason?: GitAuthUnavailableReason;
}> {
  const remote = getProjectGitRemote(project, await getProjectGitConnection(project.projectId));

  // Managed GitHub repos use the server PAT first. The managed GitHub App can
  // exist without access to every repository. Repeated failed token minting
  // adds remote latency to every Git-backed project read. The PAT is internal
  // and is never exported by the API/CLI push-token boundary.
  if (remote.provider === 'github' && remote.managed) {
    const pat = managedGithubToken();
    if (pat) {
      return {
        auth: { token: pat, source: 'pat', owner: remote.repoOwner ?? undefined, ownerType: 'Organization' },
        authSource: 'pat',
      };
    }

    const installId = remote.installationId ?? managedGithubInstallId();
    if (installId && isGithubAppConfigured()) {
      const repoName = remote.repoName ?? parseGitHubRepoUrl(remote.upstreamUrl ?? project.repoUrl)?.repo;
      try {
        const token = await createInstallationToken(installId, repoName ? [repoName] : undefined);
        return {
          auth: {
            token: token.token,
            source: 'app_installation',
            owner: remote.repoOwner ?? undefined,
            ownerType: 'Organization',
            installationId: installId,
          },
          authSource: 'app_installation',
        };
      } catch (err) {
        console.warn(
          `[projects] failed to mint managed GitHub installation token for ${project.projectId}:`,
          err,
        );
      }
    }
    return { authSource: 'none', reason: 'managed_git_unavailable' };
  }

  if (remote.provider === 'github' && remote.authMethod === 'github_app') {
    const repo = parseGitHubRepoUrl(remote.upstreamUrl ?? project.repoUrl);
    if (!repo) return { authSource: 'none', reason: 'repo_url_unparseable' };
    const installation = remote.installationId
      ? await getAccountGitHubInstallation(project.accountId, remote.installationId)
      : (await listAccountGitHubInstallations(project.accountId)).find(
          (candidate) => candidate.ownerLogin.toLowerCase() === repo.owner.toLowerCase(),
        ) ?? null;
    if (!installation) return { authSource: 'none', reason: 'installation_missing' };
    if (repo.owner.toLowerCase() !== installation.ownerLogin.toLowerCase()) {
      return { authSource: 'none', reason: 'installation_mismatch' };
    }
    if (remote.repoOwner && remote.repoOwner.toLowerCase() !== repo.owner.toLowerCase()) {
      return { authSource: 'none', reason: 'installation_mismatch' };
    }
    if (remote.repoName && remote.repoName.toLowerCase() !== repo.repo.toLowerCase()) {
      return { authSource: 'none', reason: 'installation_mismatch' };
    }
    // Scope the BYO token to the single linked repo too.
    //
    // Minting can fail for a reason the account can fix: GitHub 404s when the
    // App JWT does not own this installation, which is exactly what a stored
    // installation looks like after the App identity changes, and it also 404s
    // once someone uninstalls the App. Without this catch that failure THREW
    // out of a routine auth resolve, so callers saw an opaque error instead of
    // "reconnect GitHub". Degrade to a named reason and let
    // resolveProjectGitConnection turn it into a prompt.
    try {
      const token = await createInstallationToken(installation.installationId, [repo.repo]);
      return {
        auth: {
          token: token.token,
          source: 'app_installation',
          owner: installation.ownerLogin,
          ownerType: installation.ownerType,
          installationId: installation.installationId,
        },
        authSource: 'app_installation',
      };
    } catch (err) {
      console.warn(
        `[projects] GitHub App installation ${installation.installationId} no longer mints tokens for ${project.projectId}:`,
        err,
      );
      return { authSource: 'none', reason: 'installation_unusable' };
    }
  }

  if (remote.authMethod === 'project_credential') {
    const credential = await getProjectGitCredential(project.projectId, remote.provider);
    if (credential) {
      const token = decryptProjectSecret(project.projectId, credential.valueEnc);
      await recordAuditEvent({
        accountId: project.accountId,
        projectId: project.projectId,
        action: 'secret.consumer.used',
        resourceType: 'project_git_credential',
        resourceId: credential.credentialId,
        source: 'git_proxy',
        metadata: { provider: remote.provider, consumer: 'git_proxy' },
      });
      return {
        auth: {
          token,
          source: 'project_credential',
        },
        authSource: 'project_credential',
      };
    }
  }

  const legacyToken = await getProjectSecretValueForConsumer({
    projectId: project.projectId,
    accountId: project.accountId,
    name: PROJECT_GIT_AUTH_SECRET_NAME,
    consumer: 'git_proxy',
  });
  if (legacyToken) {
    return {
      auth: {
        token: legacyToken,
        source: 'project_credential',
      },
      authSource: 'project_credential',
    };
  }

  return { authSource: 'none', reason: 'no_credential' };
}

/** What the client should show for a project's git connection. */
export type ProjectGitConnectionState = {
  state: 'connected' | 'reconnect_required' | 'unavailable' | 'not_connected';
  reason?: GitAuthUnavailableReason;
  installUrl?: string | null;
};

/**
 * Answer "is this project's git connection usable, and if not can the account
 * fix it themselves?" — the read behind the Reconnect GitHub prompt.
 *
 * Only the two `installation_*` reasons are the account's to fix, and only
 * those return an install URL. A managed-git or repo-URL failure is ours, so
 * it reports `unavailable`: telling someone to reconnect would send them round
 * a loop that cannot help.
 */
export async function resolveProjectGitConnection(
  project: ProjectRow,
  userId: string,
): Promise<ProjectGitConnectionState> {
  const remote = getProjectGitRemote(project, await getProjectGitConnection(project.projectId));
  if (!remote.upstreamUrl && !project.repoUrl) return { state: 'not_connected' };

  const resolved = await resolveProjectGitAuth(project);
  if (resolved.authSource !== 'none') return { state: 'connected' };

  const reconnectable =
    resolved.reason === 'installation_missing' ||
    resolved.reason === 'installation_unusable' ||
    resolved.reason === 'installation_mismatch';
  if (!reconnectable) return { state: 'unavailable', reason: resolved.reason };

  return {
    state: 'reconnect_required',
    reason: resolved.reason,
    installUrl: await createGitHubInstallationInstallUrl(project.accountId, userId),
  };
}


export async function withProjectGitAuth(project: ProjectRow): Promise<ProjectRow & {
  gitAuthToken: string | null;
  gitAuthHeaders: Record<string, string>;
}> {
  const upstream = await resolveProjectUpstream(project, 'write');
  const credential = parseBasicAuthHeader(upstream?.headers.Authorization);
  return {
    ...project,
    repoUrl: upstream?.url ?? project.repoUrl,
    // Keep the legacy token field populated for GitHub API fast paths and
    // older callers, but derive it from the backend-produced credential so
    // provider-minted credentials (for example Code Storage `t:<jwt>`) are
    // represented consistently with the headers used by git CLI operations.
    gitAuthToken: credential?.token ?? null,
    gitAuthHeaders: upstream?.headers ?? {},
  };
}

/**
 * Resolve a project to a real upstream git endpoint + short-lived host auth
 * headers — the single seam consumed by the Kortix git proxy (and, post-M2,
 * server-side git). Token resolution reuses `resolveProjectGitAuth` (managed +
 * BYO GitHub / project credential); the backend formats
 * the URL + headers for the provider. Returns null when no upstream is
 * resolvable (no git connection / unauthenticated).
 */

export async function resolveProjectUpstream(
  project: ProjectRow,
  scope: GitScope = 'read',
): Promise<UpstreamGit | null> {
  const remote = getProjectGitRemote(project, await getProjectGitConnection(project.projectId));
  if (remote.authMethod === 'none' && remote.provider === 'generic' && !remote.upstreamUrl) {
    // No git connection at all.
    if (!project.repoUrl) return null;
  }
  const gitAuth = await resolveProjectGitAuth(project);
  const ref = buildConnectionRef(project, remote);
  if (!ref.upstreamUrl) return null;
  const backend = getBackend(ref.provider);
  return backend.buildUpstream(ref, gitAuth.auth?.token ?? null, scope);
}


export type GitProxyAuth =
  | { ok: true; project: ProjectRow; principal: GitPrincipal }
  | { ok: false; status: number; message: string };

/**
 * Authorize a Kortix git-proxy request: a bare credential (extracted from the
 * git Basic/Bearer header) + the target project + the operation scope.
 *
 * The owning account is the trust boundary:
 *  - sandbox runtime token → must be scoped to an active sandbox of THIS
 *    project (read + write);
 *  - account API key (kortix_…) → the account must own the project;
 *  - CLI PAT (kortix_pat_…) → the account owns the project, OR the token's user
 *    holds `project.gitops.push` / `.read` on it; a project-scoped PAT must
 *    match this project either way.
 *
 * Account ownership alone grants write, which is safe since only account
 * members can mint these tokens. (Finer per-project role gating for THAT case
 * lands with M2.)
 *
 * The per-project fallback exists because token-account equality was too strict
 * to be the only rule: a PAT is bound to ONE account, so anybody in two
 * accounts (personal + team, the common case) could create a project through
 * the API and then never push to it. A project-grant collaborator was likewise
 * accepted by POST /git-token — which hands out a STRONGER credential, a raw
 * provider token — while being refused here. This is parity with that endpoint,
 * not new reach.
 */

/**
 * A clone is 2–3 requests within seconds, and the agent's later `git push`
 * / `fetch` are pairs too. Every one used to pay the full authorization walk
 * (project row + token row + sandbox join, each a cross-region DB round trip).
 * Memoize a POSITIVE verdict per (token, project, scope) for a short window;
 * denials are never cached, so a revoked token is refused on its next request
 * and an accepted one is at most GIT_PROXY_AUTHZ_TTL_MS stale.
 */
const GIT_PROXY_AUTHZ_TTL_MS = 30_000;
const gitProxyAuthzMemo = new Map<string, { value: GitProxyAuth; expiresAt: number }>();
export function __resetGitProxyAuthzMemoForTests(): void {
  gitProxyAuthzMemo.clear();
}
// Per-process random key: the memo key is an HMAC of the credential, so a heap
// dump exposes neither the credential nor a reusable digest of it.
const gitProxyAuthzMemoKey = randomBytes(32);
function authzMemoKey(token: string, projectId: string, scope: GitScope): string {
  const digest = createHmac('sha256', gitProxyAuthzMemoKey).update(token).digest('hex');
  return `${digest}|${projectId}|${scope}`;
}

export async function authorizeGitProxy(
  token: string,
  projectId: string,
  scope: GitScope,
  requestCtx: RequestContext = {},
): Promise<GitProxyAuth> {
  const key = authzMemoKey(token, projectId, scope);
  const now = Date.now();
  const hit = gitProxyAuthzMemo.get(key);
  if (hit && hit.expiresAt > now) return hit.value;
  const verdict = await authorizeGitProxyUncached(token, projectId, scope, requestCtx);
  if (verdict.ok) {
    gitProxyAuthzMemo.set(key, { value: verdict, expiresAt: now + GIT_PROXY_AUTHZ_TTL_MS });
    if (gitProxyAuthzMemo.size > 10_000) {
      for (const [k, v] of gitProxyAuthzMemo) if (v.expiresAt <= now) gitProxyAuthzMemo.delete(k);
    }
  }
  return verdict;
}

async function authorizeGitProxyUncached(
  token: string,
  projectId: string,
  scope: GitScope,
  requestCtx: RequestContext = {},
): Promise<GitProxyAuth> {
  // The project row and the token row are independent look-ups; overlap them
  // instead of paying two sequential cross-region round trips.
  const projectPromise = db
    .select()
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1)
    .then((rows) => rows[0]);
  const tokenPromise: Promise<
    | { kind: 'account'; result: Awaited<ReturnType<typeof validateAccountToken>> }
    | { kind: 'kortix'; result: Awaited<ReturnType<typeof validateSecretKey>> }
    | { kind: 'none' }
  > = isAccountToken(token)
    ? validateAccountToken(token).then((result) => ({ kind: 'account' as const, result }))
    : isKortixToken(token)
      ? validateSecretKey(token).then((result) => ({ kind: 'kortix' as const, result }))
      : Promise.resolve({ kind: 'none' as const });
  const [project, tokenCheck] = await Promise.all([projectPromise, tokenPromise]);
  if (!project || project.status === 'archived') {
    return { ok: false, status: 404, message: 'Not found' };
  }

  /** Does this token's USER hold the git capability this operation needs? */
  const grantedByProjectRole = async (
    userId: string | null | undefined,
    actingTokenId?: string,
  ): Promise<boolean> => {
    if (!userId) return false;
    const action =
      scope === 'write' ? PROJECT_ACTIONS.PROJECT_GITOPS_PUSH : PROJECT_ACTIONS.PROJECT_GITOPS_READ;
    // The git proxy authenticates its own token (a PAT or a session connector
    // token), so the actor is built FROM that token id rather than from a Hono
    // context — same classification, same agent-grant fold.
    const verdict = await authorize(
      await actorForToken(userId, project.accountId, actingTokenId, { ctx: requestCtx }),
      action,
      { type: 'project', id: projectId },
    );
    return verdict.allowed;
  };

  // CLI PAT first — `isKortixToken` also matches the `kortix_pat_` prefix, so
  // the account-token check MUST run before the API-key check (mirrors the auth
  // middleware ordering).
  if (tokenCheck.kind === 'account') {
    const result = tokenCheck.result;
    if (!result.isValid || !result.accountId) {
      return { ok: false, status: 401, message: result.error || 'Invalid PAT' };
    }
    if (result.projectId && result.projectId !== projectId) {
      return { ok: false, status: 403, message: 'token is scoped to a different project' };
    }
    // A SESSION-scoped PAT is an agent credential wearing a different prefix:
    // the `kortix` CLI inside a sandbox authenticates with one. It must land on
    // the same principal as the sandbox token, or the ref allowlist would be a
    // one-line bypass (swap the credential, keep the push).
    let sessionPrincipal: GitPrincipal | null = null;
    if (result.sessionId) {
      const [sessionRow] = await db
        .select({
          sessionId: projectSessions.sessionId,
          branchName: projectSessions.branchName,
          sessionMetadata: projectSessions.metadata,
        })
        .from(projectSessions)
        .where(
          and(
            eq(projectSessions.sessionId, result.sessionId),
            eq(projectSessions.accountId, result.accountId),
            eq(projectSessions.projectId, projectId),
          ),
        )
        .limit(1);
      if (!sessionRow || !workspaceMetadataAllowsRepositoryAccess(sessionRow.sessionMetadata)) {
        return {
          ok: false,
          status: 403,
          message: 'session workspace does not allow repository access',
        };
      }
      if (!sessionRow.branchName) {
        return { ok: false, status: 403, message: 'session has no branch to push' };
      }
      sessionPrincipal = {
        kind: 'session',
        sessionId: sessionRow.sessionId,
        branch: sessionRow.branchName,
      };
    }
    if (result.accountId !== project.accountId) {
      // Thread the acting token so the agent-grant fold fires (userRole ∩ grant)
      // — a bare authorize() would silently skip it.
      if (!(await grantedByProjectRole(result.userId, result.tokenId))) {
        return { ok: false, status: 403, message: 'token is not authorized for this project' };
      }
    }
    return {
      ok: true,
      project,
      principal:
        sessionPrincipal ?? {
          kind: 'user',
          userId: result.userId ?? null,
          tokenId: result.tokenId ?? null,
        },
    };
  }

  if (tokenCheck.kind === 'kortix') {
    const result = tokenCheck.result;
    if (!result.isValid || !result.accountId) {
      return { ok: false, status: 401, message: result.error || 'Invalid token' };
    }
    if (result.type === 'sandbox') {
      if (!result.sandboxId) {
        return { ok: false, status: 403, message: 'sandbox token missing a sandbox scope' };
      }
      const [sandbox] = await db
        .select({
          sandboxId: sessionSandboxes.sandboxId,
          sessionId: projectSessions.sessionId,
          branchName: projectSessions.branchName,
          sessionMetadata: projectSessions.metadata,
        })
        .from(sessionSandboxes)
        .innerJoin(
          projectSessions,
          and(
            eq(projectSessions.sessionId, sessionSandboxes.sessionId),
            eq(projectSessions.projectId, sessionSandboxes.projectId),
            eq(projectSessions.accountId, sessionSandboxes.accountId),
          ),
        )
        .where(and(
          eq(sessionSandboxes.sandboxId, result.sandboxId),
          eq(sessionSandboxes.projectId, projectId),
          eq(sessionSandboxes.accountId, result.accountId),
          inArray(sessionSandboxes.status, ['provisioning', 'active']),
        ))
        .limit(1);
      if (!sandbox) {
        // Not a session box — a MONITOR box authenticates with the same token
        // class but lives in `project_monitor_boxes` (it has no session row by
        // design; docs/specs/2026-08-12-monitors.md §Security model). It clones
        // the repo at default-branch HEAD through this proxy.
        const { loadMonitorBoxForToken } = await import('./monitor-ingest');
        const monitorBox = await loadMonitorBoxForToken({
          projectId,
          accountId: result.accountId,
          sandboxId: result.sandboxId,
        });
        if (monitorBox) return { ok: true, project, principal: { kind: 'monitor' } };
        return { ok: false, status: 403, message: 'sandbox token is not scoped to this project' };
      }
      if (!workspaceMetadataAllowsRepositoryAccess(sandbox.sessionMetadata)) {
        return { ok: false, status: 403, message: 'sandbox workspace does not allow Git access' };
      }
      // A session's git authority is its own branch and nothing else — see
      // git-proxy/ref-policy.ts. Refuse rather than widen if the row somehow
      // carries no branch: an unnamed branch would make the allowlist empty in
      // one direction and unbounded in the other, depending on how it is read.
      if (!sandbox.branchName) {
        return { ok: false, status: 403, message: 'session has no branch to push' };
      }
      return {
        ok: true,
        project,
        principal: {
          kind: 'session',
          sessionId: sandbox.sessionId,
          branch: sandbox.branchName,
        },
      };
    }
    // Account-scoped user API key. No per-project fallback here: an API key
    // carries no user identity, so there is no principal to evaluate project
    // grants against — account ownership stays the only rule.
    if (result.accountId !== project.accountId) {
      return { ok: false, status: 403, message: 'token does not own this project' };
    }
    return { ok: true, project, principal: { kind: 'user', userId: null } };
  }

  return { ok: false, status: 401, message: 'git proxy requires a Kortix token' };
}


export async function resolveGitHubImport(input: {
  accountId: string;
  repoUrl: string;
  installationId?: string | null;
  defaultBranch?: string | null;
}): Promise<{
  repo: GitHubRepo;
  installation: typeof accountGithubInstallations.$inferSelect;
  auth: GitHubAuthContext;
  defaultBranch: string;
}> {
  const parsed = parseGitHubRepoUrl(input.repoUrl);
  if (!parsed) {
    throw new Error('repo_url must be a GitHub repository URL');
  }

  const installations = input.installationId
    ? [
        await getAccountGitHubInstallation(input.accountId, input.installationId),
      ].filter(Boolean) as Array<typeof accountGithubInstallations.$inferSelect>
    : await listAccountGitHubInstallations(input.accountId);
  const installation = input.installationId
    ? installations[0] ?? null
    : installations.find(
        (candidate) => candidate.ownerLogin.toLowerCase() === parsed.owner.toLowerCase(),
      ) ?? null;
  if (!installation) {
    if (installations.length === 0) throw new GitHubInstallationRequiredError(input.accountId);
    throw new Error(
      input.installationId
        ? 'Selected GitHub installation is not connected to this account'
        : `Install or select a GitHub App installation for ${parsed.owner} to link this repo`,
    );
  }
  if (parsed.owner.toLowerCase() !== installation.ownerLogin.toLowerCase()) {
    throw new Error(
      `GitHub App installation is for ${installation.ownerLogin}; install Kortix on ${parsed.owner} to link this repo`,
    );
  }

  const token = await createInstallationToken(installation.installationId);
  const auth: GitHubAuthContext = {
    token: token.token,
    source: 'app_installation',
    owner: installation.ownerLogin,
    ownerType: installation.ownerType,
    installationId: installation.installationId,
  };
  const repo = await getRepo({ owner: parsed.owner, repo: parsed.repo, auth });
  return {
    repo,
    installation,
    auth,
    defaultBranch: await resolveImportedDefaultBranch(repo, input.defaultBranch, auth),
  };
}


/**
 * Validate an existing GitHub repo using a caller-supplied PAT — the
 * App-free link path. The PAT just needs read+write on the repo; we verify
 * read here (and surface a clear error if the token can't see it or lacks
 * push) so the user finds out at link time, not on the first session push.
 */

export async function resolveGitHubImportWithPat(input: {
  repoUrl: string;
  token: string;
  defaultBranch?: string | null;
}): Promise<{ repo: GitHubRepo; defaultBranch: string }> {
  const parsed = parseGitHubRepoUrl(input.repoUrl);
  if (!parsed) throw new Error('repo_url must be a GitHub repository URL');
  let repo: GitHubRepo;
  try {
    repo = await getRepo({ owner: parsed.owner, repo: parsed.repo, auth: { token: input.token } });
  } catch (error) {
    throw new Error(
      `Could not access ${parsed.owner}/${parsed.repo} with the provided GitHub token — ` +
        `check the token grants access to this repo (${(error as Error).message})`,
    );
  }
  // The API returns `permissions` when the token is authenticated against the
  // repo; a read-only token would make sessions unable to push branches.
  const perms = (repo as unknown as { permissions?: { push?: boolean } }).permissions;
  if (perms && perms.push === false) {
    throw new Error(
      `The GitHub token can read ${repo.full_name} but lacks write (push) access — ` +
        `grant Contents: Read and write so sessions can push branches.`,
    );
  }
  return {
    repo,
    defaultBranch: await resolveImportedDefaultBranch(
      repo,
      input.defaultBranch,
      { token: input.token },
    ),
  };
}

/**
 * Create (or re-point) a project backed by an existing GitHub repo via a
 * stored PAT — no GitHub App installation required. The PAT is encrypted into
 * `project_git_credentials` and the connection is `project_credential`, which
 * `resolveProjectGitAuth` already knows how to use for session clone/push.
 */

export async function loadGitProject(loaded: { row: ProjectRow }) {
  const resolved = await withProjectGitAuth(loaded.row);
  return {
    projectId: resolved.projectId,
    repoUrl: resolved.repoUrl,
    defaultBranch: resolved.defaultBranch,
    manifestPath: resolved.manifestPath,
    gitAuthToken: resolved.gitAuthToken,
    gitAuthHeaders: resolved.gitAuthHeaders,
  };
}

/** Lazy provider-neutral mirror access resolution from only a project id. */
export async function resolveProjectGitAccessById(projectId: string): Promise<{
  repoUrl: string;
  token: string | null;
  headers: Record<string, string>;
} | null> {
  try {
    const [row] = await db
      .select()
      .from(projects)
      .where(eq(projects.projectId, projectId))
      .limit(1);
    if (!row) return null;
    const resolved = await withProjectGitAuth(row);
    return {
      repoUrl: resolved.repoUrl,
      token: resolved.gitAuthToken,
      headers: resolved.gitAuthHeaders,
    };
  } catch (err) {
    console.warn(
      `[projects] lazy git-access resolve failed for ${projectId}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Resolve a project's upstream git auth token from just its id — loads the
 * project row, then runs the normal `resolveProjectGitAuth` resolution
 * (managed App/PAT, BYO App, project_credential, legacy secret).
 *
 * This is the lazy fallback the shared mirror layer (`git/mirror.ts`) calls
 * when a caller reaches `refreshMirror()` without a token. The per-project
 * mirror is a shared resource hit by ~15 code paths; relying on every caller to
 * thread a non-null token is fragile, and `refreshMirror`'s per-project dedup
 * means a single tokenless caller can make the cold bare-clone of a PRIVATE
 * repo run unauthenticated (`fatal: could not read Username for github.com`)
 * and fail every concurrent caller piggybacking on that shared clone. Resolving
 * here guarantees the network git op is authenticated whenever a credential
 * exists, regardless of which caller won the refresh lock.
 *
 * Returns null when the project is gone or has no resolvable git auth. Never
 * throws — a resolution failure must degrade to "no token" (caller behaves
 * exactly as before this hook existed), never crash the mirror refresh.
 */
export async function resolveProjectGitAuthTokenById(projectId: string): Promise<string | null> {
  return (await resolveProjectGitAccessById(projectId))?.token ?? null;
}

// GET /v1/projects/:projectId/sandboxes
// Available templates for this project: platform default + any `sandbox:`
// `templates:` entries from kortix.yaml. Each row includes its live Daytona
// state so the picker can show "ready" / "building" / "missing" at a glance.

export function parseGitHubRepoUrl(repoUrl: string): { owner: string; repo: string } | null {
  // Accept https://github.com/owner/repo(.git) and git@github.com:owner/repo(.git).
  const m =
    repoUrl.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i) ??
    repoUrl.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (!m) return null;
  return { owner: m[1]!, repo: m[2]! };
}

/**
 * Convert a validated draft into the spec shape the manifest writer
 * expects (and the trigger loader returns).
 */
