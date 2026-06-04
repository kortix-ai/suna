import { auth } from '../../openapi';
import { validateAccountToken } from '../../repositories/account-tokens';
import { validateSecretKey } from '../../repositories/api-keys';
import { isAccountToken, isKortixToken } from '../../shared/crypto';
import { db } from '../../shared/db';
import { getBackend, managedGithubInstallId, managedGithubToken, type GitConnectionRef, type GitScope, type UpstreamGit } from '../git-backends';
import { buildGitHubAppInstallUrl, createInstallationToken, getRepo, isGithubAppConfigured, type GitHubAuthContext, type GitHubRepo } from '../github';
import { decryptProjectSecret, encryptProjectSecret } from '../secrets';
import { accountGithubInstallationStates, accountGithubInstallations, accountMembers, projectGitConnections, projectGitCredentials, projects, sessionSandboxes } from '@kortix/db';
import { and, eq, gt, inArray, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { grantProjectRole } from './access';
import { ProjectGitConnectionRow, ProjectGitCredentialRow, ProjectRow, deriveProjectName, normalizeJsonObject, normalizeString } from './serializers';

export async function getAccountMembership(userId: string, accountId: string) {
  const [membership] = await db
    .select({ accountId: accountMembers.accountId, accountRole: accountMembers.accountRole })
    .from(accountMembers)
    .where(and(eq(accountMembers.userId, userId), eq(accountMembers.accountId, accountId)))
    .limit(1);
  return membership ?? null;
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
  const installUrl = buildGitHubAppInstallUrl(accountId, nonce);
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


export async function getProjectGitConnection(projectId: string): Promise<ProjectGitConnectionRow | null> {
  const [row] = await db
    .select()
    .from(projectGitConnections)
    .where(eq(projectGitConnections.projectId, projectId))
    .limit(1);
  return row ?? null;
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


export async function resolveProjectGitAuth(project: ProjectRow): Promise<{
  auth?: GitHubAuthContext;
  authSource: 'app_installation' | 'pat' | 'managed' | 'project_credential' | 'none';
}> {
  const remote = getProjectGitRemote(project, await getProjectGitConnection(project.projectId));

  // Managed GitHub repos (Kortix-provisioned, under the managed org). Two
  // server-side credential models:
  //   - PAT  (MANAGED_GIT_GITHUB_TOKEN): the "one server-side key" model — used
  //     directly (org-wide; never leaves the API).
  //   - App  (installation): mint a token scoped to THIS repo only (least
  //     privilege) so a project's sandbox can never touch another managed repo.
  if (remote.provider === 'github' && remote.managed) {
    const pat = managedGithubToken();
    if (pat) {
      return {
        auth: { token: pat, source: 'pat', owner: remote.repoOwner ?? undefined, ownerType: 'Organization' },
        authSource: 'pat',
      };
    }
    const installId = remote.installationId ?? managedGithubInstallId();
    if (!installId) return { authSource: 'none' };
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
      console.warn(`[projects] failed to mint managed GitHub token for ${project.projectId}:`, err);
      return { authSource: 'none' };
    }
  }

  if (remote.provider === 'github' && remote.authMethod === 'github_app') {
    const repo = parseGitHubRepoUrl(remote.upstreamUrl ?? project.repoUrl);
    if (!repo) return { authSource: 'none' };
    const installation = remote.installationId
      ? await getAccountGitHubInstallation(project.accountId, remote.installationId)
      : (await listAccountGitHubInstallations(project.accountId)).find(
          (candidate) => candidate.ownerLogin.toLowerCase() === repo.owner.toLowerCase(),
        ) ?? null;
    if (!installation) return { authSource: 'none' };
    if (repo.owner.toLowerCase() !== installation.ownerLogin.toLowerCase()) {
      return { authSource: 'none' };
    }
    if (remote.repoOwner && remote.repoOwner.toLowerCase() !== repo.owner.toLowerCase()) {
      return { authSource: 'none' };
    }
    if (remote.repoName && remote.repoName.toLowerCase() !== repo.repo.toLowerCase()) {
      return { authSource: 'none' };
    }
    // Scope the BYO token to the single linked repo too.
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
  }

  if (remote.authMethod === 'project_credential') {
    const credential = await getProjectGitCredential(project.projectId, remote.provider);
    if (credential) {
      return {
        auth: {
          token: decryptProjectSecret(project.projectId, credential.valueEnc),
          source: 'project_credential',
        },
        authSource: 'project_credential',
      };
    }
  }

  return { authSource: 'none' };
}


export async function withProjectGitAuth(project: ProjectRow): Promise<ProjectRow & { gitAuthToken: string | null }> {
  const gitAuth = await resolveProjectGitAuth(project);
  return {
    ...project,
    gitAuthToken: gitAuth.auth?.token ?? null,
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
  | { ok: true; project: ProjectRow }
  | { ok: false; status: number; message: string };

/**
 * Authorize a Kortix git-proxy request: a bare credential (extracted from the
 * git Basic/Bearer header) + the target project + the operation scope.
 *
 * The owning account is the trust boundary:
 *  - sandbox runtime token → must be scoped to an active sandbox of THIS
 *    project (read + write);
 *  - account API key (kortix_…) → the account must own the project;
 *  - CLI PAT (kortix_pat_…) → account must own the project; a project-scoped
 *    PAT must match this project.
 *
 * (Finer per-project role gating for account-level PAT writes lands with M2 —
 * for now account ownership grants write, which is safe since only account
 * members can mint these tokens.)
 */

export async function authorizeGitProxy(
  token: string,
  projectId: string,
  _scope: GitScope,
): Promise<GitProxyAuth> {
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);
  if (!project || project.status === 'archived') {
    return { ok: false, status: 404, message: 'Not found' };
  }

  // CLI PAT first — `isKortixToken` also matches the `kortix_pat_` prefix, so
  // the account-token check MUST run before the API-key check (mirrors the auth
  // middleware ordering).
  if (isAccountToken(token)) {
    const result = await validateAccountToken(token);
    if (!result.isValid || !result.accountId) {
      return { ok: false, status: 401, message: result.error || 'Invalid PAT' };
    }
    if (result.projectId && result.projectId !== projectId) {
      return { ok: false, status: 403, message: 'token is scoped to a different project' };
    }
    if (result.accountId !== project.accountId) {
      return { ok: false, status: 403, message: 'token does not own this project' };
    }
    return { ok: true, project };
  }

  if (isKortixToken(token)) {
    const result = await validateSecretKey(token);
    if (!result.isValid || !result.accountId) {
      return { ok: false, status: 401, message: result.error || 'Invalid token' };
    }
    if (result.type === 'sandbox') {
      if (!result.sandboxId) {
        return { ok: false, status: 403, message: 'sandbox token missing a sandbox scope' };
      }
      const [sandbox] = await db
        .select({ sandboxId: sessionSandboxes.sandboxId })
        .from(sessionSandboxes)
        .where(and(
          eq(sessionSandboxes.sandboxId, result.sandboxId),
          eq(sessionSandboxes.projectId, projectId),
          eq(sessionSandboxes.accountId, result.accountId),
          inArray(sessionSandboxes.status, ['provisioning', 'active']),
        ))
        .limit(1);
      if (!sandbox) {
        return { ok: false, status: 403, message: 'sandbox token is not scoped to this project' };
      }
      return { ok: true, project };
    }
    // Account-scoped user API key.
    if (result.accountId !== project.accountId) {
      return { ok: false, status: 403, message: 'token does not own this project' };
    }
    return { ok: true, project };
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
    defaultBranch: input.defaultBranch ?? repo.default_branch ?? 'main',
  };
}


export async function registerGitHubLinkedProject(input: {
  accountId: string;
  userId: string;
  repo: GitHubRepo;
  installation: typeof accountGithubInstallations.$inferSelect;
  name?: string | null;
  defaultBranch: string;
  manifestPath: string;
}): Promise<ProjectRow> {
  const projectName = input.name ?? deriveProjectName(input.repo.full_name);
  const now = new Date();
  const metadata = {
    git: {
      url: input.repo.clone_url,
      default_branch: input.defaultBranch,
      provider: 'github',
      owner: input.repo.full_name.split('/')[0] ?? null,
      name: input.repo.name,
      external_repo_id: String(input.repo.id),
      auth: {
        method: 'github_app',
        installation_id: input.installation.installationId,
      },
    },
    github: {
      repo_id: String(input.repo.id),
      full_name: input.repo.full_name,
      html_url: input.repo.html_url,
      private: input.repo.private,
      auth_source: 'app_installation',
      installation_id: input.installation.installationId,
    },
  };

  const [row] = await db
    .insert(projects)
    .values({
      accountId: input.accountId,
      name: projectName,
      repoUrl: input.repo.clone_url,
      defaultBranch: input.defaultBranch,
      manifestPath: input.manifestPath,
      status: 'active',
      metadata,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [projects.accountId, projects.repoUrl],
      set: {
        name: projectName,
        defaultBranch: input.defaultBranch,
        manifestPath: input.manifestPath,
        status: 'active',
        metadata,
        updatedAt: now,
      },
    })
    .returning();

  await upsertProjectGitConnection({
    accountId: input.accountId,
    projectId: row.projectId,
    provider: 'github',
    repoUrl: input.repo.clone_url,
    repoOwner: input.repo.full_name.split('/')[0] ?? null,
    repoName: input.repo.name,
    externalRepoId: input.repo.id,
    defaultBranch: input.defaultBranch,
    authMethod: 'github_app',
    installationId: input.installation.installationId,
    permissions: input.installation.permissions ?? {},
    visibility: input.repo.private ? 'private' : 'public',
    status: 'connected',
    metadata: {
      full_name: input.repo.full_name,
      html_url: input.repo.html_url,
      ssh_url: input.repo.ssh_url,
    },
  });

  await grantProjectRole({
    accountId: input.accountId,
    projectId: row.projectId,
    userId: input.userId,
    role: 'manager',
    grantedBy: input.userId,
  });

  return row;
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
  return { repo, defaultBranch: input.defaultBranch ?? repo.default_branch ?? 'main' };
}

/**
 * Create (or re-point) a project backed by an existing GitHub repo via a
 * stored PAT — no GitHub App installation required. The PAT is encrypted into
 * `project_git_credentials` and the connection is `project_credential`, which
 * `resolveProjectGitAuth` already knows how to use for session clone/push.
 */

export async function registerPatLinkedProject(input: {
  accountId: string;
  userId: string;
  repo: GitHubRepo;
  token: string;
  name?: string | null;
  defaultBranch: string;
  manifestPath: string;
}): Promise<ProjectRow> {
  const projectName = input.name ?? deriveProjectName(input.repo.full_name);
  const now = new Date();
  const metadata = {
    git: {
      url: input.repo.clone_url,
      default_branch: input.defaultBranch,
      provider: 'github',
      owner: input.repo.full_name.split('/')[0] ?? null,
      name: input.repo.name,
      external_repo_id: String(input.repo.id),
      auth: { method: 'project_credential' },
    },
    github: {
      repo_id: String(input.repo.id),
      full_name: input.repo.full_name,
      html_url: input.repo.html_url,
      private: input.repo.private,
      auth_source: 'pat',
    },
  };

  const [row] = await db
    .insert(projects)
    .values({
      accountId: input.accountId,
      name: projectName,
      repoUrl: input.repo.clone_url,
      defaultBranch: input.defaultBranch,
      manifestPath: input.manifestPath,
      status: 'active',
      metadata,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [projects.accountId, projects.repoUrl],
      set: {
        name: projectName,
        defaultBranch: input.defaultBranch,
        manifestPath: input.manifestPath,
        status: 'active',
        metadata,
        updatedAt: now,
      },
    })
    .returning();

  const credential = await upsertProjectGitCredential({
    accountId: input.accountId,
    projectId: row.projectId,
    provider: 'github',
    token: input.token,
    createdBy: input.userId,
  });

  await upsertProjectGitConnection({
    accountId: input.accountId,
    projectId: row.projectId,
    provider: 'github',
    repoUrl: input.repo.clone_url,
    repoOwner: input.repo.full_name.split('/')[0] ?? null,
    repoName: input.repo.name,
    externalRepoId: input.repo.id,
    defaultBranch: input.defaultBranch,
    authMethod: 'project_credential',
    credentialRef: credential.credentialId,
    visibility: input.repo.private ? 'private' : 'public',
    status: 'connected',
    metadata: {
      full_name: input.repo.full_name,
      html_url: input.repo.html_url,
      ssh_url: input.repo.ssh_url,
    },
  });

  await grantProjectRole({
    accountId: input.accountId,
    projectId: row.projectId,
    userId: input.userId,
    role: 'manager',
    grantedBy: input.userId,
  });

  return row;
}


export async function loadGitProject(loaded: { row: ProjectRow }) {
  const gitAuth = await resolveProjectGitAuth(loaded.row);
  return {
    projectId: loaded.row.projectId,
    repoUrl: loaded.row.repoUrl,
    defaultBranch: loaded.row.defaultBranch,
    manifestPath: loaded.row.manifestPath,
    gitAuthToken: gitAuth.auth?.token ?? null,
  };
}

// GET /v1/projects/:projectId/sandboxes
// Available templates for this project: platform default + any `[[sandbox.templates]]`
// entries from kortix.toml. Each row includes its live Daytona state so the
// picker can show "ready" / "building" / "missing" at a glance.

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
