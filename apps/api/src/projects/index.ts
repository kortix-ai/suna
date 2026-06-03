/**
 * Project CRUD.
 *
 * Project is the new first-class source-of-truth object: one account-owned Git
 * repo plus the Kortix metadata needed to render and launch sessions later.
 * The old sandbox/instance tables remain as legacy compute state.
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Cron } from 'croner';
import { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  accounts,
  accountGithubInstallations,
  accountGithubInstallationStates,
  accountGroups,
  accountGroupMembers,
  accountInvitations,
  accountMembers,
  kortixApiKeys,
  projects,
  projectMembers,
  projectGroupGrants,
  projectGitConnections,
  projectGitCredentials,
  projectSecrets,
  projectTriggerRuntime,
  projectSessions,
  sessionSandboxes,
  changeRequests,
} from '@kortix/db';
import type { AppEnv } from '../types';
import { db } from '../shared/db';
import { ensureOpencodeSessionPin } from './opencode-mapping';
import { sendAccountInviteEmail, buildInviteUrl } from '../accounts/email';
import { resolveAccountId } from '../shared/resolve-account';
import { supabaseAuth } from '../middleware/auth';
import { getSupabase } from '../shared/supabase';
import {
  archiveRepoSubtree,
  commitFileToBranch,
  createRemoteSessionBranch,
  getBranchDiff,
  getCommit,
  getCommitDiff,
  getDiffBetweenShas,
  getFileHistory,
  invalidateProjectMirror,
  listBranches,
  listCommits,
  listRepoFiles,
  loadProjectConfig,
  mergeBranches,
  previewMerge,
  readRepoFile,
  resolveBranchTip,
  grepRepoFiles,
  searchRepoFileNames,
} from './git';
import {
  getCrById,
  getNextCrNumber,
  serializeChangeRequest,
} from './change-requests';
import {
  buildGitHubAppInstallUrl,
  commitFile,
  createInstallationToken,
  createRepo,
  getFileSha,
  getRepo,
  getGitHubAppInstallation,
  isGithubAppConfigured,
  listInstallationRepositories,
  type GitHubAuthContext,
  type GitHubRepo,
  verifyGitHubAppInstallStatePayload,
} from './github';
import { buildStarterFiles, normalizeStarterTemplateId } from './starter';
import {
  getBackend,
  hasBackend,
  managedGithubInstallId,
  managedGithubToken,
  type GitConnectionRef,
  type GitScope,
  type UpstreamGit,
} from './git-backends';
import { seedRepoViaGitPush } from './git-backends/seed';
import { lookupUserIdByEmail } from '../shared/users';
import {
  ACCOUNT_ACTIONS,
  PROJECT_ACTIONS,
  authorize,
  assertAuthorized,
  listAccessibleResources,
} from '../iam';
import { deriveRequestContext } from '../iam/cache';
import {
  isSecretUsableBy,
  isSessionVisibleTo,
  loadGrants,
  loadSessionGrants,
  parseSharingIntent,
  resolveShareSubject,
  scopeToIntent,
  setSecretSharing,
  setSessionSharing,
  visibilityToIntent,
  type SecretGrant,
  type ShareSubject,
} from '../executor/share';
import {
  deleteSandboxImage,
  kickPreBuild,
  kickProjectTemplatePrebuilds,
  listSandboxTemplates,
  listSnapshotBuilds,
  reconcileStaleBuilds,
  resolveTemplate,
  DEFAULT_SANDBOX_SLUG,
} from '../snapshots/builder';
import {
  createTemplate,
  deleteTemplate,
  getTemplateById,
  updateTemplate,
} from '../snapshots/templates';
import { getSandboxProvider } from '../snapshots/providers';
import { classifySnapshotError, describeSnapshotError } from '../snapshots/error-classify';
import { provisionSessionSandbox } from '../platform/services/session-sandbox';
import { claimWarmSandbox, getWarmPoolCounts, notePoolPresence, refillProjectPool, resolveWarmConfig, syncClaimedBoxToBase, warmPoolEnabled } from '../platform/services/warm-pool';
import { resolveAppsEnabled } from './apps-config';
import { rehydrateSessionChat } from './legacy-migration-rehydrate';
import { ProvisionTimeline } from '../platform/services/provision-timeline';
import { getProvider } from '../platform/providers';
import { config, type SandboxProviderName } from '../config';
import { maxConcurrentSessionsForTier, resolveAccountTier } from '../shared/account-limits';
import { recordAuditEvent } from '../shared/audit';
import { pauseComputeSession, endComputeSession } from '../billing/services/compute-metering';
import { checkBillingActive } from '../billing/services/billing-gate';
import {
  decryptProjectSecret,
  encryptProjectSecret,
  getProjectSecretValue,
  isValidSecretName,
  listProjectSecretsSnapshotForUser,
} from './secrets';
import {
  completeChatGptHeadlessAuth,
  startChatGptHeadlessAuth,
} from './opencode-chatgpt-auth';

const CODEX_AUTH_JSON_SECRET_NAME = 'CODEX_AUTH_JSON';
import {
  effectiveProjectRole,
  foldEffectiveProjectAccess,
  isAccountManager,
  parseProjectRole,
  roleAllows,
  type AccountRole,
  type ProjectAccessAction,
  type ProjectRole,
} from './access';
import {
  KNOWN_SCHEMA_VERSION,
  MANIFEST_FILENAME,
  extractTriggers,
  loadProjectTriggers,
  readManifest,
  serializeManifest,
  triggerSpecToTomlEntry,
  type GitTriggerSpec,
  type ParsedManifest,
} from './triggers';
import {
  appSpecToTomlEntry,
  extractApps,
  loadProjectApps,
  manifestHashForApp,
  resolveAppDomains,
  type AppBuildSpec,
  type AppSourceSpec,
  type AppSpec,
} from './apps';
import {
  deleteSlackInstall,
  loadSlackInstall,
  saveSlackInstall,
} from '../channels/install-store';
import { relayTurnStep, relayTurnAnswer, postQuestionAndWait, type QuestionInfo } from '../channels/slack-webhook';
import { buildSlackInstallUrl } from '../channels/slack-oauth';
import { slackOauthMode } from '../channels/slack-oauth-mode';
import {
  deployAppSpec,
  getLatestDeployment,
  runProjectAppSweep,
} from './app-sweep';
import { getProvider as getDeploymentProvider } from '../deployments/providers';
import { deployments } from '@kortix/db';
import {
  createAccountToken,
  listAccountTokens,
  revokeAccountToken,
  validateAccountToken,
} from '../repositories/account-tokens';
import { validateSecretKey } from '../repositories/api-keys';
import { isAccountToken, isKortixToken } from '../shared/crypto';

export const projectsApp = new Hono<AppEnv>();
export const projectWebhooksApp = new Hono<AppEnv>();

projectsApp.use('/*', supabaseAuth);

type ProjectRow = typeof projects.$inferSelect;
type ProjectGitConnectionRow = typeof projectGitConnections.$inferSelect;
type ProjectGitCredentialRow = typeof projectGitCredentials.$inferSelect;
type ProjectSessionRow = typeof projectSessions.$inferSelect;
type RequestAuditContext = {
  method: string;
  path: string;
  ip: string | null;
  userAgent: string | null;
};
type SessionCreateError = {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
};

const UUID_V4_REGEX = /^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const ACTIVE_SESSION_STATUSES = ['queued', 'branching', 'provisioning', 'running'] as const;
const PROVISIONING_SESSION_STATUSES = ['queued', 'branching', 'provisioning'] as const;
const PROJECT_GIT_AUTH_SECRET_NAME = 'KORTIX_GIT_AUTH_TOKEN';

function serializeSession(
  row: ProjectSessionRow,
  ctx?: {
    /** The grants on this session (for restricted visibility). */
    grants?: SecretGrant[];
    /** The viewing user, to compute is_owner / can_manage_sharing. */
    viewerId?: string;
    /** Viewer can manage the project (owner/admin/manager). */
    canManageProject?: boolean;
    /** Resolved email of the session owner, for "shared by X" display. */
    ownerEmail?: string | null;
  },
) {
  const opencodeSessions = Array.isArray(row.metadata?.opencode_sessions)
    ? row.metadata.opencode_sessions
    : [];
  const isOwner = ctx?.viewerId ? row.createdBy === ctx.viewerId : false;
  return {
    session_id: row.sessionId,
    account_id: row.accountId,
    project_id: row.projectId,
    branch_name: row.branchName,
    base_ref: row.baseRef,
    sandbox_provider: row.sandboxProvider,
    sandbox_id: row.sandboxId,
    sandbox_url: row.sandboxUrl,
    opencode_session_id: row.opencodeSessionId,
    name: typeof row.metadata?.name === 'string' ? row.metadata.name : null,
    agent_name: row.agentName,
    status: row.status,
    error: row.error,
    metadata: row.metadata ?? {},
    opencode_sessions: opencodeSessions,
    // Ownership + org-visibility (Phase 2 session sharing).
    created_by: row.createdBy,
    owner_email: ctx?.ownerEmail ?? null,
    visibility: row.visibility,
    sharing: visibilityToIntent(row.visibility as 'private' | 'project' | 'restricted', ctx?.grants ?? []),
    is_owner: isOwner,
    can_manage_sharing: isOwner || Boolean(ctx?.canManageProject),
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

/**
 * Load a session and enforce that the viewer can SEE it (owner, project-wide,
 * or in the allow-list). Returns null for both not-found and not-visible so we
 * never reveal the existence of a private session. Also reports whether the
 * viewer may manage its sharing (owner or project manager).
 */
async function loadVisibleSession(
  loaded: { row: ProjectRow; userId: string; effectiveRole: ProjectRole },
  sessionId: string,
): Promise<{
  row: ProjectSessionRow;
  subject: ShareSubject;
  grants: SecretGrant[];
  isOwner: boolean;
  canManageProject: boolean;
  canManageSharing: boolean;
} | null> {
  const [row] = await db
    .select()
    .from(projectSessions)
    .where(and(
      eq(projectSessions.sessionId, sessionId),
      eq(projectSessions.projectId, loaded.row.projectId),
      eq(projectSessions.accountId, loaded.row.accountId),
    ))
    .limit(1);
  if (!row) return null;
  const subject = await resolveShareSubject(loaded.userId);
  const grants = (await loadSessionGrants([sessionId])).get(sessionId) ?? [];
  if (!isSessionVisibleTo(row.visibility as 'private' | 'project' | 'restricted', row.createdBy, grants, subject)) {
    return null;
  }
  const isOwner = row.createdBy === loaded.userId;
  const canManageProject = roleAllows(loaded.effectiveRole, 'manage');
  return { row, subject, grants, isOwner, canManageProject, canManageSharing: isOwner || canManageProject };
}

function dashboardBaseUrl(): string {
  return (config.KORTIX_DASHBOARD_URL || config.FRONTEND_URL || 'https://kortix.com').replace(/\/+$/, '');
}

/** True when a GitHub repo-create error is a name collision (HTTP 422). On
 *  POST /user/repos a 422 is, in practice, always "name already exists". */
function isRepoNameTakenError(error: unknown): boolean {
  const m = ((error as Error)?.message ?? '').toLowerCase();
  return m.includes('already exists') || m.includes('name already') || m.includes('(422)');
}

function serializeProject(row: ProjectRow, access?: { projectRole: ProjectRole | null; effectiveRole: ProjectRole }) {
  return {
    project_id: row.projectId,
    account_id: row.accountId,
    name: row.name,
    repo_url: row.repoUrl,
    // Universal client-facing git origin. When the proxy is enabled, runtime
    // clients (CLI `ship`, web) clone/push this with a Kortix token instead of
    // the real host URL. Falls back to repo_url so callers can always use it.
    git_origin_url: config.KORTIX_GIT_PROXY ? proxyGitUrl(row.projectId) : row.repoUrl,
    default_branch: row.defaultBranch,
    manifest_path: row.manifestPath,
    status: row.status,
    metadata: row.metadata ?? {},
    last_opened_at: row.lastOpenedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    project_role: access?.projectRole ?? null,
    effective_project_role: access?.effectiveRole ?? null,
    dashboard_url: `${dashboardBaseUrl()}/projects/${row.projectId}`,
    // Single source of truth for the experimental [[apps]] surface. Threading
    // the EFFECTIVE per-project value onto the project payload lets the web
    // client gate the Apps section + sidebar shortcut off the SAME gate that
    // gates the API routes. Per-project override (metadata.apps_enabled) wins;
    // KORTIX_APPS_EXPERIMENTAL is the default for projects that haven't chosen.
    apps_enabled: resolveAppsEnabled(row.metadata),
    // Warm sandbox pool (Customize → Sandbox). `warm_pool` is the effective
    // per-project config (UI value over the operator default); `warm_pool_available`
    // gates the UI control off the platform feature flag.
    warm_pool: resolveWarmConfig(row.metadata),
    warm_pool_available: warmPoolEnabled(),
  };
}

function serializeProjectGitConnection(row: ProjectGitConnectionRow | null) {
  if (!row) return null;
  return {
    connection_id: row.connectionId,
    account_id: row.accountId,
    project_id: row.projectId,
    provider: row.provider,
    repo_url: row.repoUrl,
    repo_owner: row.repoOwner,
    repo_name: row.repoName,
    external_repo_id: row.externalRepoId,
    default_branch: row.defaultBranch,
    auth_method: row.authMethod,
    installation_id: row.installationId,
    credential_ref: row.credentialRef,
    permissions: row.permissions ?? {},
    visibility: row.visibility,
    webhook_id: row.webhookId,
    status: row.status,
    last_validated_at: row.lastValidatedAt?.toISOString() ?? null,
    last_error_code: row.lastErrorCode,
    last_error_message: row.lastErrorMessage,
    metadata: row.metadata ?? {},
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function serializeGitHubRepo(repo: GitHubRepo) {
  return {
    id: String(repo.id),
    name: repo.name,
    full_name: repo.full_name,
    private: repo.private,
    html_url: repo.html_url,
    clone_url: repo.clone_url,
    ssh_url: repo.ssh_url,
    default_branch: repo.default_branch,
    description: repo.description,
  };
}

function clientIp(c: Context) {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    || c.req.header('x-real-ip')
    || null;
}

function requestAuditContext(c: Context): RequestAuditContext {
  return {
    method: c.req.method,
    path: c.req.path,
    ip: clientIp(c),
    userAgent: c.req.header('user-agent') || null,
  };
}

function sendSessionCreateError(c: Context, error: SessionCreateError) {
  for (const [key, value] of Object.entries(error.headers ?? {})) {
    c.header(key, value);
  }
  return c.json(error.body, error.status as any);
}

async function countActiveProjectSessions(accountId: string): Promise<number> {
  const [row] = await db
    .select({ activeCount: sql<number>`count(*)::int` })
    .from(projectSessions)
    .where(and(
      eq(projectSessions.accountId, accountId),
      inArray(projectSessions.status, [...ACTIVE_SESSION_STATUSES]),
    ))
    .limit(1);

  return Number(row?.activeCount ?? 0);
}

async function countProvisioningProjectSessions(projectId: string): Promise<number> {
  const [row] = await db
    .select({ provisioningCount: sql<number>`count(*)::int` })
    .from(projectSessions)
    .where(and(
      eq(projectSessions.projectId, projectId),
      inArray(projectSessions.status, [...PROVISIONING_SESSION_STATUSES]),
    ))
    .limit(1);

  return Number(row?.provisioningCount ?? 0);
}

async function enforceConcurrentSessionCap(accountId: string, userId: string, request?: RequestAuditContext): Promise<SessionCreateError | null> {
  const tier = await resolveAccountTier(accountId);
  const limit = maxConcurrentSessionsForTier(tier);
  const activeSessions = await countActiveProjectSessions(accountId);
  if (activeSessions < limit) return null;

  recordAuditEvent({
    accountId,
    actorUserId: userId,
    action: `RATE_LIMIT ${request?.method ?? 'SYSTEM'} ${request?.path ?? 'project_session'}`,
    resourceType: 'project_session',
    resourceId: accountId,
    ip: request?.ip ?? null,
    userAgent: request?.userAgent ?? null,
    metadata: {
      limiter: 'concurrent_sessions',
      tier,
      limit,
      active_sessions: activeSessions,
    },
  }).catch((error) => {
    console.error('[projects] Failed to record session cap audit event:', error);
  });

  return {
    status: 429,
    headers: {
      'X-RateLimit-Limit': String(limit),
      'X-RateLimit-Remaining': '0',
    },
    body: {
      error: `You're at your ${limit}-session limit. Close a running session or upgrade for more.`,
      message: `You're at your ${limit}-session limit. Close a running session or upgrade for more.`,
      code: 'concurrent_session_limit',
      limit,
      active_sessions: activeSessions,
    },
  };
}

async function checkConcurrentSessionCap(accountId: string, userId: string, request?: RequestAuditContext): Promise<{
  error?: SessionCreateError;
  headers: Record<string, string>;
}> {
  const tier = await resolveAccountTier(accountId);
  const limit = maxConcurrentSessionsForTier(tier);
  const activeSessions = await countActiveProjectSessions(accountId);
  const remainingAfterCreate = Math.max(limit - activeSessions - 1, 0);
  const headers = {
    'X-RateLimit-Limit': String(limit),
    'X-RateLimit-Remaining': String(remainingAfterCreate),
  };

  if (activeSessions < limit) return { headers };

  const error = await enforceConcurrentSessionCap(accountId, userId, request);
  return {
    headers: error?.headers ?? headers,
    ...(error ? { error } : {}),
  };
}

type SecretRow = typeof projectSecrets.$inferSelect;

/**
 * The per-user view of one secret KEY: the shared/project row (what managers
 * control + who it's shared with) merged with the requesting member's own
 * private override, plus which one actually wins for them at runtime. This is
 * what powers the "use shared / use mine" choice in the UI.
 */
function buildSecretView(input: {
  name: string;
  shared?: SecretRow;
  sharedGrants?: SecretGrant[];
  personal?: SecretRow;
  subject: ShareSubject;
  canManageShared: boolean;
}) {
  const { name, shared, sharedGrants = [], personal, subject, canManageShared } = input;
  const system = isSystemProjectSecretName(name);
  const isGitAuth = name === PROJECT_GIT_AUTH_SECRET_NAME;
  const usableByMe = shared
    ? isSecretUsableBy(shared.shareScope as 'project' | 'restricted', sharedGrants, subject)
    : false;
  const mineActive = Boolean(personal?.active);
  const effectiveSource: 'mine' | 'shared' | 'none' =
    personal && mineActive ? 'mine' : usableByMe ? 'shared' : 'none';
  return {
    name,
    project_id: (shared ?? personal)!.projectId,
    secret_id: shared?.secretId ?? null,
    created_by: shared?.createdBy ?? null,
    created_at: (shared?.createdAt ?? personal?.createdAt)?.toISOString() ?? null,
    updated_at: (shared?.updatedAt ?? personal?.updatedAt)?.toISOString() ?? null,
    system,
    readonly: system,
    purpose: isGitAuth ? 'git_auth' : null,
    can_rotate: isGitAuth,
    managed_by: isGitAuth ? 'project_secret' : null,
    // The SHARED row: is a project value set, who can use it, and can it reach me.
    configured: Boolean(shared),
    share_scope: shared?.shareScope ?? 'project',
    sharing: shared ? scopeToIntent(shared.shareScope as 'project' | 'restricted', sharedGrants) : null,
    usable_by_me: usableByMe,
    // MY private override (value never returned), and whether I'm using it.
    mine: personal ? { active: personal.active, updated_at: personal.updatedAt.toISOString() } : null,
    // What actually gets injected into my sessions for this key.
    effective_source: effectiveSource,
    // Members manage only their own override; managers also manage the shared row.
    can_manage_shared: canManageShared && !system,
  };
}

/**
 * Load every secret KEY in a project as the per-user view (shared + my own
 * override merged). Used by the secrets list + returned after a write.
 */
async function loadSecretViewsForUser(
  projectId: string,
  subject: ShareSubject,
  canManageShared: boolean,
): Promise<ReturnType<typeof buildSecretView>[]> {
  const rows = await db
    .select()
    .from(projectSecrets)
    .where(and(
      eq(projectSecrets.projectId, projectId),
      or(isNull(projectSecrets.ownerUserId), eq(projectSecrets.ownerUserId, subject.userId)),
    ))
    .orderBy(desc(projectSecrets.updatedAt));

  const byName = new Map<string, { shared?: SecretRow; personal?: SecretRow }>();
  for (const row of rows) {
    const slot = byName.get(row.name) ?? {};
    if (row.ownerUserId === null) slot.shared = row;
    else slot.personal = row;
    byName.set(row.name, slot);
  }
  const grants = await loadGrants(rows.filter((r) => r.ownerUserId === null).map((r) => r.secretId));

  return [...byName.entries()].map(([name, slot]) =>
    buildSecretView({
      name,
      shared: slot.shared,
      sharedGrants: slot.shared ? grants.get(slot.shared.secretId) ?? [] : [],
      personal: slot.personal,
      subject,
      canManageShared,
    }),
  );
}

function isSystemProjectSecretName(name: string): boolean {
  return name.toUpperCase().startsWith('KORTIX_');
}

function serializeSessionSandboxConfig(configValue: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const config = { ...(configValue ?? {}) };
  delete config.serviceKey;
  return config;
}

function serializeGitHubInstallation(
  row: typeof accountGithubInstallations.$inferSelect | null,
  accountId: string,
  installUrl: string | null,
) {
  const installed = Boolean(row);
  const metadata = normalizeJsonObject(row?.metadata);
  // GitHub backing is App-only: a per-account App installation is required
  // whenever the App is configured and this account hasn't installed it yet.
  const requiresInstallation = isGithubAppConfigured() && !installed;
  return {
    account_id: accountId,
    installation_row_id: row?.installationRowId ?? null,
    installed,
    configured: isGithubAppConfigured(),
    requires_installation: requiresInstallation,
    install_url: installed ? null : installUrl,
    installation_id: row?.installationId ?? null,
    owner_login: row?.ownerLogin ?? null,
    owner_type: row?.ownerType ?? null,
    repository_selection: row?.repositorySelection ?? null,
    permissions: row?.permissions ?? {},
    installation_url: normalizeString(metadata.html_url),
    updated_at: row?.updatedAt.toISOString() ?? null,
  };
}

function serializeGitHubInstallations(
  rows: Array<typeof accountGithubInstallations.$inferSelect>,
  accountId: string,
  installUrl: string | null,
) {
  const primary = rows[0] ?? null;
  const base = serializeGitHubInstallation(primary, accountId, installUrl);
  return {
    ...base,
    installed: rows.length > 0,
    requires_installation: isGithubAppConfigured() && rows.length === 0,
    install_url: installUrl,
    installations: rows.map((row) => serializeGitHubInstallation(row, accountId, null)),
  };
}

function normalizeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeJsonObject(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}

function normalizeRepoUrl(value: unknown): string | null {
  const repoUrl = normalizeString(value);
  if (!repoUrl) return null;
  const normalized = repoUrl.replace(/\/+$/, '');
  if (/^http:\/\//i.test(normalized)) {
    throw new Error('repo_url must use HTTPS or git@github.com SSH');
  }
  if (!parseGitHubRepoUrl(normalized)) {
    throw new Error('repo_url must be a GitHub repository URL');
  }
  return normalized;
}

function hasOwn(body: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key);
}

function deriveKortixApiRoot(kortixUrl: string): string {
  return (kortixUrl || 'https://api.kortix.com')
    .replace(/\/+$/, '')
    .replace(/\/v1\/router$/, '')
    .replace(/\/v1$/, '');
}

function deriveProjectName(repoUrl: string): string {
  const cleaned = repoUrl.replace(/\/+$/, '').replace(/\.git$/, '');
  const tail = cleaned.split(/[/:]/).filter(Boolean).pop();
  if (!tail) return 'Untitled Project';
  return tail
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

async function readBody(c: Context) {
  try {
    return await c.req.json<Record<string, unknown>>();
  } catch {
    return {};
  }
}

async function getAccountMembership(userId: string, accountId: string) {
  const [membership] = await db
    .select({ accountId: accountMembers.accountId, accountRole: accountMembers.accountRole })
    .from(accountMembers)
    .where(and(eq(accountMembers.userId, userId), eq(accountMembers.accountId, accountId)))
    .limit(1);
  return membership ?? null;
}

async function listAccountGitHubInstallations(accountId: string) {
  return await db
    .select()
    .from(accountGithubInstallations)
    .where(eq(accountGithubInstallations.accountId, accountId));
}

async function getAccountGitHubInstallation(accountId: string, installationId?: string | null) {
  const rows = await listAccountGitHubInstallations(accountId);
  if (installationId) {
    return rows.find((row) => row.installationId === installationId) ?? null;
  }
  return rows[0] ?? null;
}

async function createGitHubInstallationInstallUrl(accountId: string, userId: string): Promise<string | null> {
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

async function consumeGitHubInstallationState(input: {
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

class GitHubInstallationRequiredError extends Error {
  constructor(public readonly accountId: string) {
    super('GitHub App installation required for this account');
  }
}

async function resolveGitHubRepoAuth(accountId: string, installationId?: string | null): Promise<{
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

interface ProjectGitRemote {
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

async function getProjectGitConnection(projectId: string): Promise<ProjectGitConnectionRow | null> {
  const [row] = await db
    .select()
    .from(projectGitConnections)
    .where(eq(projectGitConnections.projectId, projectId))
    .limit(1);
  return row ?? null;
}

async function upsertProjectGitConnection(input: {
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

async function getProjectGitCredential(
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

async function upsertProjectGitCredential(input: {
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

function emptyGitRemote(): ProjectGitRemote {
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

function getProjectGitRemote(project: ProjectRow, connection?: ProjectGitConnectionRow | null): ProjectGitRemote {
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
function resolveUpstreamUrl(project: ProjectRow, remote: ProjectGitRemote): string {
  if (remote.upstreamUrl) return remote.upstreamUrl;
  if (remote.provider === 'github' && remote.repoOwner && remote.repoName) {
    return `https://github.com/${remote.repoOwner}/${remote.repoName}.git`;
  }
  return project.repoUrl;
}

/** Provider-neutral connection ref consumed by git backends. */
function buildConnectionRef(project: ProjectRow, remote: ProjectGitRemote): GitConnectionRef {
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

async function hasServerManagedGitAuth(project: ProjectRow): Promise<boolean> {
  const remote = getProjectGitRemote(project, await getProjectGitConnection(project.projectId));
  if (remote.provider === 'github' && remote.authMethod === 'github_app') {
    return true;
  }
  return false;
}

async function resolveProjectGitAuth(project: ProjectRow): Promise<{
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

async function getProjectMemberRole(projectId: string, userId: string): Promise<ProjectRole | null> {
  const [row] = await db
    .select({ projectRole: projectMembers.projectRole })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
    .limit(1);
  return (row?.projectRole as ProjectRole | undefined) ?? null;
}

async function grantProjectRole(input: {
  accountId: string;
  projectId: string;
  userId: string;
  role: ProjectRole;
  grantedBy: string;
  /** undefined = leave as-is on update / NULL on insert; null = clear
   *  any existing expiry; Date = set/replace the expiry. */
  expiresAt?: Date | null | undefined;
}) {
  const now = new Date();
  await db
    .insert(projectMembers)
    .values({
      accountId: input.accountId,
      projectId: input.projectId,
      userId: input.userId,
      projectRole: input.role,
      grantedBy: input.grantedBy,
      expiresAt: input.expiresAt ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [projectMembers.projectId, projectMembers.userId],
      set: {
        projectRole: input.role,
        grantedBy: input.grantedBy,
        updatedAt: now,
        // Only overwrite expires_at when the caller explicitly supplied
        // it (undefined preserves the existing value).
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      },
    });
}

/**
 * Parse + validate an optional `expires_at` ISO string from a request
 * body. undefined = caller didn't set; null = clear; Date = set.
 * Rejects past timestamps to surface mistakes at write time.
 */
function parseExpiresAtBody(
  raw: unknown,
): { ok: true; value: Date | null | undefined } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string')
    return { ok: false, error: 'expires_at must be an ISO-8601 string or null' };
  const d = new Date(raw);
  if (Number.isNaN(d.getTime()))
    return { ok: false, error: 'expires_at must be a valid ISO-8601 timestamp' };
  if (d.getTime() < Date.now())
    return { ok: false, error: 'expires_at must be in the future' };
  return { ok: true, value: d };
}

async function ensureOrgMembership(
  accountId: string,
  userId: string,
): Promise<AccountRole> {
  const existing = await getAccountMembership(userId, accountId);
  if (existing) return existing.accountRole as AccountRole;
  await db
    .insert(accountMembers)
    .values({ userId, accountId, accountRole: 'member' })
    .onConflictDoNothing();
  return 'member';
}

async function lookupEmailsByUserIds(userIds: string[]): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  if (userIds.length === 0) return result;
  const supabase = getSupabase();
  await Promise.all(
    userIds.map(async (uid) => {
      try {
        const { data } = await supabase.auth.admin.getUserById(uid);
        result.set(uid, data?.user?.email ?? null);
      } catch {
        result.set(uid, null);
      }
    }),
  );
  return result;
}

async function resolveProjectAccount(c: Context, body?: Record<string, unknown>) {
  const userId = c.get('userId') as string;
  const requested = normalizeString(
    c.req.query('account_id') ??
    c.req.query('accountId') ??
    body?.account_id ??
    body?.accountId,
  );
  const accountId = requested ?? await resolveAccountId(userId);

  const membership = await getAccountMembership(userId, accountId);
  if (!membership) {
    throw new HTTPException(403, { message: 'You do not have access to this account' });
  }
  (c as any).set('accountId', membership.accountId);

  return {
    userId,
    accountId: membership.accountId,
    accountRole: membership.accountRole as AccountRole,
  };
}

// Maps the high-level project access action onto the IAM action key
// the engine recognises. Keep this narrow — these three labels cover
// every gate this file uses; bespoke actions (project.trigger.fire,
// project.deploy, project.secrets.write, etc.) should call authorize()
// directly with the exact action.
function iamActionForProjectAccess(action: ProjectAccessAction): string {
  switch (action) {
    case 'read':
      return 'project.read';
    case 'write':
      return 'project.write';
    case 'manage':
      // 'manage' historically meant "admin-tier write" — covers triggers,
      // secrets, snapshots, CLI tokens, etc. Map to project.write (which
      // Project Editor has) so editors aren't accidentally locked out.
      // Routes that need the stricter `project.members.manage` gate add
      // an explicit assertAuthorized() on top of loadProjectForUser.
      return 'project.write';
  }
}

async function resolveGitHubImport(input: {
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

async function registerGitHubLinkedProject(input: {
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
async function resolveGitHubImportWithPat(input: {
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
async function registerPatLinkedProject(input: {
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

async function loadProjectForUser(c: Context, projectId: string, action: ProjectAccessAction) {
  const userId = c.get('userId') as string;
  const [row] = await db
    .select()
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);
  if (!row || row.status === 'archived') return null;

  const membership = await getAccountMembership(userId, row.accountId);
  if (!membership) {
    throw new HTTPException(403, { message: 'You do not have access to this account' });
  }

  const accountRole = membership.accountRole as AccountRole;
  const projectRole = await getProjectMemberRole(projectId, userId);

  // Ask the IAM engine for the real verdict. V2 consults super-admin,
  // account role, direct project membership, group project grants, and
  // account-wide MFA. It no longer evaluates V1 policies or conditions.
  const actingTokenId =
    ((c as unknown as { get(k: string): unknown }).get('iamTokenId') as
      | string
      | undefined) ?? undefined;
  const requestCtx = deriveRequestContext(c);
  const verdict = await authorize(
    userId,
    row.accountId,
    iamActionForProjectAccess(action),
    { type: 'project', id: projectId },
    actingTokenId,
    requestCtx,
  );
  if (!verdict.allowed) {
    // Distinguish "no access at all" from "has access but not for this
    // action" so the UI can show a meaningful message. A Viewer can see
    // the project but can't create a session — telling them "no access"
    // is misleading and they spend time wondering why they can see the
    // page at all. Only do the second probe when the failed action was
    // NOT already 'read' — otherwise it's the same answer.
    if (action !== 'read') {
      const readVerdict = await authorize(
        userId,
        row.accountId,
        'project.read',
        { type: 'project', id: projectId },
        actingTokenId,
        requestCtx,
      );
      if (readVerdict.allowed) {
        const verb = action === 'manage' ? 'manage this project' : 'change this project';
        throw new HTTPException(403, {
          message: `Your role on this project doesn't let you ${verb}. Ask a project Manager to grant you a higher role.`,
        });
      }
    }
    throw new HTTPException(403, { message: 'You do not have access to this project' });
  }

  // effectiveRole label for the UI / downstream helpers. The engine
  // doesn't hand back a role — it answers yes/no. Mirror the prior
  // mapping so any code reading effectiveRole still gets sensible
  // labels: owner/admin → manager, explicit project_members row →
  // that role, otherwise → 'viewer' (the engine permitted read but
  // we don't know the exact tier).
  const effectiveRole =
    effectiveProjectRole(accountRole, projectRole) ?? 'viewer';
  (c as any).set('accountId', row.accountId);

  // Presence signal for the warm pool: an authenticated user touching the
  // project (loading it, polling its sessions) means they're around and likely
  // to start a session — keep a warm box ready. No-op unless the pool is on;
  // throttled internally. Only members who can launch sessions count.
  if (action !== 'read' || roleAllows(effectiveRole as ProjectRole, 'write')) {
    notePoolPresence(projectId);
  }

  return {
    row,
    userId,
    accountRole,
    projectRole,
    effectiveRole: effectiveRole as ProjectRole,
  };
}

// Env names a project secret must NEVER inject into a sandbox — they belong to
// the sandbox's own runtime (the OS, the daemon, opencode). A secret named e.g.
// `PORT` (trivially pushed via `kortix env push --from a-server.env`) would
// override the runtime and break every session. Anything `KORTIX_*`/`OPENCODE_*`
// is platform-owned and set explicitly below.
const RESERVED_SANDBOX_ENV_NAMES = new Set([
  'PORT', 'PATH', 'HOME', 'PWD', 'USER', 'LOGNAME', 'SHELL', 'HOSTNAME',
  'TERM', 'TMPDIR', 'NODE_ENV', 'NODE_OPTIONS', 'LD_PRELOAD', 'LD_LIBRARY_PATH',
]);
function isReservedSandboxEnvName(name: string): boolean {
  return (
    RESERVED_SANDBOX_ENV_NAMES.has(name) ||
    name.startsWith('KORTIX_') ||
    name.startsWith('OPENCODE_')
  );
}

export async function buildSessionSandboxEnvVars(input: {
  accountId: string;
  projectId: string;
  sessionId: string;
  userId: string;
  repoUrl: string;
  baseRef: string;
  agentName: string;
  initialPrompt?: string | null;
  opencodeModel?: string | null;
}): Promise<Record<string, string>> {
  // Only user runtime secrets belong here. The sandbox-scoped KORTIX_TOKEN is
  // minted by provisionSessionSandbox() and injected at the provider boundary,
  // then reused by the daemon for both API calls and proxy HMAC validation.
  // Resolved AS the launching user, so personal overrides win and "Only me" /
  // "Select members" secrets only reach members they're shared with.
  const subject = await resolveShareSubject(input.userId);
  const runtimeSecrets = await listProjectSecretsSnapshotForUser(input.projectId, subject);
  // The Slack signing secret only verifies inbound webhooks (an apps/api job).
  // The in-sandbox agent never needs it — keep it out of the sandbox env.
  delete runtimeSecrets.env.SLACK_SIGNING_SECRET;
  // Guardrail: drop any project secret whose name would clobber the sandbox's
  // own runtime env (PORT/PATH/KORTIX_*/…). Without this, one stray secret
  // silently breaks every session — and `kortix env push` of a server .env
  // makes that a one-command footgun.
  const droppedReserved = Object.keys(runtimeSecrets.env).filter(isReservedSandboxEnvName);
  for (const name of droppedReserved) delete runtimeSecrets.env[name];
  if (droppedReserved.length > 0) {
    console.warn(
      `[session ${input.sessionId}] ignored ${droppedReserved.length} project secret(s) with reserved env names: ${droppedReserved.join(', ')}`,
    );
  }
  return {
    ...runtimeSecrets.env,
    KORTIX_PROJECT_SECRET_NAMES: runtimeSecrets.names.join(','),
    KORTIX_PROJECT_SECRETS_REVISION: runtimeSecrets.revision,
    KORTIX_PROJECT_AUTO_CLONE: '1',
    // Universal proxy origin: when enabled, the sandbox clones via the Kortix
    // git proxy with its own KORTIX_TOKEN — a real host credential never lands
    // in the sandbox. The daemon's credential helper returns KORTIX_TOKEN for
    // the proxy host. OFF → direct clone of the real repo (legacy token flow).
    KORTIX_REPO_URL: config.KORTIX_GIT_PROXY ? proxyGitUrl(input.projectId) : input.repoUrl,
    KORTIX_DEFAULT_BRANCH: input.baseRef,
    KORTIX_BASE_REF: input.baseRef,
    KORTIX_BRANCH_NAME: input.sessionId,
    KORTIX_PROJECT_ID: input.projectId,
    KORTIX_SESSION_ID: input.sessionId,
    KORTIX_SERVICE_PORT: '8000',
    KORTIX_AGENT_NAME: input.agentName,
    KORTIX_API_URL: deriveKortixApiBase(),
    ...(input.initialPrompt
      ? {
          KORTIX_BOOTSTRAP_OPENCODE_SESSION: '1',
          KORTIX_INITIAL_PROMPT: input.initialPrompt,
        }
      : {}),
    // Per-session model override (e.g. Slack turns pin a specific model).
    // The sandbox agent reads this and sets it on every opencode prompt call.
    ...(input.opencodeModel ? { KORTIX_OPENCODE_MODEL: input.opencodeModel } : {}),
  };
}

/** Derive the API v1 base URL sandboxes call as `$KORTIX_API_URL`. */
function deriveKortixApiBase(): string {
  return `${deriveKortixApiRoot(config.KORTIX_URL)}/v1`;
}

/**
 * The Kortix git-proxy origin for a project — the UNIVERSAL client-facing git
 * URL. Clients clone/push this with a Kortix token; the API resolves the real
 * upstream + mints the host credential server-side.
 */
function proxyGitUrl(projectId: string): string {
  return `${deriveKortixApiRoot(config.KORTIX_URL)}/v1/git/${projectId}.git`;
}

/**
 * Cloud sandboxes (the only kind we provision) reach the control plane over the
 * public internet via `$KORTIX_API_URL`. A loopback/unspecified host is never
 * reachable from inside a remote sandbox, so a session booted against one is
 * dead-on-arrival: repo materialization can't fetch its git clone credential and
 * the daemon ends up reporting "OpenCode runtime is not ready" with a cryptic
 * "Unable to connect" boot error ~60s later. Detect it up front so session
 * creation fails fast with an actionable message instead.
 *
 * Returns a human-readable reason string when unreachable, or null when fine.
 */
function sandboxCallbackUnreachableReason(): string | null {
  let host: string;
  try {
    host = new URL(deriveKortixApiBase()).hostname.toLowerCase();
  } catch {
    return `KORTIX_URL is not a valid URL: ${config.KORTIX_URL || '(unset)'}`;
  }
  const isLoopback =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '127.0.0.1' ||
    host.startsWith('127.') ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host === '[::1]';
  if (!isLoopback) return null;
  return (
    `KORTIX_URL points at a loopback address (${config.KORTIX_URL}). ` +
    `Cloud sandboxes run remotely and cannot call back to your machine's localhost, ` +
    `so the agent runtime will never boot. Start the dev tunnel with \`pnpm dev\` ` +
    `(it provisions a public Cloudflare URL automatically and exports it as KORTIX_URL), ` +
    `or set a public KORTIX_URL in apps/api/.env.`
  );
}

export async function createProjectSession(input: {
  project: ProjectRow;
  userId: string;
  body: Record<string, unknown>;
  enforceAccountCap?: boolean;
  metadata?: Record<string, unknown>;
  extraEnvVars?: Record<string, string>;
  request?: RequestAuditContext;
}): Promise<{ row?: ProjectSessionRow; error?: SessionCreateError; headers?: Record<string, string> }> {
  const { project, userId, body } = input;
  const projectId = project.projectId;
  const accountId = project.accountId;

  const baseRef = normalizeString(body.base_ref ?? body.baseRef) ?? project.defaultBranch;
  const agentName = normalizeString(body.agent_name ?? body.agentName) ?? 'default';
  // Explicit request wins; otherwise fall back to the project's default sandbox
  // template (`[sandbox] default` in kortix.toml, synced to project metadata),
  // so EVERY session — UI, triggers, channels — inherits the project's chosen
  // box without each caller passing `sandbox_slug`. Unset → platform default.
  const projectDefaultSandboxSlug = normalizeString(
    (project.metadata as Record<string, unknown> | null | undefined)?.default_sandbox_slug,
  );
  const sandboxSlug =
    normalizeString(body.sandbox_slug ?? body.sandboxSlug) ?? projectDefaultSandboxSlug ?? undefined;
  const requestedProvider = normalizeString(body.provider);
  let providerName: SandboxProviderName = config.getDefaultProvider();
  if (requestedProvider) {
    if (!(config.ALLOWED_SANDBOX_PROVIDERS as readonly string[]).includes(requestedProvider)) {
      return { error: { status: 400, body: { error: `Unknown or disabled sandbox provider: ${requestedProvider}` } } };
    }
    providerName = requestedProvider as SandboxProviderName;
  }

  const callbackUnreachable = providerName === 'local_docker' ? null : sandboxCallbackUnreachableReason();
  if (callbackUnreachable) {
    return { error: { status: 503, body: { error: callbackUnreachable, code: 'KORTIX_URL_UNREACHABLE' } } };
  }

  // Validate the requested sandbox template up front so the user gets a clean
  // 400 instead of an async session-failed if they typed a slug that doesn't
  // exist. The platform default is always valid.
  if (sandboxSlug && sandboxSlug !== DEFAULT_SANDBOX_SLUG) {
    try {
      await resolveTemplate(
        {
          projectId,
          repoUrl: project.repoUrl,
          defaultBranch: project.defaultBranch,
          manifestPath: project.manifestPath,
          gitAuthToken: null,
        },
        sandboxSlug,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        error: {
          status: 400,
          body: { error: message, code: 'UNKNOWN_SANDBOX_TEMPLATE' },
        },
      };
    }
  }

  let responseHeaders: Record<string, string> | undefined;

  if (input.enforceAccountCap !== false) {
    const capResult = await checkConcurrentSessionCap(accountId, userId, input.request);
    responseHeaders = capResult.headers;
    if (capResult.error) return { error: capResult.error };
  }

  const billingCheck = await checkBillingActive(accountId);
  if (!billingCheck.ok) {
    return {
      error: {
        status: 402,
        body: {
          error: billingCheck.message,
          message: billingCheck.message,
          code: billingCheck.reason,
          balance: billingCheck.balance,
        },
      },
    };
  }

  const requestedSessionId = normalizeString(body.session_id ?? body.sessionId);
  if (requestedSessionId && !UUID_V4_REGEX.test(requestedSessionId)) {
    return { error: { status: 400, body: { error: 'Invalid session id' } } };
  }
  const sessionId = requestedSessionId ?? randomUUID();
  const branchAlreadyCreated =
    body.branch_already_created === true ||
    body.branchAlreadyCreated === true;

  const initialPrompt = normalizeString(body.initial_prompt ?? body.initialPrompt);
  const opencodeModel = normalizeString(body.opencode_model ?? body.opencodeModel);
  const sessionName = normalizeString(body.name);
  const requestMetadata = normalizeJsonObject(body.metadata);
  const metadata = {
    ...requestMetadata,
    ...(sessionName ? { name: sessionName } : {}),
    ...(initialPrompt ? { initial_prompt: initialPrompt } : {}),
    ...(opencodeModel ? { opencode_model: opencodeModel } : {}),
    ...(input.metadata ?? {}),
  };

  // ── Warm-pool fast path ───────────────────────────────────────────────────
  // ALWAYS try to claim a warm sandbox first — parked (instant) or, failing
  // that, one already booting (it has a head start, so the session reaches
  // ready far sooner than a fresh cold boot). Claiming skips provisioning: the
  // box already cloned base, created branch W, and is warming opencode. The
  // session id IS the warm box's id (W), preserving session_id==sandbox_id==
  // branch. Guards keep this to the interactive default path (everything else
  // falls through to cold): default template + provider (warm boxes boot the
  // default), no server-side initial_prompt (it flows via the post-nav chat
  // path). The claim SQL also matches only boxes booted for this user (owner),
  // so per-user executor/LLM tokens stay correct.
  // Warm boxes boot from the platform default snapshot, so a session targeting
  // the default template (unset OR the reserved "default" slug — the UI's "New
  // session" button sends "default") can claim them. A *custom* template can't.
  const wantsDefaultSandbox = !sandboxSlug || sandboxSlug === DEFAULT_SANDBOX_SLUG;
  if (warmPoolEnabled() && providerName === config.getDefaultProvider() && wantsDefaultSandbox && !initialPrompt) {
    const claimed = await claimWarmSandbox({ projectId, userId }).catch((err) => {
      console.warn(`[warm-pool] claim failed for ${projectId}:`, err instanceof Error ? err.message : err);
      return null;
    });
    if (!claimed) {
      // Pool was empty (cold miss) — start warming one now so the *next* create
      // rides it. Fire-and-forget; the cold path below handles this session.
      void refillProjectPool(projectId).catch(() => {});
    }
    if (claimed) {
      const W = claimed.sandboxId;
      try {
        const [row] = await db
          .insert(projectSessions)
          .values({
            sessionId: W,
            accountId,
            projectId,
            branchName: W,
            baseRef,
            sandboxProvider: providerName,
            sandboxId: W,
            agentName,
            status: 'provisioning',
            createdBy: userId,
            visibility: 'private',
            // Pin the opencode session pre-created at park time so the client
            // skips the ensure-opencode round-trip → chat usable immediately.
            opencodeSessionId: claimed.opencodeSessionId ?? undefined,
            metadata: { ...metadata, warm_pool_claimed: true },
            updatedAt: new Date(),
          })
          .returning();
        // Fast-forward the claimed box to the latest base tip (it cloned base
        // when it parked, which may now be stale) + refill the pool. Both
        // fire-and-forget so the create returns immediately.
        void syncClaimedBoxToBase(claimed.externalId, userId).catch(() => {});
        void refillProjectPool(projectId).catch(() => {});
        return { row, headers: responseHeaders };
      } catch (err) {
        // Insert raced/failed — recycle the box and fall through to cold path.
        await db
          .update(sessionSandboxes)
          .set({ poolState: 'reap', updatedAt: new Date() })
          .where(eq(sessionSandboxes.sandboxId, W))
          .catch(() => {});
        console.warn(`[warm-pool] claimed-session insert failed; recycling ${W.slice(0, 8)}:`, err instanceof Error ? err.message : err);
      }
    }
  }

  let sessionRow: ProjectSessionRow;
  try {
    const [row] = await db
      .insert(projectSessions)
      .values({
        sessionId,
        accountId,
        projectId,
        branchName: sessionId,
        baseRef,
        sandboxProvider: providerName,
        sandboxId: sessionId,
        agentName,
        status: 'provisioning',
        // Sessions are private to their creator by default; share via the
        // session-header control (visibility = project | restricted).
        createdBy: userId,
        visibility: 'private',
        metadata,
        updatedAt: new Date(),
      })
      .returning();
    sessionRow = row;
  } catch (error) {
    // (project_id, branch_name) unique index + PK on session_id mean a
    // randomUUID() collision is the only realistic insert failure here.
    const message = (error as Error).message || 'Insert failed';
    return { error: { status: 500, body: { error: message, retry: true } } };
  }

  // Fire-and-forget sandbox provisioning. The dashboard polls the sandbox
  // status endpoint and shows the ConnectingScreen during the long tail.
  void (async () => {
    const tl = new ProvisionTimeline(sessionId, 'session-create');
    try {
      // Resolve git auth and user env concurrently. Git auth is needed for
      // background freshness checks / remote branch publishing, but a warm
      // session can boot from an existing ready snapshot without waiting for it.
      const gitAuthPromise = resolveProjectGitAuth(project).then((gitAuth) => {
        tl.mark('git-auth');
        return gitAuth;
      });
      const projectWithGitAuthPromise = gitAuthPromise.then((gitAuth) => ({
        ...project,
        gitAuthToken: gitAuth.auth?.token ?? null,
      }));
      const envPromise = buildSessionSandboxEnvVars({
        accountId,
        projectId,
        sessionId,
        userId,
        repoUrl: project.repoUrl,
        baseRef,
        agentName,
        initialPrompt,
        opencodeModel,
      }).then((envVars) => {
        tl.mark('env-vars');
        return envVars;
      });

      const mergeSessionMetadata = async (extra: Record<string, unknown>) => {
        const [current] = await db
          .select({ metadata: projectSessions.metadata })
          .from(projectSessions)
          .where(eq(projectSessions.sessionId, sessionId))
          .limit(1);
        const currentMetadata =
          current?.metadata && typeof current.metadata === 'object'
            ? (current.metadata as Record<string, unknown>)
            : {};
        await db
          .update(projectSessions)
          .set({
            metadata: { ...currentMetadata, ...extra },
            updatedAt: new Date(),
          })
          .where(eq(projectSessions.sessionId, sessionId));
      };

      // Origin branch creation is publishing work, not readiness work. The
      // sandbox now creates the session branch locally from the base checkout
      // immediately, so this remote push runs fully in the background. The
      // metadata writes that record success/failure are pure telemetry —
      // fire-and-forget so they never block the IIFE itself.
      const branchPromise: Promise<void> = branchAlreadyCreated
        ? Promise.resolve()
        : projectWithGitAuthPromise.then((projectWithGitAuth) =>
            createRemoteSessionBranch(projectWithGitAuth, sessionId, baseRef),
          ).then(() => {
            tl.mark('branch-pushed');
            void mergeSessionMetadata({
              remote_branch: { status: 'ready', branch: sessionId, updated_at: new Date().toISOString() },
            }).catch(() => {});
          });
      branchPromise.catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[projects] Remote branch creation failed for session ${sessionId}:`, err);
        void mergeSessionMetadata({
          remote_branch: {
            status: 'failed',
            branch: sessionId,
            error: message.slice(0, 500),
            updated_at: new Date().toISOString(),
          },
        }).catch(() => {});
      });

      const extraEnvVars = {
        ...(await envPromise),
        ...(input.extraEnvVars ?? {}),
      };

      const provisionPromise = provisionSessionSandbox({
        sandboxId: sessionId,
        accountId,
        projectId,
        userId,
        provider: providerName,
        metadata: { session_id: sessionId, project_id: projectId, ...(input.metadata ?? {}) },
        extraEnvVars,
        gitProject: {
          projectId,
          repoUrl: project.repoUrl,
          defaultBranch: project.defaultBranch,
          manifestPath: project.manifestPath,
          gitAuthToken: null,
        },
        resolveGitAuthToken: async () => (await gitAuthPromise).auth?.token ?? null,
        baseRef,
        sandboxSlug,
      });

      // provisionSessionSandbox returns once its row is inserted; provider
      // create and remote branch push both continue in detached background work.
      await provisionPromise;
      tl.mark('kicked');
      const sessionStartTimeline = tl.summary();
      // Fire-and-forget: the timeline write is pure telemetry. Awaiting it
      // here used to add ~30-80ms of DB round-trip to every session start.
      void mergeSessionMetadata({ session_start_timeline: sessionStartTimeline }).catch(() => {});
    } catch (err) {
      const message = (err as Error)?.message || 'Sandbox provisioning failed';
      console.error(`[projects] Failed to kick off sandbox for session ${sessionId}:`, err);
      try {
        await db
          .update(projectSessions)
          .set({
            status: 'failed',
            error: message,
            metadata: { ...metadata, provisioning_error: message },
            updatedAt: new Date(),
          })
          .where(eq(projectSessions.sessionId, sessionId));
      } catch (markErr) {
        console.error(`[projects] Failed to mark session ${sessionId} failed:`, markErr);
      }
    }
  })();

  return { row: sessionRow, headers: responseHeaders };
}

function normalizeSignatureHeader(value: string | null): string | null {
  const header = normalizeString(value);
  if (!header) return null;
  return header.startsWith('sha256=') ? header.slice('sha256='.length) : header;
}

function verifyWebhookSignature(rawBody: string, secret: string, signatureHeader: string | null) {
  const signature = normalizeSignatureHeader(signatureHeader);
  if (!signature || !/^[a-f0-9]{64}$/i.test(signature)) return false;

  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const actualBuffer = Buffer.from(signature, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

function parseWebhookJsonBody(rawBody: string): unknown {
  if (!rawBody.trim()) return {};
  try {
    return JSON.parse(rawBody);
  } catch {
    return { raw: rawBody };
  }
}

function valueAtPath(source: unknown, path: string[]): unknown {
  let current = source;
  for (const segment of path) {
    if (!isPlainObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function templateValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function renderPromptTemplate(template: string, payload: Record<string, unknown>) {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, token: string) => {
    const [root, ...path] = token.split('.');
    if (!root) return '';
    const value = path.length === 0 ? payload[root] : valueAtPath(payload[root], path);
    return templateValue(value);
  });
}

function webhookPayload(c: Context, rawBody: string) {
  const body = parseWebhookJsonBody(rawBody);
  return {
    body,
    headers: {
      content_type: c.req.header('content-type') ?? null,
      user_agent: c.req.header('user-agent') ?? null,
      forwarded_for: c.req.header('x-forwarded-for') ?? null,
    },
  };
}

function triggerBackpressureLimit() {
  const configured = Number(config.KORTIX_TRIGGER_MAX_PROVISIONING_SESSIONS_PER_PROJECT);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 3;
}

async function triggerBackpressureState(accountId: string, projectId: string) {
  const [provisioning, active, tier] = await Promise.all([
    countProvisioningProjectSessions(projectId),
    countActiveProjectSessions(accountId),
    resolveAccountTier(accountId),
  ]);
  const projectProvisioningLimit = triggerBackpressureLimit();
  const accountActiveLimit = maxConcurrentSessionsForTier(tier);
  return {
    shouldQueue: provisioning >= projectProvisioningLimit || active >= accountActiveLimit,
    provisioning,
    projectProvisioningLimit,
    active,
    accountActiveLimit,
    tier,
  };
}

// POST /v1/webhooks/projects/:projectId/:slug
//
// Public fire endpoint for GIT-BACKED webhook triggers. The trigger config
// lives in `.opencode/triggers/<slug>.md` in the project repo; the signing
// secret lives in `project_secrets` (referenced from the file via
// `secret_env`). On a valid signed POST, we render the prompt template and
// spawn a session — same as the DB-backed `/v1/webhooks/:triggerId` path,
// but the source of truth is git.
projectWebhooksApp.post('/projects/:projectId/:slug', async (c) => {
  const projectId = c.req.param('projectId');
  const slug = c.req.param('slug');
  if (!UUID_V4_REGEX.test(projectId)) return c.json({ error: 'Invalid project id' }, 400);
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(slug)) {
    return c.json({ error: 'Invalid trigger slug' }, 400);
  }

  const [project] = await db
    .select()
    .from(projects)
    .where(and(
      eq(projects.projectId, projectId),
      eq(projects.status, 'active'),
    ))
    .limit(1);
  if (!project) return c.json({ error: 'Not found' }, 404);

  const { specs } = await loadProjectTriggers(await withProjectGitAuth(project));
  const spec = specs.find((s) => s.slug === slug);
  if (!spec || spec.type !== 'webhook' || !spec.enabled) {
    return c.json({ error: 'Not found' }, 404);
  }

  const rawBody = await c.req.text();
  const secret = spec.secretEnv
    ? await getProjectSecretValue(project.projectId, spec.secretEnv)
    : null;
  if (!secret) {
    return c.json({ error: 'Webhook secret is not configured' }, 409);
  }

  const signatureHeader =
    c.req.header('x-kortix-signature') || c.req.header('x-hub-signature-256') || null;
  if (!verifyWebhookSignature(rawBody, secret, signatureHeader)) {
    return c.json({ error: 'Invalid webhook signature' }, 401);
  }

  (c as any).set('accountId', project.accountId);

  const payload = {
    ...webhookPayload(c, rawBody),
    trigger: { slug: spec.slug, type: spec.type, kind: 'git' },
    fired_at: new Date().toISOString(),
  };
  const renderedPrompt = renderPromptTemplate(spec.promptTemplate, payload);

  const result = await fireGitTrigger({
    spec,
    project,
    payload,
    renderedPrompt,
    source: 'webhook',
    request: requestAuditContext(c),
  });

  if (result.status === 'queued') {
    return c.json({ status: 'queued', reason: result.reason ?? null }, 202);
  }
  if (result.status === 'failed') {
    return c.json({ error: result.error ?? 'Failed to fire trigger' }, 500);
  }
  // Stamp runtime last_fired_at so the UI's "last fired N ago" matches the
  // cron-fire path even when the webhook is the actual source.
  await markGitTriggerFired(project.projectId, spec.slug, new Date());
  return c.json({ status: 'fired', session_id: result.sessionId ?? null }, 202);
});

type TriggerSchedulerTimer = ReturnType<typeof setInterval>;

const globalForProjectTriggers = globalThis as typeof globalThis & {
  __kortixProjectTriggerSchedulerTimer?: TriggerSchedulerTimer | null;
};

let triggerSchedulerTimer: TriggerSchedulerTimer | null = null;
let triggerSweepRunning = false;

// Connector reconcile sweep — runs on a slower cadence than the trigger sweep.
let connectorSweepRunning = false;
let lastConnectorSweepAt = 0;
function connectorSweepIntervalMs() {
  const raw = Number(config.KORTIX_CONNECTOR_SWEEP_INTERVAL_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 120_000;
}

function triggerSchedulerIntervalMs() {
  const raw = Number(config.KORTIX_TRIGGER_SCHEDULER_INTERVAL_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 60_000;
}

function nextCronRun(schedule: string, from: Date, timezone?: string): Date | null {
  const job = new Cron(schedule, { paused: true, ...(timezone ? { timezone } : {}) });
  return job.nextRun(from);
}

/**
 * Walks every active project's git repo for `.opencode/triggers/*.md` and
 * fires due cron triggers. Triggers are 100% file-defined now (kortix.toml);
 * the old DB-backed trigger tables have been removed.
 */
export async function runProjectTriggerSweep(now = new Date()): Promise<{
  scanned: number;
  fired: number;
  queued: number;
  failed: number;
  skipped: number;
}> {
  if (triggerSweepRunning) return { scanned: 0, fired: 0, queued: 0, failed: 0, skipped: 0 };
  triggerSweepRunning = true;
  const result = { scanned: 0, fired: 0, queued: 0, failed: 0, skipped: 0 };
  try {
    await runGitTriggerSweep(now, result);
    return result;
  } catch (err) {
    console.error('[project-triggers/git] sweep failed', err);
    return result;
  } finally {
    triggerSweepRunning = false;
  }
}

/**
 * Reconcile every active project's connector DB cache against its kortix.toml.
 * This is the reliability backstop for connectors: the UI CRUD path and the
 * CR-merge hook reconcile inline, but a raw `git push` / `kortix` CLI edit that
 * bypasses both is only caught here. We invalidate the git mirror per project
 * so an out-of-band manifest edit is seen this sweep (not up to a minute later,
 * behind the mirror refresh throttle). `syncProjectConnectors` is hash-aware,
 * so unchanged connectors cost a manifest read, not a catalog re-fetch.
 */
async function runProjectConnectorSweep(): Promise<{ scanned: number; synced: number; errors: number }> {
  if (connectorSweepRunning) return { scanned: 0, synced: 0, errors: 0 };
  connectorSweepRunning = true;
  const out = { scanned: 0, synced: 0, errors: 0 };
  try {
    const { syncProjectConnectors } = await import('../executor/sync');
    const projectsForSweep = await db
      .select()
      .from(projects)
      .where(eq(projects.status, 'active'))
      .limit(200);
    for (const project of projectsForSweep) {
      out.scanned += 1;
      try {
        invalidateProjectMirror(project.projectId);
        const res = await syncProjectConnectors(project.projectId, project.accountId);
        out.synced += res.synced;
        out.errors += res.errors.length;
      } catch (err) {
        out.errors += 1;
        console.warn('[project-connectors] sweep failed', project.projectId, err instanceof Error ? err.message : err);
      }
    }
    return out;
  } finally {
    connectorSweepRunning = false;
  }
}

// ─── Git-backed triggers ────────────────────────────────────────────────────
//
// Triggers can ALSO live in the project repo at `.opencode/triggers/<slug>.md`
// — see ./triggers.ts for the file format. The repo is the source of truth
// for config (cron expr, prompt, secret_env reference). Runtime state
// (last_fired_at) lives in `project_trigger_runtime` because writing the
// repo on every fire would amplify a 5s scheduler tick into a flood of
// git commits.

/**
 * Find a user we can attribute trigger-spawned sessions to. Git-backed
 * triggers don't have a `created_by` like the DB-backed ones do — we pick
 * the account's first owner as a stable, audit-friendly stand-in.
 */
export async function resolveGitTriggerActor(accountId: string): Promise<string | null> {
  const [row] = await db
    .select({ userId: accountMembers.userId })
    .from(accountMembers)
    .where(and(
      eq(accountMembers.accountId, accountId),
      eq(accountMembers.accountRole, 'owner'),
    ))
    .limit(1);
  return row?.userId ?? null;
}

function isGitCronSpecDue(spec: GitTriggerSpec, lastFiredAt: Date | null, now: Date): boolean {
  // One-off ("run once") schedules: fire exactly once at/after `runAt`. The
  // last_fired_at stamp written on the first fire keeps it dormant forever
  // after — no cron, no self-disable needed.
  if (spec.runAt) {
    if (lastFiredAt) return false;
    const at = Date.parse(spec.runAt);
    return !Number.isNaN(at) && at <= now.getTime();
  }
  if (!spec.cron) return false;
  try {
    const baseline = lastFiredAt ?? new Date(0);
    const next = nextCronRun(spec.cron, baseline, spec.timezone);
    return Boolean(next && next.getTime() <= now.getTime());
  } catch {
    return false;
  }
}

async function getGitTriggerRuntime(projectId: string, slug: string) {
  const [row] = await db
    .select()
    .from(projectTriggerRuntime)
    .where(and(
      eq(projectTriggerRuntime.projectId, projectId),
      eq(projectTriggerRuntime.slug, slug),
    ))
    .limit(1);
  return row ?? null;
}

async function markGitTriggerFired(projectId: string, slug: string, when: Date) {
  await db
    .insert(projectTriggerRuntime)
    .values({ projectId, slug, lastFiredAt: when, updatedAt: when })
    .onConflictDoUpdate({
      target: [projectTriggerRuntime.projectId, projectTriggerRuntime.slug],
      set: { lastFiredAt: when, updatedAt: when },
    });
}

/**
 * Fire a git-backed trigger. Triggers are file-defined (kortix.toml), so there
 * is no DB trigger/event row — the project_sessions row carries `trigger_slug`
 * in metadata so audits can still reconstruct the firing path.
 */
async function fireGitTrigger(input: {
  spec: GitTriggerSpec;
  project: ProjectRow;
  payload: Record<string, unknown>;
  renderedPrompt: string;
  source: 'cron' | 'webhook' | 'manual';
  request?: RequestAuditContext;
}): Promise<{ status: 'fired' | 'queued' | 'failed'; sessionId?: string; error?: string; reason?: string }> {
  const { spec, project, payload, renderedPrompt, source } = input;
  const backpressure = await triggerBackpressureState(project.accountId, project.projectId);

  if (backpressure.shouldQueue) {
    return {
      status: 'queued',
      reason: backpressure.provisioning >= backpressure.projectProvisioningLimit
        ? 'project provisioning backpressure'
        : 'account session cap',
    };
  }

  const actor = await resolveGitTriggerActor(project.accountId);
  if (!actor) {
    return { status: 'failed', error: 'No account owner available to own the session' };
  }

  const sessionResult = await createProjectSession({
    project,
    userId: actor,
    enforceAccountCap: false,
    request: input.request,
    body: {
      agent_name: spec.agent,
      initial_prompt: renderedPrompt,
      metadata: {
        trigger_source: source,
        trigger_kind: 'git',
        trigger_slug: spec.slug,
        trigger_type: spec.type,
      },
    },
    metadata: {
      trigger_source: source,
      trigger_kind: 'git',
      trigger_slug: spec.slug,
      trigger_type: spec.type,
      payload_summary: summarizeTriggerPayload(payload),
    },
  });

  if (sessionResult.error) {
    return {
      status: 'failed',
      error: String(sessionResult.error.body.error ?? 'Failed to create trigger session'),
    };
  }
  return { status: 'fired', sessionId: sessionResult.row!.sessionId };
}

function summarizeTriggerPayload(payload: Record<string, unknown>): Record<string, unknown> {
  // Strip the rendered body from session metadata — sessions already get the
  // prompt as KORTIX_INITIAL_PROMPT, and we don't want huge payloads in
  // postgres jsonb.
  const { rendered_body: _r, ...rest } = payload as Record<string, unknown>;
  return rest;
}

/**
 * Walk all active projects, load their git-backed triggers, and fire any
 * cron triggers that are due. Runtime state (last_fired_at) lives in
 * `project_trigger_runtime`, keyed by project + slug.
 *
 * We swallow per-project errors so one busted repo can't break the sweep
 * for everyone else.
 */
async function runGitTriggerSweep(now: Date, accumulator: {
  scanned: number; fired: number; queued: number; failed: number; skipped: number;
}): Promise<void> {
  const projectsForSweep = await db
    .select()
    .from(projects)
    .where(eq(projects.status, 'active'))
    .limit(200);

  for (const project of projectsForSweep) {
    let specs: GitTriggerSpec[];
    try {
      const loaded = await loadProjectTriggers(await withProjectGitAuth(project));
      specs = loaded.specs;
    } catch (err) {
      console.warn('[project-triggers/git] load failed', project.projectId, err instanceof Error ? err.message : err);
      continue;
    }

    for (const spec of specs) {
      if (spec.type !== 'cron' || !spec.enabled) continue;
      accumulator.scanned += 1;

      const runtime = await getGitTriggerRuntime(project.projectId, spec.slug);
      const lastFired = runtime?.lastFiredAt ?? null;
      if (!isGitCronSpecDue(spec, lastFired, now)) {
        accumulator.skipped += 1;
        continue;
      }

      // Mark fired BEFORE the actual fire — a slow tick must never spawn
      // two sessions for the same scheduled run.
      await markGitTriggerFired(project.projectId, spec.slug, now);

      const payload = {
        cron: {
          schedule: spec.cron ?? spec.runAt,
          timezone: spec.timezone,
          fired_at: now.toISOString(),
          last_fired_at: lastFired?.toISOString() ?? null,
        },
        trigger: { slug: spec.slug, type: spec.type, kind: 'git' },
      };
      const renderedPrompt = renderPromptTemplate(spec.promptTemplate, payload);

      const result = await fireGitTrigger({
        spec,
        project,
        payload,
        renderedPrompt,
        source: 'cron',
      });
      if (result.status === 'fired') accumulator.fired += 1;
      else if (result.status === 'queued') accumulator.queued += 1;
      else accumulator.failed += 1;
    }
  }
}

export function startProjectTriggerScheduler(): void {
  if (config.KORTIX_TRIGGER_SCHEDULER_ENABLED === false) return;
  if (globalForProjectTriggers.__kortixProjectTriggerSchedulerTimer) {
    clearInterval(globalForProjectTriggers.__kortixProjectTriggerSchedulerTimer);
  }
  triggerSchedulerTimer = setInterval(() => {
    runProjectTriggerSweep().catch((error) => {
      console.error('[project-triggers] sweep failed:', error);
    });

    // Same cadence drives the [[apps]] auto-deploy sweep. Run independently
    // so a slow app deploy never blocks the cron trigger fires. Skipped
    // entirely when the experimental flag is off — no point reading
    // every project's manifest just to ignore the `apps` block.
    if (config.KORTIX_APPS_EXPERIMENTAL) {
      runProjectAppSweep().catch((error) => {
        console.error('[project-apps] sweep failed:', error);
      });
    }

    // Connector reconcile backstop — slower cadence than the trigger sweep so
    // we don't re-read every manifest each tick. Catches out-of-band manifest
    // edits (raw git push / CLI) and heals any DB drift / retries error rows.
    if (Date.now() - lastConnectorSweepAt >= connectorSweepIntervalMs()) {
      lastConnectorSweepAt = Date.now();
      runProjectConnectorSweep().catch((error) => {
        console.error('[project-connectors] sweep failed:', error);
      });
    }

  }, triggerSchedulerIntervalMs());
  globalForProjectTriggers.__kortixProjectTriggerSchedulerTimer = triggerSchedulerTimer;
}

export function stopProjectTriggerScheduler(): void {
  if (triggerSchedulerTimer) {
    clearInterval(triggerSchedulerTimer);
    triggerSchedulerTimer = null;
  }
  if (globalForProjectTriggers.__kortixProjectTriggerSchedulerTimer) {
    clearInterval(globalForProjectTriggers.__kortixProjectTriggerSchedulerTimer);
    globalForProjectTriggers.__kortixProjectTriggerSchedulerTimer = null;
  }
}

// GET /v1/projects
projectsApp.get('/', async (c) => {
  const scope = await resolveProjectAccount(c);
  // Reach through `any` for non-typed context keys set by the auth
  // middleware (the AppEnv only types userId/userEmail).
  const actingTokenId =
    ((c as unknown as { get(k: string): unknown }).get('iamTokenId') as
      | string
      | undefined) ?? undefined;
  const requestCtx = deriveRequestContext(c);

  // Ask the IAM engine which projects the caller can READ. V2 returns
  // one of: { mode: 'all' } | { mode: 'none' } | { mode: 'allow_only' }.
  // 'all' = account admin/owner (manager on every project); 'allow_only'
  // = enumerated project IDs from direct project_members + group grants;
  // 'none' = no access.
  const accessible = await listAccessibleResources(
    scope.userId,
    scope.accountId,
    'project.read',
    'project',
    actingTokenId,
    requestCtx,
  );

  if (accessible.mode === 'none') return c.json([]);

  // Build the project rows + per-row project_members metadata used by
  // the UI to label effective_role. We still consult project_members
  // because the IAM engine bridges it into authorize() but doesn't
  // hand the per-row role back here — and the UI wants the original
  // manager/editor/viewer label, not just "allowed".
  const grants = await db
    .select({ projectId: projectMembers.projectId, projectRole: projectMembers.projectRole })
    .from(projectMembers)
    .where(and(
      eq(projectMembers.accountId, scope.accountId),
      eq(projectMembers.userId, scope.userId),
    ));
  const roleByProject = new Map(
    grants.map((g) => [g.projectId, g.projectRole as ProjectRole]),
  );

  const baseWhere = and(
    eq(projects.accountId, scope.accountId),
    eq(projects.status, 'active'),
  );

  let rows: Array<typeof projects.$inferSelect>;
  if (accessible.mode === 'all') {
    rows = await db.select().from(projects).where(baseWhere).orderBy(desc(projects.updatedAt));
  } else {
    // mode === 'allow_only'. The 'none' case was returned above.
    if (accessible.allowed.size === 0) return c.json([]);
    rows = await db
      .select()
      .from(projects)
      .where(and(baseWhere, inArray(projects.projectId, [...accessible.allowed])))
      .orderBy(desc(projects.updatedAt));
  }

  // Heuristic for effective_role label (UI only, NOT auth):
  //   - account-manager → 'manager' (legacy owner/admin gets full label)
  //   - explicit project_members row → that role
  //   - otherwise → 'viewer' (engine allowed read but we don't know the
  //     exact role; safe minimum for UI affordances)
  const accountManager = isAccountManager(scope.accountRole);
  return c.json(
    rows.map((row) => {
      const projectRole = roleByProject.get(row.projectId) ?? null;
      const effectiveRole = accountManager
        ? 'manager'
        : projectRole ?? 'viewer';
      return serializeProject(row, { projectRole, effectiveRole });
    }),
  );
});

// POST /v1/projects
projectsApp.post('/', async (c) => {
  const body = await readBody(c);
  const scope = await resolveProjectAccount(c, body);
  // IAM-gated. V2 checks super-admin and the caller's account role.
  await assertAuthorized(scope.userId, scope.accountId, ACCOUNT_ACTIONS.PROJECT_CREATE);

  let repoUrl: string | null;
  try {
    repoUrl = normalizeRepoUrl(body.repo_url ?? body.repoUrl);
  } catch (error) {
    return c.json({ error: (error as Error).message || 'Invalid repo_url' }, 400);
  }
  if (!repoUrl) {
    return c.json({ error: 'repo_url is required' }, 400);
  }

  const name = normalizeString(body.name) ?? deriveProjectName(repoUrl);
  const defaultBranch = normalizeString(body.default_branch ?? body.defaultBranch) ?? 'main';
  const manifestPath = normalizeString(body.manifest_path ?? body.manifestPath) ?? 'kortix.toml';

  let imported: Awaited<ReturnType<typeof resolveGitHubImport>>;
  try {
    imported = await resolveGitHubImport({
      accountId: scope.accountId,
      repoUrl,
      installationId: normalizeString(body.installation_id ?? body.installationId),
      defaultBranch,
    });
  } catch (error) {
    if (error instanceof GitHubInstallationRequiredError) {
      return c.json({
        error: error.message,
        install_url: await createGitHubInstallationInstallUrl(error.accountId, scope.userId),
      }, 409);
    }
    return c.json({ error: (error as Error).message || 'Failed to validate GitHub repository' }, 400);
  }

  const row = await registerGitHubLinkedProject({
    accountId: scope.accountId,
    userId: scope.userId,
    repo: imported.repo,
    installation: imported.installation,
    name,
    defaultBranch: imported.defaultBranch,
    manifestPath,
  });

  kickProjectTemplatePrebuilds(
    {
      projectId: row.projectId,
      repoUrl: row.repoUrl,
      defaultBranch: row.defaultBranch,
      manifestPath: row.manifestPath,
      gitAuthToken: imported.auth.token,
    },
    { accountId: scope.accountId, source: 'project-create' },
  );

  return c.json(serializeProject(row, { projectRole: 'manager', effectiveRole: 'manager' }), 201);
});

// POST /v1/projects/provision
// Managed-git "Create project": provisions a repo on the managed backend +
// scoped per-project push token, optionally seeds the starter (web flow), and
// registers the project.
// Used by the web "Create project" button and `kortix ship` when a working tree
// has no `origin` remote. BYO-repo projects go through POST / and /create-repo.
projectsApp.post('/provision', async (c) => {
  const body = await readBody(c);
  const scope = await resolveProjectAccount(c, body);
  if (!(await authorize(scope.userId, scope.accountId, ACCOUNT_ACTIONS.PROJECT_CREATE)).allowed) {
    return c.json({ error: 'Owner or admin role required' }, 403);
  }

  // Managed-git provider, provider-agnostic via the backend registry. GitHub is
  // the default + only active managed backend. Forgejo / Artifacts slot in here
  // as drop-ins.
  const provider =
    normalizeString(body.provider) ??
    (process.env.MANAGED_GIT_PROVIDER?.trim() || 'github');
  if (!hasBackend(provider)) {
    return c.json({ error: `Unsupported managed git provider "${provider}"` }, 400);
  }
  const backend = getBackend(provider);
  if (!(await backend.isConfigured())) {
    return c.json(
      { error: `Managed git provider "${provider}" is not configured on this server` },
      503,
    );
  }

  const name = normalizeString(body.name) ?? normalizeString(body.project_name ?? body.projectName);
  if (!name) return c.json({ error: 'name is required' }, 400);
  if (!/^[a-zA-Z0-9._ -]+$/.test(name)) {
    return c.json(
      { error: 'name must contain only letters, numbers, spaces, hyphens, underscores or dots' },
      400,
    );
  }
  // Managed repo name = a readable slug from the display name + the project's
  // UUID, so managed repos under the shared org NEVER collide (two projects can
  // share a name). We generate the project id up front to bake it into the repo
  // name and reuse it as the project row id.
  const projectId = randomUUID();
  const baseSlug = (
    name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') ||
    'kortix-project'
  ).slice(0, 40);
  const repoSlug = `${baseSlug}-${projectId}`;
  const defaultBranch = normalizeString(body.default_branch ?? body.defaultBranch) ?? 'main';

  let provisioned: Awaited<ReturnType<typeof backend.createRepo>>;
  try {
    provisioned = await backend.createRepo({
      accountId: scope.accountId,
      projectId,
      slug: repoSlug,
      defaultBranch,
      isPrivate: true,
    });
  } catch (error) {
    return c.json({ error: (error as Error).message || 'Failed to provision managed repo' }, 502);
  }

  const authMethod = provider === 'github' ? 'github_app' : 'managed';
  const now = new Date();
  const [row] = await db
    .insert(projects)
    .values({
      projectId,
      accountId: scope.accountId,
      name,
      repoUrl: provisioned.upstreamUrl,
      defaultBranch: provisioned.defaultBranch,
      manifestPath: 'kortix.toml',
      status: 'active',
      metadata: {
        git: {
          url: provisioned.upstreamUrl,
          upstream_url: provisioned.upstreamUrl,
          default_branch: provisioned.defaultBranch,
          provider,
          managed: true,
          auth: {
            method: authMethod,
            ref: provisioned.credentialRef,
            installation_id: provisioned.installationId,
          },
          repo_id: provisioned.externalRepoId,
          owner: provisioned.repoOwner,
          name: provisioned.repoName,
        },
      },
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [projects.accountId, projects.repoUrl],
      set: { name, defaultBranch: provisioned.defaultBranch, status: 'active', updatedAt: now },
    })
    .returning();

  await grantProjectRole({
    accountId: scope.accountId,
    projectId: row.projectId,
    userId: scope.userId,
    role: 'manager',
    grantedBy: scope.userId,
  });
  await upsertProjectGitConnection({
    accountId: scope.accountId,
    projectId: row.projectId,
    provider,
    repoUrl: provisioned.upstreamUrl,
    upstreamUrl: provisioned.upstreamUrl,
    managed: true,
    repoOwner: provisioned.repoOwner,
    repoName: provisioned.repoName,
    externalRepoId: provisioned.externalRepoId,
    defaultBranch: provisioned.defaultBranch,
    authMethod,
    installationId: provisioned.installationId,
    credentialRef: provisioned.credentialRef,
    visibility: 'private',
    status: 'connected',
    metadata: { seeded: false },
  });

  // Resolve a push credential for seeding / the CLI's first push. The managed
  // GitHub backend mints an installation token.
  let pushToken = provisioned.initialToken;
  if (!pushToken) {
    pushToken = (await resolveProjectGitAuth(row)).auth?.token ?? null;
  }

  // Seed the starter into the empty repo when the caller has no local working
  // tree to push (web "Create project"). The CLI leaves this false and pushes
  // its own files on first `kortix ship`. If seeding fails we roll back the
  // orphan repo + project so we never leave a half-created project behind.
  const seedStarter = body.seed_starter === true || body.seedStarter === true;
  const starterTemplate = normalizeStarterTemplateId(body.starter_template ?? body.starterTemplate);
  let seeded = false;
  if (seedStarter) {
    const connRef = buildConnectionRef(row, getProjectGitRemote(row, await getProjectGitConnection(row.projectId)));
    try {
      if (!pushToken) throw new Error('no push credential resolved for seeding');
      const starter = buildStarterFiles({ projectName: name, repoFullName: repoSlug, template: starterTemplate });
      if (backend.seedFiles) {
        await backend.seedFiles(connRef, pushToken, starter, {
          branch: provisioned.defaultBranch,
          message: 'chore: scaffold Kortix project',
        });
      } else {
        await seedRepoViaGitPush({
          upstreamUrl: connRef.upstreamUrl,
          token: pushToken,
          files: starter,
          branch: provisioned.defaultBranch,
          commitMessage: 'chore: scaffold Kortix project',
        });
      }
      seeded = true;
    } catch (error) {
      try { await backend.deleteRepo(connRef); } catch { /* best effort */ }
      await db.delete(projects).where(eq(projects.projectId, row.projectId)).catch(() => {});
      return c.json({ error: (error as Error).message || 'Failed to seed project repo' }, 502);
    }
  }

  if (seeded) {
    kickProjectTemplatePrebuilds(
      {
        projectId: row.projectId,
        repoUrl: row.repoUrl,
        defaultBranch: row.defaultBranch,
        manifestPath: row.manifestPath,
        gitAuthToken: pushToken,
      },
      { accountId: scope.accountId, source: 'project-create' },
    );
  }

  return c.json(
    {
      ...serializeProject(row, { projectRole: 'manager', effectiveRole: 'manager' }),
      push_token: pushToken,
      repo_id: provisioned.externalRepoId,
      seeded,
    },
    201,
  );
});

// POST /v1/projects/:projectId/git-token
// Mint a fresh scoped push token for a *managed* project so the CLI
// can push on a later `kortix ship` without persisting credentials in git config.
// Returns 409 for BYO projects (they push with the user's own git remote auth).
projectsApp.post('/:projectId/git-token', async (c) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'write');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const connection = await getProjectGitConnection(projectId);
  const remote = getProjectGitRemote(loaded.row, connection);
  if (!remote.managed) {
    return c.json({ error: 'Project is not a managed repo' }, 409);
  }

  // Provider-agnostic: resolve a fresh push credential through the backend seam
  // (the managed GitHub backend mints an installation token). Never persisted
  // in the sandbox/CLI git config.
  const gitAuth = await resolveProjectGitAuth(loaded.row);
  if (!gitAuth.auth?.token) {
    return c.json({ error: 'Managed git is not configured / unavailable for this project' }, 503);
  }
  const upstream = await resolveProjectUpstream(loaded.row, 'write');

  return c.json({
    push_token: gitAuth.auth.token,
    repo_id: remote.externalRepoId,
    repo_url: upstream?.url ?? loaded.row.repoUrl,
  });
});

// POST /v1/projects/:projectId/git/collaborators
// Invite a GitHub user as a collaborator on a MANAGED repo — lets the project
// creator pull "their" Kortix-managed repo into their own GitHub account and
// work on it on github.com directly. Managed repos only (the user already owns
// BYO repos). GitHub sends a pending invite the user accepts.
projectsApp.post('/:projectId/git/collaborators', async (c) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'write');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const body = await readBody(c);
  const username = normalizeString(body.github_username ?? body.username ?? body.login);
  if (!username) return c.json({ error: 'github_username is required' }, 400);
  const permission = normalizeString(body.permission);
  const scope: GitScope = permission === 'read' || permission === 'pull' ? 'read' : 'write';

  const remote = getProjectGitRemote(loaded.row, await getProjectGitConnection(projectId));
  if (remote.provider !== 'github' || !remote.managed) {
    return c.json({ error: 'Collaborator invites are only available for managed GitHub repos' }, 409);
  }
  const ref = buildConnectionRef(loaded.row, remote);
  const backend = getBackend(remote.provider);
  if (!backend.inviteCollaborator) {
    return c.json({ error: 'This git backend does not support collaborator invites' }, 400);
  }

  try {
    const result = await backend.inviteCollaborator(ref, username, scope);
    return c.json(result);
  } catch (error) {
    return c.json({ error: (error as Error).message || 'Failed to invite collaborator' }, 502);
  }
});

// GET /v1/projects/github/installation?account_id=...
// Account-scoped GitHub App install state. The client only receives metadata;
// installation tokens are minted server-side at repo creation time.
projectsApp.get('/github/installation', async (c) => {
  const scope = await resolveProjectAccount(c);
  await assertAuthorized(scope.userId, scope.accountId, ACCOUNT_ACTIONS.PROJECT_CREATE);

  const rows = await listAccountGitHubInstallations(scope.accountId);
  const canManageGit = (await authorize(scope.userId, scope.accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE)).allowed;
  const installUrl = canManageGit
    ? await createGitHubInstallationInstallUrl(scope.accountId, scope.userId)
    : null;
  return c.json(serializeGitHubInstallations(rows, scope.accountId, installUrl));
});

// GET /v1/projects/github/installations?account_id=...
// Vercel-style account Git connections surface. A Kortix account can connect
// multiple GitHub users/orgs and pick the exact installation during import.
projectsApp.get('/github/installations', async (c) => {
  const scope = await resolveProjectAccount(c);
  await assertAuthorized(scope.userId, scope.accountId, ACCOUNT_ACTIONS.PROJECT_CREATE);

  const rows = await listAccountGitHubInstallations(scope.accountId);
  const canManageGit = (await authorize(scope.userId, scope.accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE)).allowed;
  const installUrl = canManageGit
    ? await createGitHubInstallationInstallUrl(scope.accountId, scope.userId)
    : null;
  return c.json(serializeGitHubInstallations(rows, scope.accountId, installUrl));
});

// POST /v1/projects/github/installation
// Called after GitHub redirects back with installation_id + signed state.
// We fetch installation metadata with the app JWT instead of trusting client
// supplied owner information.
projectsApp.post('/github/installation', async (c) => {
  const body = await readBody(c);
  const state = normalizeString(body.state);
  if (!state) return c.json({ error: 'state is required' }, 400);
  const statePayload = verifyGitHubAppInstallStatePayload(state);
  if (!statePayload?.accountId || !statePayload.nonce) {
    return c.json({ error: 'invalid GitHub installation state' }, 400);
  }

  const scope = await resolveProjectAccount(c, { account_id: statePayload.accountId });
  await assertAuthorized(scope.userId, scope.accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);

  const installationId = normalizeString(body.installation_id ?? body.installationId);
  if (!installationId) return c.json({ error: 'installation_id is required' }, 400);
  if (!/^[0-9]+$/.test(installationId)) {
    return c.json({ error: 'installation_id must be a GitHub installation id' }, 400);
  }

  const stateStatus = await consumeGitHubInstallationState({
    accountId: scope.accountId,
    userId: scope.userId,
    nonce: statePayload.nonce,
    installationId,
  });
  if (stateStatus === 'invalid') {
    const existing = await getAccountGitHubInstallation(scope.accountId, installationId);
    if (existing?.installationId === installationId) {
      return c.json(serializeGitHubInstallation(existing, scope.accountId, null), 200);
    }
    return c.json({ error: 'GitHub installation state is expired or already used' }, 400);
  }

  let installation;
  try {
    installation = await getGitHubAppInstallation(installationId);
  } catch (error) {
    const message = (error as Error).message || 'Failed to verify GitHub App installation';
    return c.json({ error: message }, 502);
  }

  const ownerLogin = normalizeString(installation.account?.login);
  if (!ownerLogin) {
    return c.json({ error: 'GitHub installation did not include an owner account' }, 502);
  }

  const now = new Date();
  const [row] = await db
    .insert(accountGithubInstallations)
    .values({
      accountId: scope.accountId,
      installationId,
      ownerLogin,
      ownerType: normalizeString(installation.account?.type) ?? installation.target_type ?? 'Organization',
      repositorySelection: installation.repository_selection ?? null,
      permissions: installation.permissions ?? {},
      metadata: {
        html_url: installation.html_url ?? null,
      },
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [accountGithubInstallations.accountId, accountGithubInstallations.installationId],
      set: {
        ownerLogin,
        ownerType: normalizeString(installation.account?.type) ?? installation.target_type ?? 'Organization',
        repositorySelection: installation.repository_selection ?? null,
        permissions: installation.permissions ?? {},
        metadata: {
          html_url: installation.html_url ?? null,
        },
        updatedAt: now,
      },
    })
    .returning();

  return c.json(serializeGitHubInstallation(row, scope.accountId, null), 200);
});

// DELETE /v1/projects/github/installation?account_id=...
projectsApp.delete('/github/installation', async (c) => {
  const scope = await resolveProjectAccount(c);
  await assertAuthorized(scope.userId, scope.accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);
  const installationId = normalizeString(c.req.query('installation_id') ?? c.req.query('installationId'));

  await db
    .delete(accountGithubInstallations)
    .where(installationId
      ? and(
          eq(accountGithubInstallations.accountId, scope.accountId),
          eq(accountGithubInstallations.installationId, installationId),
        )
      : eq(accountGithubInstallations.accountId, scope.accountId));

  return c.json({ ok: true });
});

// DELETE /v1/projects/github/installations/:installationId?account_id=...
projectsApp.delete('/github/installations/:installationId', async (c) => {
  const scope = await resolveProjectAccount(c);
  await assertAuthorized(scope.userId, scope.accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);
  const installationId = c.req.param('installationId');

  await db
    .delete(accountGithubInstallations)
    .where(and(
      eq(accountGithubInstallations.accountId, scope.accountId),
      eq(accountGithubInstallations.installationId, installationId),
    ));

  return c.json({ ok: true });
});

// GET /v1/projects/github/repositories?account_id=...
// Vercel-style import surface: list repos available to the account's GitHub App
// installation without exposing an installation token to the browser.
projectsApp.get('/github/repositories', async (c) => {
  const scope = await resolveProjectAccount(c);
  await assertAuthorized(scope.userId, scope.accountId, ACCOUNT_ACTIONS.PROJECT_CREATE);

  const installationId = normalizeString(c.req.query('installation_id') ?? c.req.query('installationId'));
  const installation = await getAccountGitHubInstallation(scope.accountId, installationId);
  if (!installation) {
    return c.json({
      error: installationId
        ? 'Selected GitHub installation is not connected to this account'
        : 'Install the Kortix GitHub App before importing repositories',
      install_url: await createGitHubInstallationInstallUrl(scope.accountId, scope.userId),
    }, 409);
  }

  try {
    const repos = await listInstallationRepositories(installation.installationId);
    return c.json({
      account_id: scope.accountId,
      installation_id: installation.installationId,
      owner_login: installation.ownerLogin,
      repositories: repos.map(serializeGitHubRepo),
    });
  } catch (error) {
    const message = (error as Error).message || 'Failed to list GitHub repositories';
    return c.json({ error: message }, 502);
  }
});

// POST /v1/projects/link-repository
// Import an existing GitHub repo through the account GitHub App installation.
// This validates repo access up front and stores a typed project_git_connection.
projectsApp.post('/link-repository', async (c) => {
  const body = await readBody(c);
  const scope = await resolveProjectAccount(c, body);
  await assertAuthorized(scope.userId, scope.accountId, ACCOUNT_ACTIONS.PROJECT_CREATE);

  const repoFullName = normalizeString(body.repo_full_name ?? body.repoFullName);
  const repoUrlInput = normalizeString(body.repo_url ?? body.repoUrl);
  const repoUrl = repoFullName
    ? `https://github.com/${repoFullName.replace(/\.git$/i, '')}.git`
    : repoUrlInput;
  if (!repoUrl) return c.json({ error: 'repo_url or repo_full_name is required' }, 400);

  const manifestPath = normalizeString(body.manifest_path ?? body.manifestPath) ?? 'kortix.toml';

  // PAT path: link an existing repo with a caller-supplied token — no GitHub
  // App install needed. This is the seamless `kortix ship` flow for a repo you
  // already own (and the App-free fallback in environments where the App can't
  // be installed). Everything downstream (`resolveProjectGitAuth` →
  // `project_credential`) already consumes the stored PAT.
  const githubToken = normalizeString(body.github_token ?? body.githubToken);
  if (githubToken) {
    let patImport: Awaited<ReturnType<typeof resolveGitHubImportWithPat>>;
    try {
      patImport = await resolveGitHubImportWithPat({
        repoUrl,
        token: githubToken,
        defaultBranch: normalizeString(body.default_branch ?? body.defaultBranch),
      });
    } catch (error) {
      return c.json({ error: (error as Error).message || 'Failed to validate GitHub repository' }, 400);
    }
    const row = await registerPatLinkedProject({
      accountId: scope.accountId,
      userId: scope.userId,
      repo: patImport.repo,
      token: githubToken,
      name: normalizeString(body.name),
      defaultBranch: patImport.defaultBranch,
      manifestPath,
    });
    kickProjectTemplatePrebuilds(
      { projectId: row.projectId, repoUrl: row.repoUrl, defaultBranch: row.defaultBranch, manifestPath: row.manifestPath, gitAuthToken: githubToken },
      { accountId: scope.accountId, source: 'project-create' },
    );
    return c.json({
      project: serializeProject(row, { projectRole: 'manager', effectiveRole: 'manager' }),
      git_connection: serializeProjectGitConnection(await getProjectGitConnection(row.projectId)),
    }, 201);
  }

  let imported: Awaited<ReturnType<typeof resolveGitHubImport>>;
  try {
    imported = await resolveGitHubImport({
      accountId: scope.accountId,
      repoUrl,
      installationId: normalizeString(body.installation_id ?? body.installationId),
      defaultBranch: normalizeString(body.default_branch ?? body.defaultBranch),
    });
  } catch (error) {
    if (error instanceof GitHubInstallationRequiredError) {
      return c.json({
        error: error.message,
        install_url: await createGitHubInstallationInstallUrl(error.accountId, scope.userId),
      }, 409);
    }
    return c.json({ error: (error as Error).message || 'Failed to validate GitHub repository' }, 400);
  }

  const row = await registerGitHubLinkedProject({
    accountId: scope.accountId,
    userId: scope.userId,
    repo: imported.repo,
    installation: imported.installation,
    name: normalizeString(body.name),
    defaultBranch: imported.defaultBranch,
    manifestPath,
  });

  kickProjectTemplatePrebuilds(
    {
      projectId: row.projectId,
      repoUrl: row.repoUrl,
      defaultBranch: row.defaultBranch,
      manifestPath: row.manifestPath,
      gitAuthToken: imported.auth.token,
    },
    { accountId: scope.accountId, source: 'project-create' },
  );

  return c.json({
    project: serializeProject(row, { projectRole: 'manager', effectiveRole: 'manager' }),
    git_connection: serializeProjectGitConnection(await getProjectGitConnection(row.projectId)),
  }, 201);
});

// POST /v1/projects/create-repo
// Creates a new GitHub repository using the account's GitHub App installation,
// then registers it as a Kortix project.
projectsApp.post('/create-repo', async (c) => {
  const body = await readBody(c);
  const scope = await resolveProjectAccount(c, body);
  await assertAuthorized(scope.userId, scope.accountId, ACCOUNT_ACTIONS.PROJECT_CREATE);

  const name = normalizeString(body.name);
  if (!name) return c.json({ error: 'name is required' }, 400);
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    return c.json({ error: 'name must contain only letters, numbers, hyphens, underscores or dots' }, 400);
  }

  const isPrivate = typeof body.private === 'boolean' ? body.private : true;
  const description = normalizeString(body.description);

  let githubAuth: Awaited<ReturnType<typeof resolveGitHubRepoAuth>>;
  try {
    githubAuth = await resolveGitHubRepoAuth(scope.accountId, normalizeString(body.installation_id ?? body.installationId));
  } catch (error) {
    if (error instanceof GitHubInstallationRequiredError) {
      return c.json({
        error: error.message,
        install_url: await createGitHubInstallationInstallUrl(error.accountId, scope.userId),
      }, 409);
    }
    const message = (error as Error).message || 'GitHub is not configured on the server';
    return c.json({ error: message }, 503);
  }
  if (!githubAuth.installation || !githubAuth.auth) {
    return c.json({
      error: 'Install the Kortix GitHub App before creating GitHub-backed projects',
      install_url: await createGitHubInstallationInstallUrl(scope.accountId, scope.userId),
    }, 409);
  }

  // Auto-dedupe name collisions: GitHub 422s when the repo name is taken, so
  // try "name", then "name-2", "name-3", … until one is free (up to 12 tries).
  let repo: Awaited<ReturnType<typeof createRepo>> | undefined;
  let lastRepoError: unknown = null;
  for (let attempt = 0; attempt < 12 && !repo; attempt += 1) {
    const candidate = attempt === 0 ? name : `${name}-${attempt + 1}`;
    try {
      repo = await createRepo({
        name: candidate,
        isPrivate,
        description: description ?? undefined,
        autoInit: true,
        auth: githubAuth.auth,
      });
    } catch (error) {
      lastRepoError = error;
      if (isRepoNameTakenError(error)) continue; // name taken — try the next suffix
      return c.json({ error: (error as Error).message || 'Failed to create GitHub repository' }, 502);
    }
  }
  if (!repo) {
    return c.json(
      {
        error:
          `Could not find an available repository name near "${name}" — too many already exist. ` +
          `Pick a different name. ${(lastRepoError as Error)?.message ?? ''}`.trim(),
      },
      409,
    );
  }

  const projectName = normalizeString(body.project_name ?? body.projectName) ?? deriveProjectName(repo.full_name);
  const defaultBranch = repo.default_branch || 'main';

  // Commit the Kortix starter into the fresh repo so users land with a
  // working project shape on first session boot. GitHub's Contents API
  // updates the branch tip on every write, so these must be sequential.
  // A partial starter is not a usable project.
  const [ownerLogin, repoSlug] = repo.full_name.split('/');
  const starterTemplate = normalizeStarterTemplateId(body.starter_template ?? body.starterTemplate);
  const starter = buildStarterFiles({
    projectName,
    repoFullName: repo.full_name,
    template: starterTemplate,
  });
  for (const file of starter) {
    try {
      // README.md exists already from `auto_init: true` — upsert via sha.
      const existingSha = file.path === 'README.md'
        ? await getFileSha({ owner: ownerLogin, repo: repoSlug, path: file.path, branch: defaultBranch, auth: githubAuth.auth })
        : null;
      await commitFile({
        owner: ownerLogin,
        repo: repoSlug,
        path: file.path,
        content: file.content,
        message: `chore: scaffold ${file.path}`,
        branch: defaultBranch,
        existingSha: existingSha ?? undefined,
        auth: githubAuth.auth,
      });
    } catch (err) {
      const message = (err as Error).message || 'Failed to scaffold starter file';
      console.warn(`[projects/create-repo] Failed to scaffold ${file.path} into ${repo.full_name}:`, message);
      return c.json({ error: `Failed to scaffold starter file ${file.path}: ${message}` }, 502);
    }
  }

  const row = await registerGitHubLinkedProject({
    accountId: scope.accountId,
    userId: scope.userId,
    repo,
    installation: githubAuth.installation,
    name: projectName,
    defaultBranch,
    manifestPath: 'kortix.toml',
  });

  kickProjectTemplatePrebuilds(
    {
      projectId: row.projectId,
      repoUrl: row.repoUrl,
      defaultBranch: row.defaultBranch,
      manifestPath: row.manifestPath,
      gitAuthToken: githubAuth.auth?.token ?? null,
    },
    { accountId: scope.accountId, source: 'project-create' },
  );


  return c.json(serializeProject(row, { projectRole: 'manager', effectiveRole: 'manager' }), 201);
});

// ─── Manifest validation ──────────────────────────────────────────────────
// One schema, exercised in three places: the CLI (`kortix ship` pre-flight +
// `kortix validate`), this server-side endpoint (lets dashboards / tooling
// ask the server "is this valid?"), and the CR-merge gate.
//
// Body: { raw: string } (TOML text). Always returns 200 — the verdict is in
// the body so the caller can show issues without having to handle HTTP error
// codes. CLI use: `kortix validate` runs locally, this is for surfaces that
// don't have the file on disk.

// POST /v1/projects/:projectId/manifest/validate
projectsApp.post('/:projectId/manifest/validate', async (c) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  let body: { raw?: unknown } = {};
  try { body = (await c.req.json()) ?? {}; } catch { /* empty */ }
  const raw = typeof body.raw === 'string' ? body.raw : null;
  if (!raw) {
    return c.json({ error: 'Missing `raw` (TOML string) in body.' }, 400);
  }

  const { validateManifest } = await import('@kortix/manifest-schema');
  const verdict = validateManifest(raw);
  return c.json({
    valid: verdict.valid,
    issues: verdict.issues,
  });
});

// ─── Sandbox templates ─────────────────────────────────────────────────────
// One platform-default image, optionally extended by `[[sandbox.templates]]` entries
// in kortix.toml. Session boot is stateless: it computes the expected snapshot
// name from the resolved template, asks Daytona if it exists, builds if not.
// The append-only `project_snapshot_builds` log feeds the UI but is never
// consulted by the boot path.

function serializeBuildSummary(b: Awaited<ReturnType<typeof listSnapshotBuilds>>[number]) {
  return {
    build_id: b.buildId,
    slug: b.slug,
    snapshot_name: b.snapshotName,
    content_hash: b.contentHash,
    status: b.status,
    error: b.error,
    error_category: b.errorCategory,
    source: b.source,
    started_at: b.startedAt.toISOString(),
    finished_at: b.finishedAt?.toISOString() ?? null,
  };
}

function serializeTemplate(t: Awaited<ReturnType<typeof listSandboxTemplates>>[number]) {
  return {
    template_id: t.templateId,
    slug: t.slug,
    name: t.name,
    is_default: t.isDefault,
    source: t.source,
    provider: t.provider,
    has_dockerfile: t.hasDockerfile,
    has_image: t.hasImage,
    image: t.image,
    dockerfile_path: t.dockerfilePath,
    entrypoint: t.entrypoint,
    cpu: t.cpu,
    memory_gb: t.memoryGb,
    disk_gb: t.diskGb,
    snapshot_name: t.snapshotName,
    content_hash: t.contentHash,
    built_from_commit: t.builtFromCommit,
    daytona_state: t.daytonaState,
    provider_state: t.providerState,
    ready: t.ready,
  };
}

async function loadGitProject(loaded: { row: ProjectRow }) {
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
projectsApp.get('/:projectId/sandboxes', async (c) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const project = await loadGitProject(loaded);
  try {
    const templates = await listSandboxTemplates(project);
    return c.json({
      items: templates.map(serializeTemplate),
      default_slug: templates.find((t) => t.isDefault)?.slug ?? templates[0]?.slug ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: `Failed to list sandbox templates: ${message}` }, 500);
  }
});

// GET /v1/projects/:projectId/snapshots
// Templates + recent build log. Used by the Sandbox panel.
projectsApp.get('/:projectId/snapshots', async (c) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const project = await loadGitProject(loaded);
  let templates: Awaited<ReturnType<typeof listSandboxTemplates>> = [];
  let templatesError: string | null = null;
  try {
    templates = await listSandboxTemplates(project);
  } catch (err) {
    templatesError = err instanceof Error ? err.message : String(err);
  }
  // Heal any build rows orphaned at "building" by a process restart/crash
  // before reading them, so the dashboard never shows a permanent "Building".
  await reconcileStaleBuilds({ projectId }).catch(() => {});
  const builds = await listSnapshotBuilds(projectId, { limit: 25 }).catch(() => []);
  return c.json({
    templates: templates.map(serializeTemplate),
    templates_error: templatesError,
    builds: builds.map(serializeBuildSummary),
  });
});

// GET /v1/projects/:projectId/sandbox-health
// Cheap polling endpoint for the sidebar alert. Surfaces the platform default
// template's live state + the most recent failed build (across any template).
projectsApp.get('/:projectId/sandbox-health', async (c) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const project = await loadGitProject(loaded);
  let templates: Awaited<ReturnType<typeof listSandboxTemplates>> = [];
  try {
    templates = await listSandboxTemplates(project);
  } catch {
    // Repo unreachable / manifest broken — render as "no templates".
  }
  const primary = templates[0] ?? null;
  const builds = await listSnapshotBuilds(projectId, { limit: 10 }).catch(() => []);
  const latest = builds[0] ?? null;
  const latestFailure = builds.find((b) => b.status === 'failed') ?? null;
  const isBuilding =
    (latest && latest.status === 'building') ||
    (primary ? ['pulling', 'building'].includes(primary.daytonaState.toLowerCase()) : false);

  return c.json({
    primary_slug: primary?.slug ?? null,
    primary_template: primary ? serializeTemplate(primary) : null,
    ready: primary?.ready ?? false,
    building: isBuilding,
    latest_build: latest ? serializeBuildSummary(latest) : null,
    latest_failure: latestFailure ? serializeBuildSummary(latestFailure) : null,
  });
});

// POST /v1/projects/:projectId/snapshots/rebuild
// Force-rebuild the image for a given template slug (defaults to the platform
// default). Deletes the existing Daytona snapshot (if any) so the next
// ensureSandboxImage rebuilds from scratch. Returns 202.
projectsApp.post('/:projectId/snapshots/rebuild', async (c) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  let body: { slug?: unknown; sandbox_slug?: unknown } = {};
  try {
    body = (await c.req.json()) ?? {};
  } catch {
    /* empty body is fine */
  }
  const slugRaw = (typeof body.slug === 'string' && body.slug)
    || (typeof body.sandbox_slug === 'string' && body.sandbox_slug)
    || undefined;
  const slug = slugRaw ? String(slugRaw).trim() : undefined;

  const project = await loadGitProject(loaded);
  try {
    const deleted = await deleteSandboxImage(project, { slug });
    kickPreBuild(project, {
      slug: deleted.slug,
      accountId: loaded.row.accountId,
      source: 'manual',
    });
    return c.json(
      {
        status: 'started',
        slug: deleted.slug,
        deleted_existing: deleted.deleted,
        snapshot_name: deleted.snapshotName,
      },
      202,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 502);
  }
});

// POST /v1/projects/:projectId/snapshots/fix-with-agent
// Spin up a session pre-seeded with the most recent build failure so an agent
// can diagnose + fix the Dockerfile and open a change request. Requires a
// previous successful build to host the fix session.
projectsApp.post('/:projectId/snapshots/fix-with-agent', async (c) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  const userId = c.get('userId') as string;

  const builds = await listSnapshotBuilds(projectId, { limit: 50 }).catch(() => []);
  const failed = builds.find((b) => b.status === 'failed');
  if (!failed) {
    return c.json({ error: 'No failed snapshot build to fix.' }, 409);
  }

  const hostBuild = builds.find((b) => b.status === 'ready');
  if (!hostBuild) {
    return c.json(
      {
        error:
          'No ready sandbox to run the fix in yet. Retry the build, or edit the Dockerfile manually.',
        code: 'NO_READY_SANDBOX',
      },
      409,
    );
  }

  const errorText = failed.error ?? 'Snapshot build failed';
  const category = failed.errorCategory ?? classifySnapshotError(errorText);
  const info = describeSnapshotError(category as ReturnType<typeof classifySnapshotError>);

  const prompt = [
    `The sandbox image build for the "${failed.slug}" template is failing, so new sessions on it can't boot. Diagnose and fix the root cause, then open a change request.`,
    ``,
    `Failing template: ${failed.slug}`,
    `Error type: ${category} — ${info.title}`,
    info.hint,
    ``,
    `Build error:`,
    '```',
    errorText.slice(0, 4000),
    '```',
    ``,
    `The sandbox image is built from the template definition (see [[sandbox.templates]] in kortix.toml).`,
    ``,
    `Steps:`,
    `1. Inspect the relevant Dockerfile and the build error above.`,
    `2. Fix the root cause.`,
    `3. Open a change request. Once it merges, the image rebuilds automatically.`,
  ].join('\n');

  const result = await createProjectSession({
    project: loaded.row,
    userId,
    body: {
      initial_prompt: prompt,
      name: 'Fix sandbox build',
      metadata: { kind: 'sandbox-build-fix', failed_slug: failed.slug },
      sandbox_slug: hostBuild.slug,
    },
    request: requestAuditContext(c),
  });
  if (result.error) return sendSessionCreateError(c, result.error);

  return c.json({ session_id: result.row!.sessionId }, 201);
});

// ─── Template CRUD ─────────────────────────────────────────────────────────
// Full CRUD over `kortix.sandbox_templates`. Shared/platform rows are read-
// only. Project-scoped rows can be created/edited/deleted from the dashboard.

// GET /v1/projects/:projectId/sandbox-templates — same as /sandboxes; thinner
// path for the "templates only" UI surface. We re-use the same serializer.
projectsApp.get('/:projectId/sandbox-templates', async (c) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  const project = await loadGitProject(loaded);
  try {
    const templates = await listSandboxTemplates(project);
    return c.json({
      items: templates.map(serializeTemplate),
      default_slug: templates.find((t) => t.isDefault)?.slug ?? templates[0]?.slug ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: `Failed to list templates: ${message}` }, 500);
  }
});

// POST /v1/projects/:projectId/sandbox-templates — create a custom template.
projectsApp.post('/:projectId/sandbox-templates', async (c) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  let body: Record<string, unknown> = {};
  try { body = (await c.req.json()) ?? {}; } catch { /* empty */ }

  const slug = typeof body.slug === 'string' ? body.slug.trim() : '';
  if (!slug || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(slug)) {
    return c.json({ error: 'slug must be lowercase letters/digits/_- (1-64 chars)' }, 400);
  }
  if (slug === DEFAULT_SANDBOX_SLUG) {
    return c.json({ error: 'slug "default" is reserved for the platform template' }, 409);
  }

  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : slug;
  const image = typeof body.image === 'string' && body.image.trim() ? body.image.trim() : undefined;
  const dockerfilePath = typeof body.dockerfile_path === 'string' && body.dockerfile_path.trim()
    ? body.dockerfile_path.trim()
    : undefined;
  if ((image && dockerfilePath) || (!image && !dockerfilePath)) {
    return c.json({ error: 'Provide exactly one of `image` or `dockerfile_path`.' }, 400);
  }
  const entrypoint = typeof body.entrypoint === 'string' && body.entrypoint.trim()
    ? body.entrypoint.trim()
    : undefined;
  const cpu = typeof body.cpu === 'number' ? body.cpu : undefined;
  const memoryGb = typeof body.memory_gb === 'number' ? body.memory_gb : undefined;
  const diskGb = typeof body.disk_gb === 'number' ? body.disk_gb : undefined;

  try {
    const row = await createTemplate({
      projectId,
      accountId: loaded.row.accountId,
      slug,
      name,
      image,
      dockerfilePath,
      entrypoint,
      cpu,
      memoryGb,
      diskGb,
      source: 'ui',
    });
    // Kick a build in the background so the template is ready for the next session.
    const project = await loadGitProject(loaded);
    kickPreBuild(project, { slug: row.slug, accountId: loaded.row.accountId, source: 'manual' });
    return c.json({ template_id: row.templateId, slug: row.slug }, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.toLowerCase().includes('duplicate') || message.includes('idx_sandbox_templates_project_slug')) {
      return c.json({ error: `A template with slug "${slug}" already exists.` }, 409);
    }
    return c.json({ error: message }, 400);
  }
});

// PATCH /v1/projects/:projectId/sandbox-templates/:templateId — update fields.
projectsApp.patch('/:projectId/sandbox-templates/:templateId', async (c) => {
  const projectId = c.req.param('projectId');
  const templateId = c.req.param('templateId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  let body: Record<string, unknown> = {};
  try { body = (await c.req.json()) ?? {}; } catch { /* empty */ }

  const patch = {
    name: typeof body.name === 'string' ? body.name.trim() : undefined,
    image: 'image' in body ? (typeof body.image === 'string' ? body.image.trim() || null : null) : undefined,
    dockerfilePath: 'dockerfile_path' in body
      ? (typeof body.dockerfile_path === 'string' ? body.dockerfile_path.trim() || null : null)
      : undefined,
    entrypoint: 'entrypoint' in body
      ? (typeof body.entrypoint === 'string' ? body.entrypoint.trim() || null : null)
      : undefined,
    cpu: 'cpu' in body ? (typeof body.cpu === 'number' ? body.cpu : null) : undefined,
    memoryGb: 'memory_gb' in body ? (typeof body.memory_gb === 'number' ? body.memory_gb : null) : undefined,
    diskGb: 'disk_gb' in body ? (typeof body.disk_gb === 'number' ? body.disk_gb : null) : undefined,
  };

  try {
    const updated = await updateTemplate(templateId, patch);
    if (!updated) return c.json({ error: 'Not found' }, 404);
    if (updated.projectId !== projectId) return c.json({ error: 'Not found' }, 404);
    return c.json({ template_id: updated.templateId, slug: updated.slug });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 400);
  }
});

// DELETE /v1/projects/:projectId/sandbox-templates/:templateId
projectsApp.delete('/:projectId/sandbox-templates/:templateId', async (c) => {
  const projectId = c.req.param('projectId');
  const templateId = c.req.param('templateId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const row = await getTemplateById(templateId);
  if (!row) return c.json({ error: 'Not found' }, 404);
  if (row.projectId !== projectId) return c.json({ error: 'Not found' }, 404);
  if (row.isShared) return c.json({ error: 'Shared platform templates cannot be deleted.' }, 409);

  try {
    // Best-effort: clear the provider snapshot too.
    if (row.providerSnapshotName) {
      await getSandboxProvider(row.provider)
        .deleteSnapshot(row.providerSnapshotName)
        .catch(() => {});
    }
    await deleteTemplate(templateId);
    return c.body(null, 204);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 400);
  }
});

// POST /v1/projects/:projectId/sandbox-templates/:templateId/build — trigger
// a build (fire-and-forget). Returns 202.
projectsApp.post('/:projectId/sandbox-templates/:templateId/build', async (c) => {
  const projectId = c.req.param('projectId');
  const templateId = c.req.param('templateId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const row = await getTemplateById(templateId);
  if (!row) return c.json({ error: 'Not found' }, 404);
  if (row.projectId !== null && row.projectId !== projectId) {
    return c.json({ error: 'Not found' }, 404);
  }

  const project = await loadGitProject(loaded);
  kickPreBuild(project, { slug: row.slug, accountId: loaded.row.accountId, source: 'manual' });
  return c.json({ status: 'started', template_id: row.templateId, slug: row.slug }, 202);
});

// ─── Project-scoped CLI tokens ─────────────────────────────────────────────
// These are PATs (`kortix_pat_...`) bound to a single project. The auth
// middleware enforces that the URL's `:projectId` matches the token's
// project_id, so the token is useless outside this one project. They're
// auto-minted at session-create time and injected into the sandbox as
// `KORTIX_TOKEN` so the in-container CLI works with zero config.

projectsApp.get('/:projectId/cli-token', async (c) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  const tokens = await listAccountTokens(loaded.row.accountId, projectId);
  return c.json({
    items: tokens.map((t) => ({
      token_id: t.tokenId,
      name: t.name,
      public_key: t.publicKey,
      status: t.status,
      expires_at: t.expiresAt?.toISOString() ?? null,
      last_used_at: t.lastUsedAt?.toISOString() ?? null,
      created_at: t.createdAt.toISOString(),
      revoked_at: t.revokedAt?.toISOString() ?? null,
    })),
  });
});

projectsApp.post('/:projectId/cli-token', async (c) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  // Authorization is enforced by loadProjectForUser(... 'manage') above,
  // which routes through the IAM engine (project.write).

  // One body field: `name`. Defaults to "cli · <project name>".
  let body: { name?: unknown } = {};
  try {
    body = (await c.req.json()) ?? {};
  } catch {
    /* empty body is fine */
  }
  const name =
    typeof body.name === 'string' && body.name.trim()
      ? body.name.trim().slice(0, 255)
      : `cli · ${loaded.row.name}`;

  const userId = c.get('userId') as string;
  const created = await createAccountToken({
    accountId: loaded.row.accountId,
    userId,
    projectId,
    name,
  });

  return c.json(
    {
      token_id: created.tokenId,
      name: created.name,
      public_key: created.publicKey,
      secret_key: created.secretKey,
      status: created.status,
      project_id: created.projectId,
      expires_at: created.expiresAt?.toISOString() ?? null,
      created_at: created.createdAt.toISOString(),
    },
    201,
  );
});

projectsApp.delete('/:projectId/cli-token/:tokenId', async (c) => {
  const projectId = c.req.param('projectId');
  const tokenId = c.req.param('tokenId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  // Authorization is enforced by loadProjectForUser(... 'manage') above.
  const ok = await revokeAccountToken(tokenId, loaded.row.accountId);
  if (!ok) return c.json({ error: 'token not found or already revoked' }, 404);
  return c.json({ ok: true });
});

// GET /v1/projects/:projectId/git/clone-credential
// Runtime-only clone credential fetch. A session sandbox calls this endpoint
// with its sandbox-scoped KORTIX_TOKEN and gets a fresh provider credential
// just-in-time. Browser sessions must not receive raw Git tokens.
projectsApp.get('/:projectId/git/clone-credential', async (c) => {
  const projectId = c.req.param('projectId');
  const authType = (c as any).get('authType') as string | undefined;
  const tokenProjectId = (c as any).get('tokenProjectId') as string | undefined;

  let projectRow: typeof projects.$inferSelect | null = null;

  if (authType === 'pat') {
    if (tokenProjectId !== projectId) {
      return c.json({ error: 'clone credentials require a project-scoped runtime token' }, 403);
    }
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    projectRow = loaded.row;
  } else if (authType === 'apiKey' && (c as any).get('apiKeyType') === 'sandbox') {
    const accountId = (c as any).get('accountId') as string | undefined;
    const sandboxId = (c as any).get('sandboxId') as string | undefined;
    if (!accountId || !sandboxId) {
      return c.json({ error: 'clone credentials require a sandbox token' }, 403);
    }
    const [sandbox] = await db
      .select({ sandboxId: sessionSandboxes.sandboxId })
      .from(sessionSandboxes)
      .where(and(
        eq(sessionSandboxes.sandboxId, sandboxId),
        eq(sessionSandboxes.projectId, projectId),
        eq(sessionSandboxes.accountId, accountId),
        inArray(sessionSandboxes.status, ['provisioning', 'active']),
      ))
      .limit(1);
    if (!sandbox) {
      return c.json({ error: 'sandbox token is not scoped to this project' }, 403);
    }
    const [row] = await db
      .select()
      .from(projects)
      .where(and(
        eq(projects.projectId, projectId),
        eq(projects.accountId, accountId),
      ))
      .limit(1);
    if (!row || row.status === 'archived') return c.json({ error: 'Not found' }, 404);
    projectRow = row;
  } else {
    return c.json({ error: 'clone credentials are only available to runtime tokens' }, 403);
  }
  if (!projectRow) return c.json({ error: 'Not found' }, 404);

  const gitAuth = await resolveProjectGitAuth(projectRow);
  if (!gitAuth.auth?.token) {
    return c.json({
      repo_url: projectRow.repoUrl,
      auth: null,
      source: gitAuth.authSource,
    });
  }

  return c.json({
    repo_url: projectRow.repoUrl,
    auth: {
      username: 'x-access-token',
      token: gitAuth.auth.token,
      type: 'basic',
    },
    source: gitAuth.authSource,
    expires_at: null,
  });
});

// PUT /v1/projects/:projectId/git-credential
// Stores provider-neutral BYO git credentials as platform credentials, not as
// user-readable/injectable runtime secrets. The managed GitHub backend mints
// credentials server-side; this exists for generic future providers such as
// GitLab/Bitbucket until they have first-class adapters.
projectsApp.put('/:projectId/git-credential', async (c) => {
  const projectId = c.req.param('projectId');
  const body = await readBody(c);
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  if (await hasServerManagedGitAuth(loaded.row)) {
    return c.json({ error: 'Git auth is already managed by Kortix for this project' }, 409);
  }

  const token =
    typeof body.token === 'string'
      ? body.token.trim()
      : typeof body.value === 'string'
        ? body.value.trim()
        : '';
  if (!token) return c.json({ error: 'token is required' }, 400);

  const existingConnection = await getProjectGitConnection(projectId);
  const remote = getProjectGitRemote(loaded.row, existingConnection);
  const provider = normalizeString(body.provider) ?? (remote.provider === 'github' ? 'generic' : remote.provider);
  if (provider === 'github') {
    return c.json({ error: 'GitHub credentials are managed through the GitHub App connection' }, 409);
  }

  const credential = await upsertProjectGitCredential({
    accountId: loaded.row.accountId,
    projectId,
    provider,
    token,
    createdBy: loaded.userId,
  });
  const connection = await upsertProjectGitConnection({
    accountId: loaded.row.accountId,
    projectId,
    provider,
    repoUrl: loaded.row.repoUrl,
    defaultBranch: loaded.row.defaultBranch,
    authMethod: 'project_credential',
    credentialRef: credential.credentialId,
    status: 'connected',
    metadata: { credential_kind: 'token' },
  });

  return c.json({
    configured: true,
    provider,
    git_connection: serializeProjectGitConnection(connection),
  }, 200);
});

// GET /v1/projects/:projectId/secrets
// Readable by any project member: returns each secret KEY as the per-user view
// (the shared row + that member's own override, names only, no plaintext) plus
// the manifest-declared required/optional env keys. Members manage only their
// own override; managers additionally manage the shared row (`can_manage_shared`).
projectsApp.get('/:projectId/secrets', async (c) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const subject = await resolveShareSubject(loaded.userId);
  const canManageShared = roleAllows(loaded.effectiveRole, 'manage');

  // Manifest is optional — a project without kortix.toml just gets empty
  // required/optional lists. We surface loaded/missing/error explicitly so the
  // UI can distinguish "no envs declared" from "we couldn't read the manifest".
  let required: string[] = [];
  let optional: string[] = [];
  let manifestStatus: 'loaded' | 'missing' | 'error' = 'missing';
  let manifestError: string | null = null;
  try {
    const projectConfig = await loadProjectConfig(await withProjectGitAuth(loaded.row), []);
    required = projectConfig?.env?.required ?? [];
    optional = projectConfig?.env?.optional ?? [];
    manifestStatus = projectConfig?.manifest_raw ? 'loaded' : 'missing';
  } catch (err) {
    manifestStatus = 'error';
    manifestError = err instanceof Error ? err.message : String(err);
    console.warn('[projects] secrets: manifest load failed', {
      projectId,
      manifestPath: loaded.row.manifestPath,
      error: manifestError,
    });
  }

  const items = (await loadSecretViewsForUser(projectId, subject, canManageShared))
    .filter((item) => !item.system);

  return c.json({
    items,
    required,
    optional,
    // Page-level: may this member edit shared rows (add/set/share), or only
    // manage their own overrides?
    can_manage: canManageShared,
    manifest_status: manifestStatus,
    manifest_path: loaded.row.manifestPath,
    ...(manifestError ? { manifest_error: manifestError } : {}),
  });
});

// POST /v1/projects/:projectId/secrets
// Upsert a project secret. The response intentionally omits value/value_enc.
projectsApp.post('/:projectId/secrets', async (c) => {
  const projectId = c.req.param('projectId');
  const body = await readBody(c);
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const name = normalizeString(body.name)?.toUpperCase();
  if (!name) return c.json({ error: 'name is required' }, 400);
  if (!isValidSecretName(name)) {
    return c.json({ error: 'name must be a valid env var name (A-Z, 0-9, _; max 64 chars)' }, 400);
  }
  if (name.startsWith('KORTIX_')) {
    return c.json({ error: 'KORTIX_* names are reserved for platform/runtime-managed variables' }, 400);
  }
  if (name === CODEX_AUTH_JSON_SECRET_NAME) {
    return c.json({ error: `${CODEX_AUTH_JSON_SECRET_NAME} is managed by ChatGPT subscription onboarding` }, 400);
  }

  const value = typeof body.value === 'string' ? body.value : null;

  // Optional sharing intent (project | private | members). Absent → leave
  // sharing as-is (column defaults to 'project' on first insert).
  let sharing: ReturnType<typeof parseSharingIntent> | undefined;
  if (body.sharing != null) {
    sharing = parseSharingIntent(body.sharing, loaded.userId);
    if (!sharing) {
      return c.json({ error: 'invalid sharing — mode must be project|private|members' }, 400);
    }
  }

  // Look up the existing SHARED row so a sharing-only edit doesn't force
  // re-entering the value. Creating a brand-new secret still requires a value.
  const [existing] = await db
    .select({ secretId: projectSecrets.secretId })
    .from(projectSecrets)
    .where(and(
      eq(projectSecrets.projectId, projectId),
      eq(projectSecrets.name, name),
      isNull(projectSecrets.ownerUserId),
    ))
    .limit(1);
  if (!existing && value === null) {
    return c.json({ error: 'value is required' }, 400);
  }

  const now = new Date();
  let secretId: string;
  if (value !== null) {
    const [row] = await db
      .insert(projectSecrets)
      .values({
        projectId,
        name,
        valueEnc: encryptProjectSecret(projectId, value),
        createdBy: loaded.userId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        // The shared row is unique on (project, name) WHERE owner_user_id IS NULL.
        target: [projectSecrets.projectId, projectSecrets.name],
        targetWhere: isNull(projectSecrets.ownerUserId),
        set: {
          valueEnc: encryptProjectSecret(projectId, value),
          updatedAt: now,
        },
      })
      .returning({ secretId: projectSecrets.secretId });
    secretId = row.secretId;
  } else {
    // Sharing-only update — touch updatedAt so the list reflects the change.
    await db
      .update(projectSecrets)
      .set({ updatedAt: now })
      .where(eq(projectSecrets.secretId, existing!.secretId));
    secretId = existing!.secretId;
  }

  if (sharing) await setSecretSharing(secretId, sharing);

  const subject = await resolveShareSubject(loaded.userId);
  const views = await loadSecretViewsForUser(projectId, subject, true);
  const view = views.find((v) => v.name === name);
  return c.json(view ?? { name }, 200);
});

// POST /v1/projects/:projectId/providers/openai/chatgpt/headless/start
// Starts the OpenCode ChatGPT Pro/Plus headless device-code flow on the API
// server. This deliberately does not require a running sandbox: provider
// credentials are project configuration, and sandboxes only consume the saved
// CODEX_AUTH_JSON secret later.
projectsApp.post('/:projectId/providers/openai/chatgpt/headless/start', async (c) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  try {
    return c.json(await startChatGptHeadlessAuth({
      projectId,
      userId: loaded.userId,
    }));
  } catch (err) {
    return c.json({
      error: err instanceof Error ? err.message : 'Failed to start ChatGPT authorization',
    }, 500);
  }
});

// POST /v1/projects/:projectId/providers/openai/chatgpt/headless/complete
// Waits for the server-side OpenCode device flow to complete, then writes the
// resulting auth.json into project_secrets as CODEX_AUTH_JSON. This is
// intentionally Codex-specific; generic OpenCode auth can keep using its own
// OPENCODE_AUTH_JSON row without being overwritten by subscription onboarding.
projectsApp.post('/:projectId/providers/openai/chatgpt/headless/complete', async (c) => {
  const projectId = c.req.param('projectId');
  const body = await readBody(c);
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const authId = normalizeString(body.auth_id);
  if (!authId) return c.json({ error: 'auth_id is required' }, 400);

  let sharing: ReturnType<typeof parseSharingIntent> | undefined;
  if (body.sharing != null) {
    sharing = parseSharingIntent(body.sharing, loaded.userId);
    if (!sharing) {
      return c.json({ error: 'invalid sharing — mode must be project|private|members' }, 400);
    }
  }
  if (sharing?.mode !== 'private' && !roleAllows(loaded.effectiveRole, 'manage')) {
    return c.json({ error: 'Only project managers can configure shared provider credentials' }, 403);
  }

  try {
    const value = await completeChatGptHeadlessAuth({
      authId,
      projectId,
      userId: loaded.userId,
    });

    const now = new Date();
    if (sharing?.mode === 'private') {
      await db
        .insert(projectSecrets)
        .values({
          projectId,
          name: CODEX_AUTH_JSON_SECRET_NAME,
          valueEnc: encryptProjectSecret(projectId, value),
          ownerUserId: loaded.userId,
          active: true,
          createdBy: loaded.userId,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [projectSecrets.projectId, projectSecrets.name, projectSecrets.ownerUserId],
          targetWhere: sql`${projectSecrets.ownerUserId} is not null`,
          set: {
            valueEnc: encryptProjectSecret(projectId, value),
            active: true,
            updatedAt: now,
          },
        });

      const subject = await resolveShareSubject(loaded.userId);
      const views = await loadSecretViewsForUser(projectId, subject, true);
      const view = views.find((v) => v.name === CODEX_AUTH_JSON_SECRET_NAME);
      return c.json(view ?? { name: CODEX_AUTH_JSON_SECRET_NAME }, 200);
    }

    await db
      .insert(projectSecrets)
      .values({
        projectId,
        name: CODEX_AUTH_JSON_SECRET_NAME,
        valueEnc: encryptProjectSecret(projectId, value),
        createdBy: loaded.userId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [projectSecrets.projectId, projectSecrets.name],
        targetWhere: isNull(projectSecrets.ownerUserId),
        set: {
          valueEnc: encryptProjectSecret(projectId, value),
          updatedAt: now,
        },
      });

    const [row] = await db
      .select({ secretId: projectSecrets.secretId })
      .from(projectSecrets)
      .where(and(
        eq(projectSecrets.projectId, projectId),
        eq(projectSecrets.name, CODEX_AUTH_JSON_SECRET_NAME),
        isNull(projectSecrets.ownerUserId),
      ))
      .limit(1);
    if (sharing && row) await setSecretSharing(row.secretId, sharing);

    const subject = await resolveShareSubject(loaded.userId);
    const views = await loadSecretViewsForUser(projectId, subject, true);
    const view = views.find((v) => v.name === CODEX_AUTH_JSON_SECRET_NAME);
    return c.json(view ?? { name: CODEX_AUTH_JSON_SECRET_NAME }, 200);
  } catch (err) {
    return c.json({
      error: err instanceof Error ? err.message : 'Failed to complete ChatGPT authorization',
    }, 500);
  }
});

// DELETE /v1/projects/:projectId/secrets/:name
projectsApp.delete('/:projectId/secrets/:name', async (c) => {
  const projectId = c.req.param('projectId');
  const name = c.req.param('name')?.trim().toUpperCase();
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  if (!name || !isValidSecretName(name)) {
    return c.json({ error: 'Invalid secret name' }, 400);
  }
  if (isSystemProjectSecretName(name)) {
    return c.json({ error: `${name} is managed by Kortix and cannot be removed` }, 403);
  }

  // Only the shared row — members' personal overrides for this key are theirs to
  // remove (via the /personal route) and are left intact.
  await db
    .delete(projectSecrets)
    .where(and(
      eq(projectSecrets.projectId, projectId),
      eq(projectSecrets.name, name),
      isNull(projectSecrets.ownerUserId),
    ));

  return c.json({ ok: true });
});

// PUT /v1/projects/:projectId/secrets/:name/personal
// Any project member sets/updates THEIR OWN per-key override (the "use mine"
// value) and/or flips whether it's active. Operates only on the caller's row;
// never touches the shared value or anyone else's override.
projectsApp.put('/:projectId/secrets/:name/personal', async (c) => {
  const projectId = c.req.param('projectId');
  const body = await readBody(c);
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const name = c.req.param('name')?.trim().toUpperCase();
  if (!name || !isValidSecretName(name)) {
    return c.json({ error: 'Invalid secret name' }, 400);
  }
  if (isSystemProjectSecretName(name)) {
    return c.json({ error: 'KORTIX_* names are reserved and cannot be overridden' }, 400);
  }
  if (name === CODEX_AUTH_JSON_SECRET_NAME) {
    return c.json({ error: `${CODEX_AUTH_JSON_SECRET_NAME} is managed by ChatGPT subscription onboarding` }, 400);
  }

  const value = typeof body.value === 'string' ? body.value : null;
  const active = typeof body.active === 'boolean' ? body.active : undefined;
  if (value === null && active === undefined) {
    return c.json({ error: 'value or active is required' }, 400);
  }

  const [existingMine] = await db
    .select({ secretId: projectSecrets.secretId })
    .from(projectSecrets)
    .where(and(
      eq(projectSecrets.projectId, projectId),
      eq(projectSecrets.name, name),
      eq(projectSecrets.ownerUserId, loaded.userId),
    ))
    .limit(1);

  const now = new Date();
  if (!existingMine) {
    if (value === null) {
      return c.json({ error: 'value is required to create an override' }, 400);
    }
    await db.insert(projectSecrets).values({
      projectId,
      name,
      valueEnc: encryptProjectSecret(projectId, value),
      ownerUserId: loaded.userId,
      active: active ?? true,
      createdBy: loaded.userId,
      updatedAt: now,
    });
  } else {
    await db
      .update(projectSecrets)
      .set({
        ...(value !== null ? { valueEnc: encryptProjectSecret(projectId, value) } : {}),
        ...(active !== undefined ? { active } : {}),
        updatedAt: now,
      })
      .where(eq(projectSecrets.secretId, existingMine.secretId));
  }

  const subject = await resolveShareSubject(loaded.userId);
  const views = await loadSecretViewsForUser(projectId, subject, roleAllows(loaded.effectiveRole, 'manage'));
  return c.json(views.find((v) => v.name === name) ?? { name }, 200);
});

// DELETE /v1/projects/:projectId/secrets/:name/personal
// Remove the caller's own override for this key (falls back to the shared value).
projectsApp.delete('/:projectId/secrets/:name/personal', async (c) => {
  const projectId = c.req.param('projectId');
  const name = c.req.param('name')?.trim().toUpperCase();
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  if (!name || !isValidSecretName(name)) {
    return c.json({ error: 'Invalid secret name' }, 400);
  }

  await db
    .delete(projectSecrets)
    .where(and(
      eq(projectSecrets.projectId, projectId),
      eq(projectSecrets.name, name),
      eq(projectSecrets.ownerUserId, loaded.userId),
    ));

  return c.json({ ok: true });
});

// GET /v1/projects/:projectId/triggers
//
// Lists triggers defined as files in `.opencode/triggers/*.md` on the
// project's default branch, plus any parse errors and runtime state
// (last_fired_at). The repo is the source of truth — POST/PATCH/DELETE
// below commit/update/delete the underlying file.
projectsApp.get('/:projectId/triggers', async (c) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  return c.json(await loadTriggersForResponse(projectId, loaded.row));
});

function buildPublicWebhookUrl(projectId: string, slug: string): string {
  const root = deriveKortixApiRoot(config.KORTIX_URL);
  return `${root}/v1/webhooks/projects/${projectId}/${slug}`;
}

// ── Git-backed trigger CRUD helpers ─────────────────────────────────────────

/** Builds the GET-listing response shape (specs + runtime + errors). */
async function loadTriggersForResponse(projectId: string, project: ProjectRow) {
  const { specs, errors } = await loadProjectTriggers(await withProjectGitAuth(project));
  const runtimeRows = specs.length === 0
    ? []
    : await db
        .select()
        .from(projectTriggerRuntime)
        .where(eq(projectTriggerRuntime.projectId, projectId));
  const lastFiredBySlug = new Map(
    runtimeRows.map((row) => [row.slug, row.lastFiredAt?.toISOString() ?? null]),
  );

  return {
    triggers: specs.map((spec) => ({
      slug: spec.slug,
      path: spec.path,
      name: spec.name,
      type: spec.type,
      agent: spec.agent,
      enabled: spec.enabled,
      cron: spec.cron,
      run_at: spec.runAt,
      timezone: spec.timezone,
      secret_env: spec.secretEnv,
      prompt_template: spec.promptTemplate,
      last_fired_at: lastFiredBySlug.get(spec.slug) ?? null,
      webhook_url:
        spec.type === 'webhook'
          ? buildPublicWebhookUrl(projectId, spec.slug)
          : null,
    })),
    errors,
  };
}

interface TriggerDraft {
  slug: string;
  name: string;
  type: 'cron' | 'webhook';
  agent: string;
  enabled: boolean;
  promptTemplate: string;
  cron: string | null;
  runAt: string | null;
  timezone: string;
  secretEnv: string | null;
}

function parseTriggerDraft(
  body: Record<string, unknown>,
  opts: { existingSlug: string | null },
): TriggerDraft | { error: string } {
  const rawSlug = normalizeString((body as any).slug);
  const name = normalizeString((body as any).name);
  if (!name) return { error: 'name is required' };

  const slug = opts.existingSlug
    ?? rawSlug
    ?? slugify(name);
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(slug)) {
    return { error: `Invalid slug "${slug}" — use letters, digits, dashes, underscores only` };
  }

  const type = (body as any).type === 'webhook' ? 'webhook' : (body as any).type === 'cron' ? 'cron' : null;
  if (!type) return { error: 'type must be "cron" or "webhook"' };

  const promptTemplate = normalizeString((body as any).prompt_template ?? (body as any).promptTemplate);
  if (!promptTemplate) return { error: 'prompt_template is required' };

  const agent = normalizeString((body as any).agent ?? (body as any).agent_name) ?? 'default';
  const enabled = normalizeBoolean((body as any).enabled) ?? true;

  if (type === 'cron') {
    const timezone = normalizeString((body as any).timezone) ?? 'UTC';
    // One-off ("run once") schedules carry `run_at` instead of `cron`.
    const runAtRaw = normalizeString((body as any).run_at ?? (body as any).runAt);
    if (runAtRaw) {
      const parsed = Date.parse(runAtRaw);
      if (Number.isNaN(parsed)) {
        return { error: `run_at must be an ISO-8601 datetime (got "${runAtRaw}")` };
      }
      return {
        slug,
        name,
        type: 'cron',
        agent,
        enabled,
        promptTemplate,
        cron: null,
        runAt: new Date(parsed).toISOString(),
        timezone,
        secretEnv: null,
      };
    }
    const cron = normalizeString((body as any).cron ?? (body as any).schedule);
    if (!cron) return { error: 'cron triggers must declare a `cron` expression or a one-off `run_at`' };
    return {
      slug,
      name,
      type: 'cron',
      agent,
      enabled,
      promptTemplate,
      cron,
      runAt: null,
      timezone,
      secretEnv: null,
    };
  }

  const secretEnv = normalizeString((body as any).secret_env ?? (body as any).secretEnv);
  if (!secretEnv) return { error: 'webhook triggers must declare `secret_env`' };
  if (!/^[A-Z_][A-Z0-9_]*$/.test(secretEnv)) {
    return { error: `secret_env must look like a project_secrets name (got "${secretEnv}")` };
  }
  return {
    slug,
    name,
    type: 'webhook',
    agent,
    enabled,
    promptTemplate,
    cron: null,
    runAt: null,
    timezone: 'UTC',
    secretEnv,
  };
}

/** Convert an existing spec back to body shape so we can splat it into a
 * PATCH merge before re-parsing. */
function specToBody(spec: GitTriggerSpec): Record<string, unknown> {
  return {
    slug: spec.slug,
    name: spec.name,
    type: spec.type,
    agent: spec.agent,
    enabled: spec.enabled,
    prompt_template: spec.promptTemplate,
    cron: spec.cron,
    timezone: spec.timezone,
    secret_env: spec.secretEnv,
  };
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 128) || 'trigger';
}

function parseGitHubRepoUrl(repoUrl: string): { owner: string; repo: string } | null {
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
function draftToSpec(draft: TriggerDraft): GitTriggerSpec {
  return {
    slug: draft.slug,
    path: `${MANIFEST_FILENAME}#triggers.${draft.slug}`,
    name: draft.name,
    type: draft.type,
    agent: draft.agent,
    enabled: draft.enabled,
    promptTemplate: draft.promptTemplate,
    cron: draft.cron,
    runAt: draft.runAt,
    timezone: draft.timezone,
    secretEnv: draft.secretEnv,
  };
}

/**
 * Read the project's manifest. If kortix.toml doesn't exist yet (brand-new
 * repo), synthesize a minimal valid one so the first POST /triggers can
 * scaffold it on save.
 */
export async function loadManifestForEdit(project: ProjectRow): Promise<ParsedManifest> {
  const existing = await readManifest(await withProjectGitAuth(project));
  if (existing) return existing;
  return {
    schemaVersion: KNOWN_SCHEMA_VERSION,
    raw: {
      project: { name: project.name, description: '' },
      runtime: { root: '.opencode' },
      env: { required: [], optional: [] },
    },
  };
}

/** Insert or replace a trigger by slug inside the manifest's triggers array. */
function upsertTriggerInManifest(
  manifest: ParsedManifest,
  spec: GitTriggerSpec,
): ParsedManifest {
  const current = Array.isArray(manifest.raw.triggers)
    ? (manifest.raw.triggers as Record<string, unknown>[])
    : [];
  const idx = current.findIndex(
    (entry) => typeof entry?.slug === 'string' && entry.slug === spec.slug,
  );
  const entry = triggerSpecToTomlEntry(spec);
  const next = current.slice();
  if (idx >= 0) next[idx] = entry;
  else next.push(entry);
  return { ...manifest, raw: { ...manifest.raw, triggers: next } };
}

/** Remove a trigger by slug from the manifest's triggers array. */
function removeTriggerFromManifest(
  manifest: ParsedManifest,
  slug: string,
): ParsedManifest {
  const current = Array.isArray(manifest.raw.triggers)
    ? (manifest.raw.triggers as Record<string, unknown>[])
    : [];
  const next = current.filter(
    (entry) => !(typeof entry?.slug === 'string' && entry.slug === slug),
  );
  return { ...manifest, raw: { ...manifest.raw, triggers: next } };
}

/**
 * Commit a new revision of kortix.toml to the project's default branch.
 * All trigger CRUD funnels through this — one file, one commit per edit.
 */
export async function commitManifest(
  project: ProjectRow,
  manifest: ParsedManifest,
  message: string,
): Promise<{ ok: true } | { error: string; status: number }> {
  const content = serializeManifest(manifest);
  const branch = project.defaultBranch;

  // GitHub repos: commit through the Contents API (App / PAT auth) — the
  // lightweight single-file path that doesn't need a full clone.
  const repo = parseGitHubRepoUrl(project.repoUrl);
  if (repo) {
    let auth: GitHubAuthContext | undefined;
    try {
      auth = (await resolveProjectGitAuth(project)).auth ?? undefined;
    } catch (err) {
      return { error: `GitHub auth unavailable: ${(err as Error).message || String(err)}`, status: 502 };
    }
    const existingSha = await getFileSha({ owner: repo.owner, repo: repo.repo, path: MANIFEST_FILENAME, branch, auth });
    try {
      await commitFile({
        owner: repo.owner,
        repo: repo.repo,
        path: MANIFEST_FILENAME,
        content,
        message,
        branch,
        existingSha: existingSha ?? undefined,
        auth,
      });
    } catch (err) {
      return { error: `Failed to commit ${MANIFEST_FILENAME}: ${(err as Error).message || String(err)}`, status: 502 };
    }
    invalidateProjectMirror(project.projectId);
    return { ok: true };
  }

  // Any other host (GitLab, generic HTTPS remote): commit via the git CLI.
  // The old code bailed here with "Project repo URL is
  // not a GitHub URL", which broke every manifest edit (connectors, triggers,
  // apps) on managed/self-hosted projects. Mirrors createRemoteSessionBranch's
  // GitHub-fast-path / git-CLI-fallback split.
  let gitProject: ProjectRow & { gitAuthToken: string | null };
  try {
    gitProject = await withProjectGitAuth(project);
  } catch (err) {
    return { error: `Git auth unavailable: ${(err as Error).message || String(err)}`, status: 502 };
  }
  if (!gitProject.gitAuthToken) {
    return { error: 'No git credentials available to write to the project repo', status: 502 };
  }

  try {
    await commitFileToBranch(gitProject, {
      path: MANIFEST_FILENAME,
      content,
      message,
      branch,
      authorName: 'Kortix',
      authorEmail: 'noreply@kortix.ai',
    });
  } catch (err) {
    return { error: `Failed to commit ${MANIFEST_FILENAME}: ${(err as Error).message || String(err)}`, status: 502 };
  }

  invalidateProjectMirror(project.projectId);
  return { ok: true };
}

// POST /v1/projects/:projectId/triggers
//
// Creates a new trigger file in the project repo at
// `.opencode/triggers/<slug>.md`. The slug is derived from the body's `slug`
// (or `name`) and validated for URL safety. Body shape:
//   { slug?, name, type: 'cron'|'webhook', agent?, enabled?,
//     prompt_template, cron?, timezone?, secret_env? }
projectsApp.post('/:projectId/triggers', async (c) => {
  const projectId = c.req.param('projectId');
  const body = await readBody(c);
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  // Specific IAM gate so the audit trail records the precise action.
  await assertAuthorized(loaded.userId, loaded.row.accountId, PROJECT_ACTIONS.PROJECT_TRIGGER_CREATE, { type: 'project', id: projectId });

  const draft = parseTriggerDraft(body, { existingSlug: null });
  if ('error' in draft) return c.json({ error: draft.error }, 400);

  let manifest: ParsedManifest;
  try {
    manifest = await loadManifestForEdit(loaded.row);
  } catch (err) {
    return c.json({ error: (err as Error).message || 'Failed to read manifest' }, 400);
  }

  if (extractTriggers(manifest).specs.some((s) => s.slug === draft.slug)) {
    return c.json({
      error: `A trigger with slug "${draft.slug}" already exists. Pick a different name.`,
    }, 409);
  }

  const next = upsertTriggerInManifest(manifest, draftToSpec(draft));
  const result = await commitManifest(loaded.row, next, `chore: add trigger ${draft.slug}`);
  if ('error' in result) {
    return c.json({ error: result.error }, result.status as 400 | 502);
  }

  return c.json(await loadTriggersForResponse(projectId, loaded.row), 201);
});

// PATCH /v1/projects/:projectId/triggers/:slug
projectsApp.patch('/:projectId/triggers/:slug', async (c) => {
  const projectId = c.req.param('projectId');
  const slug = c.req.param('slug');
  const body = await readBody(c);
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertAuthorized(loaded.userId, loaded.row.accountId, PROJECT_ACTIONS.PROJECT_TRIGGER_UPDATE, { type: 'project', id: projectId });

  let manifest: ParsedManifest;
  try {
    manifest = await loadManifestForEdit(loaded.row);
  } catch (err) {
    return c.json({ error: (err as Error).message || 'Failed to read manifest' }, 400);
  }
  const current = extractTriggers(manifest).specs.find((s) => s.slug === slug);
  if (!current) return c.json({ error: 'Not found' }, 404);

  // Merge the patch onto the current spec so callers can send partial bodies
  // (e.g. just `{ enabled: false }`). The parsed result becomes the new entry.
  const draft = parseTriggerDraft(
    { ...specToBody(current), ...body, slug: slug },
    { existingSlug: slug },
  );
  if ('error' in draft) return c.json({ error: draft.error }, 400);

  const next = upsertTriggerInManifest(manifest, draftToSpec(draft));
  const result = await commitManifest(loaded.row, next, `chore: update trigger ${slug}`);
  if ('error' in result) {
    return c.json({ error: result.error }, result.status as 400 | 502);
  }

  return c.json(await loadTriggersForResponse(projectId, loaded.row));
});

// DELETE /v1/projects/:projectId/triggers/:slug
projectsApp.delete('/:projectId/triggers/:slug', async (c) => {
  const projectId = c.req.param('projectId');
  const slug = c.req.param('slug');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertAuthorized(loaded.userId, loaded.row.accountId, PROJECT_ACTIONS.PROJECT_TRIGGER_DELETE, { type: 'project', id: projectId });

  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(slug)) {
    return c.json({ error: 'Invalid slug' }, 400);
  }

  let manifest: ParsedManifest;
  try {
    manifest = await loadManifestForEdit(loaded.row);
  } catch (err) {
    return c.json({ error: (err as Error).message || 'Failed to read manifest' }, 400);
  }
  if (!extractTriggers(manifest).specs.some((s) => s.slug === slug)) {
    return c.json({ error: 'Not found' }, 404);
  }

  const next = removeTriggerFromManifest(manifest, slug);
  const result = await commitManifest(loaded.row, next, `chore: delete trigger ${slug}`);
  if ('error' in result) {
    return c.json({ error: result.error }, result.status as 400 | 502);
  }

  // Drop runtime state too — a re-created trigger of the same slug should
  // start with a clean last_fired_at.
  await db
    .delete(projectTriggerRuntime)
    .where(and(
      eq(projectTriggerRuntime.projectId, projectId),
      eq(projectTriggerRuntime.slug, slug),
    ));

  return c.json({ ok: true });
});

// ─── Slack install — per project, secrets live in project_secrets ────────

interface SlackAuthTest {
  ok: boolean;
  team_id?: string;
  team?: string;
  user_id?: string;
  error?: string;
}

// GET /v1/projects/:projectId/channels/slack/installation
projectsApp.get('/:projectId/channels/slack/installation', async (c) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  const install = await loadSlackInstall(projectId);
  return c.json(install ?? null);
});

// GET /v1/projects/:projectId/channels/slack/mode
// Tells the dashboard whether one-click "Add to Slack" is available (server
// has SLACK_CLIENT_ID + SECRET + SIGNING_SECRET set) and the pre-signed
// install URL to redirect the user to.
projectsApp.get('/:projectId/channels/slack/mode', async (c) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  const mode = slackOauthMode();
  if (!mode.available) {
    return c.json({ oauth_available: false, install_url: null });
  }
  try {
    const installUrl = buildSlackInstallUrl(projectId, loaded.userId);
    return c.json({ oauth_available: true, install_url: installUrl });
  } catch {
    return c.json({ oauth_available: false, install_url: null });
  }
});

// POST /v1/projects/:projectId/channels/slack/connect
projectsApp.post('/:projectId/channels/slack/connect', async (c) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  let body: { bot_token?: string; signing_secret?: string };
  try {
    body = (await c.req.json()) as { bot_token?: string; signing_secret?: string };
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const botToken = body.bot_token?.trim();
  const signingSecret = body.signing_secret?.trim();
  if (!botToken || !botToken.startsWith('xoxb-')) {
    return c.json({ error: 'bot_token is required and must start with xoxb-' }, 400);
  }
  if (!signingSecret) {
    return c.json({ error: 'signing_secret is required' }, 400);
  }

  let authTest: SlackAuthTest;
  try {
    const res = await fetch('https://slack.com/api/auth.test', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${botToken}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
    });
    authTest = (await res.json()) as SlackAuthTest;
  } catch (err) {
    return c.json({ error: `Failed to reach Slack: ${(err as Error).message}` }, 502);
  }
  if (!authTest.ok || !authTest.team_id || !authTest.user_id) {
    return c.json({ error: `Slack rejected the token: ${authTest.error ?? 'unknown error'}` }, 400);
  }

  const summary = await saveSlackInstall({
    projectId,
    botToken,
    signingSecret,
    teamId: authTest.team_id,
    teamName: authTest.team ?? null,
    botUserId: authTest.user_id,
  });
  return c.json(summary);
});

// DELETE /v1/projects/:projectId/channels/slack/installation
projectsApp.delete('/:projectId/channels/slack/installation', async (c) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await deleteSlackInstall(projectId);
  return c.json({ status: 'disconnected' });
});

// POST /v1/projects/:projectId/turn-stream
// Agent-cli relay for the live Slack plan: kind=step appends a checkpoint,
// kind=answer finalizes the turn's streamed message with the agent's reply.
projectsApp.post('/:projectId/turn-stream', async (c) => {
  const projectId = c.req.param('projectId');

  // Two valid callers: a project-scoped PAT (dashboard or operator) and the
  // session sandbox's own KORTIX_TOKEN (so the in-sandbox agent CLI can relay
  // its plan steps without a second token). Each is scoped to one projectId.
  const authType = (c as any).get('authType') as string | undefined;
  if (authType === 'apiKey' && (c as any).get('apiKeyType') === 'sandbox') {
    const accountId = (c as any).get('accountId') as string | undefined;
    const sandboxId = (c as any).get('sandboxId') as string | undefined;
    if (!accountId || !sandboxId) {
      return c.json({ error: 'turn-stream requires a sandbox token' }, 403);
    }
    const [sandbox] = await db
      .select({ sandboxId: sessionSandboxes.sandboxId })
      .from(sessionSandboxes)
      .where(and(
        eq(sessionSandboxes.sandboxId, sandboxId),
        eq(sessionSandboxes.projectId, projectId),
        eq(sessionSandboxes.accountId, accountId),
        inArray(sessionSandboxes.status, ['provisioning', 'active']),
      ))
      .limit(1);
    if (!sandbox) {
      return c.json({ error: 'sandbox token is not scoped to this project' }, 403);
    }
  } else {
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
  }

  let body: {
    session_id?: string;
    kind?: string;
    text?: string;
    detail?: string;
    output?: string;
    sources?: Array<{ url?: string; text?: string }>;
    blocks?: unknown[];
  };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const sessionId = body.session_id?.trim();
  const text = (body.text ?? '').trim();
  if (!sessionId || !text) {
    return c.json({ error: 'session_id and text are required' }, 400);
  }

  const detail = body.detail?.trim() || undefined;
  const outputForPrev = body.output?.trim() || undefined;
  const sourcesForPrev = Array.isArray(body.sources)
    ? body.sources
        .filter((s): s is { url: string; text: string } => !!s?.url && !!s?.text)
        .map((s) => ({ url: s.url, text: s.text }))
    : undefined;
  const blocks = Array.isArray(body.blocks) && body.blocks.length > 0 ? body.blocks : undefined;

  const ok =
    body.kind === 'answer'
      ? await relayTurnAnswer(sessionId, text, blocks)
      : await relayTurnStep(sessionId, text, { detail, outputForPrev, sourcesForPrev });
  return c.json({ ok });
});

// POST /v1/projects/:projectId/turn-question
// Sandbox-to-apps/api relay for opencode's `question.asked` event. The
// sandbox subscribes to opencode's SSE stream; when the agent calls the
// built-in `question` tool, the sandbox relays the QuestionInfo[] here.
// We post a Block Kit form, block on Submit, return `answers: string[][]`,
// and the sandbox POSTs the same payload to opencode's
// /question/{requestID}/reply so the tool resumes.
projectsApp.post('/:projectId/turn-question', async (c) => {
  const projectId = c.req.param('projectId');

  const authType = (c as any).get('authType') as string | undefined;
  if (authType === 'apiKey' && (c as any).get('apiKeyType') === 'sandbox') {
    const accountId = (c as any).get('accountId') as string | undefined;
    const sandboxId = (c as any).get('sandboxId') as string | undefined;
    if (!accountId || !sandboxId) {
      return c.json({ error: 'turn-question requires a sandbox token' }, 403);
    }
    const [sandbox] = await db
      .select({ sandboxId: sessionSandboxes.sandboxId })
      .from(sessionSandboxes)
      .where(and(
        eq(sessionSandboxes.sandboxId, sandboxId),
        eq(sessionSandboxes.projectId, projectId),
        eq(sessionSandboxes.accountId, accountId),
        inArray(sessionSandboxes.status, ['provisioning', 'active']),
      ))
      .limit(1);
    if (!sandbox) {
      return c.json({ error: 'sandbox token is not scoped to this project' }, 403);
    }
  } else {
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
  }

  let body: {
    session_id?: string;
    request_id?: string;
    questions?: unknown[];
  };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const sessionId = body.session_id?.trim();
  if (!sessionId) {
    return c.json({ error: 'session_id is required' }, 400);
  }
  if (!Array.isArray(body.questions) || body.questions.length === 0) {
    return c.json({ error: 'at least one question is required' }, 400);
  }

  // Validate + coerce to QuestionInfo[]. Tolerate the v2 SDK schema variants.
  const questions: QuestionInfo[] = [];
  for (const q of body.questions) {
    if (!q || typeof q !== 'object') continue;
    const obj = q as Record<string, unknown>;
    const question = String(obj.question ?? '').trim();
    if (!question) continue;
    const optionsRaw = Array.isArray(obj.options) ? obj.options : [];
    const options = optionsRaw
      .map((o) => (o && typeof o === 'object' ? (o as Record<string, unknown>) : null))
      .filter((o): o is Record<string, unknown> => !!o && typeof o.label === 'string')
      .map((o) => ({
        label: String(o.label),
        description: typeof o.description === 'string' ? String(o.description) : undefined,
      }));
    questions.push({
      question,
      header: obj.header ? String(obj.header) : undefined,
      options,
      multiple: !!obj.multiple,
      custom: obj.custom === false ? false : true,
    });
  }
  if (questions.length === 0) {
    return c.json({ error: 'no valid questions provided' }, 400);
  }

  const result = await postQuestionAndWait(sessionId, questions);
  if (!result.ok) return c.json({ ok: false, error: result.error }, 409);
  return c.json({ ok: true, ask_id: result.ask_id, answers: result.answers });
});

// POST /v1/projects/:projectId/triggers/:slug/fire
//
// Manual fire for git-backed triggers. Reads the file, renders the prompt
// against a synthetic payload, spawns a session. Manage role required.
projectsApp.post('/:projectId/triggers/:slug/fire', async (c) => {
  const projectId = c.req.param('projectId');
  const slug = c.req.param('slug');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const { specs } = await loadProjectTriggers(await withProjectGitAuth(loaded.row));
  const spec = specs.find((s) => s.slug === slug);
  if (!spec) return c.json({ error: 'Not found' }, 404);

  const now = new Date();
  const payload = {
    trigger: { slug: spec.slug, type: spec.type, kind: 'git' },
    fired_at: now.toISOString(),
    source: 'manual',
    actor: loaded.userId,
    message: { text: '', source: 'manual_test' },
  };
  const renderedPrompt = renderPromptTemplate(spec.promptTemplate, payload);

  const result = await fireGitTrigger({
    spec,
    project: loaded.row,
    payload,
    renderedPrompt,
    source: 'manual',
    request: requestAuditContext(c),
  });

  if (result.status === 'queued') {
    return c.json({ status: 'queued', reason: result.reason ?? null }, 202);
  }
  if (result.status === 'failed') {
    return c.json({ error: result.error ?? 'Failed to fire trigger' }, 500);
  }
  await markGitTriggerFired(projectId, slug, now);
  return c.json({ status: 'fired', session_id: result.sessionId ?? null }, 202);
});

// ── [[apps]] CRUD + deploy ──────────────────────────────────────────────────
//
// Apps are declared in `[[apps]]` blocks inside kortix.toml. The manifest
// is the source of truth; the `deployments` table stores deploy attempts
// (one row per version per app). The sweep loop in ./app-sweep.ts auto-
// deploys on manifest drift; the routes below give the UI and CLI a
// manual path.
//
// EXPERIMENTAL. The entire surface is gated PER PROJECT
// (projects.metadata.apps_enabled, defaulting to KORTIX_APPS_EXPERIMENTAL).
// When off for a project, every /apps route returns 404 and the sweep skips
// it. This middleware loads the project's gate and short-circuits before any
// of the handlers below run.

const APPS_DISABLED_BODY = {
  error: 'kortix [[apps]] is experimental and disabled for this project. Enable it in Customize → Settings (or set KORTIX_APPS_EXPERIMENTAL=true to default it on).',
} as const;

async function projectAppsEnabled(projectId: string): Promise<boolean> {
  const [row] = await db
    .select({ metadata: projects.metadata })
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);
  return resolveAppsEnabled(row?.metadata);
}

projectsApp.use('/:projectId/apps/*', async (c, next) => {
  if (!(await projectAppsEnabled(c.req.param('projectId')))) {
    return c.json(APPS_DISABLED_BODY, 404);
  }
  await next();
});
projectsApp.use('/:projectId/apps', async (c, next) => {
  if (!(await projectAppsEnabled(c.req.param('projectId')))) {
    return c.json(APPS_DISABLED_BODY, 404);
  }
  await next();
});

interface AppDraft {
  slug: string;
  name: string;
  enabled: boolean;
  domains: string[];
  framework: string | null;
  source: AppSourceSpec;
  build: AppBuildSpec | null;
  env: Record<string, string>;
}

function parseAppDraft(
  body: Record<string, unknown>,
  opts: { existingSlug: string | null },
): AppDraft | { error: string } {
  const rawSlug = normalizeString((body as any).slug);
  const name = normalizeString((body as any).name) ?? rawSlug ?? opts.existingSlug ?? null;
  if (!name) return { error: 'name (or slug) is required' };

  const slug = opts.existingSlug ?? rawSlug ?? slugify(name);
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(slug)) {
    return { error: `Invalid slug "${slug}" — use letters, digits, dashes, underscores only` };
  }

  const enabled = normalizeBoolean((body as any).enabled) ?? true;

  // Domains are optional — omit them and the platform auto-issues a free
  // `*.style.dev` URL at deploy time (see defaultAppDomain). When present,
  // each entry must be a non-empty string.
  const domainsRaw = (body as any).domains;
  const domains: string[] = [];
  if (domainsRaw !== undefined && domainsRaw !== null) {
    if (!Array.isArray(domainsRaw)) {
      return { error: 'domains must be an array of strings when set' };
    }
    for (const d of domainsRaw) {
      const s = normalizeString(d);
      if (!s) return { error: 'domains entries must be non-empty strings' };
      domains.push(s);
    }
  }

  const framework = normalizeString((body as any).framework);

  const sourceBody = (body as any).source ?? {};
  if (typeof sourceBody !== 'object' || sourceBody === null || Array.isArray(sourceBody)) {
    return { error: 'source must be an object' };
  }
  const sourceType = normalizeString(sourceBody.type)?.toLowerCase();
  let source: AppSourceSpec;
  if (sourceType === 'git') {
    source = {
      type: 'git',
      repo: normalizeString(sourceBody.repo),
      branch: normalizeString(sourceBody.branch),
      rootPath: normalizeString(sourceBody.root_path ?? sourceBody.rootPath),
    };
  } else if (sourceType === 'tar') {
    const url = normalizeString(sourceBody.url);
    if (!url) return { error: 'source type="tar" requires a non-empty url' };
    source = { type: 'tar', url };
  } else {
    return { error: `source.type must be "git" or "tar" (got "${sourceType ?? 'unset'}")` };
  }

  let build: AppBuildSpec | null = null;
  const buildBody = (body as any).build;
  if (buildBody && typeof buildBody === 'object' && !Array.isArray(buildBody)) {
    const command = normalizeString(buildBody.command);
    const outDir = normalizeString(buildBody.out_dir ?? buildBody.outDir);
    if (command || outDir) build = { command, outDir };
  }

  const envBody = (body as any).env;
  const env: Record<string, string> = {};
  if (envBody && typeof envBody === 'object' && !Array.isArray(envBody)) {
    for (const [k, v] of Object.entries(envBody as Record<string, unknown>)) {
      if (typeof v !== 'string') return { error: `env.${k} must be a string` };
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) return { error: `env key "${k}" must look like an env var name` };
      env[k] = v;
    }
  }

  return { slug, name, enabled, domains, framework, source, build, env };
}

function draftToAppSpec(draft: AppDraft): AppSpec {
  return {
    slug: draft.slug,
    path: `${MANIFEST_FILENAME}#apps.${draft.slug}`,
    name: draft.name,
    enabled: draft.enabled,
    source: draft.source,
    build: draft.build,
    env: draft.env,
    domains: draft.domains,
    framework: draft.framework,
  };
}

function upsertAppInManifest(manifest: ParsedManifest, spec: AppSpec): ParsedManifest {
  const current = Array.isArray(manifest.raw.apps)
    ? (manifest.raw.apps as Record<string, unknown>[])
    : [];
  const idx = current.findIndex((entry) => typeof entry?.slug === 'string' && entry.slug === spec.slug);
  const entry = appSpecToTomlEntry(spec);
  const next = current.slice();
  if (idx >= 0) next[idx] = entry;
  else next.push(entry);
  return { ...manifest, raw: { ...manifest.raw, apps: next } };
}

function removeAppFromManifest(manifest: ParsedManifest, slug: string): ParsedManifest {
  const current = Array.isArray(manifest.raw.apps)
    ? (manifest.raw.apps as Record<string, unknown>[])
    : [];
  const next = current.filter((entry) => !(typeof entry?.slug === 'string' && entry.slug === slug));
  return { ...manifest, raw: { ...manifest.raw, apps: next } };
}

function specToAppBody(spec: AppSpec): Record<string, unknown> {
  return {
    slug: spec.slug,
    name: spec.name,
    enabled: spec.enabled,
    domains: spec.domains,
    framework: spec.framework,
    source:
      spec.source.type === 'git'
        ? {
            type: 'git',
            repo: spec.source.repo,
            branch: spec.source.branch,
            root_path: spec.source.rootPath,
          }
        : { type: 'tar', url: spec.source.url },
    build: spec.build
      ? { command: spec.build.command, out_dir: spec.build.outDir }
      : null,
    env: spec.env,
  };
}

function serializeDeploymentRow(row: typeof deployments.$inferSelect) {
  return {
    deployment_id: row.deploymentId,
    account_id: row.accountId,
    project_id: row.projectId,
    app_slug: row.appSlug,
    provider: row.provider,
    status: row.status,
    source_type: row.sourceType,
    source_ref: row.sourceRef,
    framework: row.framework,
    domains: row.domains,
    live_url: row.liveUrl,
    env_vars: row.envVars,
    build_config: row.buildConfig,
    error: row.error,
    version: row.version,
    freestyle_id: row.freestyleId,
    metadata: row.metadata,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

async function loadAppsForResponse(projectId: string, project: ProjectRow) {
  const { specs, errors } = await loadProjectApps(await withProjectGitAuth(project));
  const apps = await Promise.all(
    specs.map(async (spec) => {
      const latest = await getLatestDeployment(projectId, spec.slug);
      const desiredHash = manifestHashForApp(spec);
      const currentHash = (latest?.metadata as Record<string, unknown> | null)?.manifest_hash;
      return {
        ...specToAppBody(spec),
        path: spec.path,
        manifest_hash: desiredHash,
        // The domains the app will actually serve on — its declared domains,
        // or the auto-issued free *.style.dev URL when it declared none. Lets
        // the UI show the target address before the first deploy.
        effective_domains: resolveAppDomains(projectId, spec),
        latest_deployment: latest ? serializeDeploymentRow(latest) : null,
        drift: latest ? currentHash !== desiredHash : true,
      };
    }),
  );
  return { apps, errors };
}

// GET /v1/projects/:projectId/apps — list specs + latest deployment status
projectsApp.get('/:projectId/apps', async (c) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  return c.json(await loadAppsForResponse(projectId, loaded.row));
});

// POST /v1/projects/:projectId/apps — add a new app to kortix.toml
projectsApp.post('/:projectId/apps', async (c) => {
  const projectId = c.req.param('projectId');
  const body = await readBody(c);
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const draft = parseAppDraft(body, { existingSlug: null });
  if ('error' in draft) return c.json({ error: draft.error }, 400);

  let manifest: ParsedManifest;
  try {
    manifest = await loadManifestForEdit(loaded.row);
  } catch (err) {
    return c.json({ error: (err as Error).message || 'Failed to read manifest' }, 400);
  }

  if (extractApps(manifest).specs.some((s) => s.slug === draft.slug)) {
    return c.json({
      error: `An app with slug "${draft.slug}" already exists. Pick a different name.`,
    }, 409);
  }

  const next = upsertAppInManifest(manifest, draftToAppSpec(draft));
  const result = await commitManifest(loaded.row, next, `chore: add app ${draft.slug}`);
  if ('error' in result) {
    return c.json({ error: result.error }, result.status as 400 | 502);
  }

  return c.json(await loadAppsForResponse(projectId, loaded.row), 201);
});

// PATCH /v1/projects/:projectId/apps/:slug — partial update merged onto current
projectsApp.patch('/:projectId/apps/:slug', async (c) => {
  const projectId = c.req.param('projectId');
  const slug = c.req.param('slug');
  const body = await readBody(c);
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  let manifest: ParsedManifest;
  try {
    manifest = await loadManifestForEdit(loaded.row);
  } catch (err) {
    return c.json({ error: (err as Error).message || 'Failed to read manifest' }, 400);
  }
  const current = extractApps(manifest).specs.find((s) => s.slug === slug);
  if (!current) return c.json({ error: 'Not found' }, 404);

  const draft = parseAppDraft(
    { ...specToAppBody(current), ...body, slug },
    { existingSlug: slug },
  );
  if ('error' in draft) return c.json({ error: draft.error }, 400);

  const next = upsertAppInManifest(manifest, draftToAppSpec(draft));
  const result = await commitManifest(loaded.row, next, `chore: update app ${slug}`);
  if ('error' in result) {
    return c.json({ error: result.error }, result.status as 400 | 502);
  }

  return c.json(await loadAppsForResponse(projectId, loaded.row));
});

// DELETE /v1/projects/:projectId/apps/:slug — remove from manifest. Does
// NOT auto-stop existing deployments; call /apps/:slug/stop first if needed.
projectsApp.delete('/:projectId/apps/:slug', async (c) => {
  const projectId = c.req.param('projectId');
  const slug = c.req.param('slug');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(slug)) {
    return c.json({ error: 'Invalid slug' }, 400);
  }

  let manifest: ParsedManifest;
  try {
    manifest = await loadManifestForEdit(loaded.row);
  } catch (err) {
    return c.json({ error: (err as Error).message || 'Failed to read manifest' }, 400);
  }
  if (!extractApps(manifest).specs.some((s) => s.slug === slug)) {
    return c.json({ error: 'Not found' }, 404);
  }

  const next = removeAppFromManifest(manifest, slug);
  const result = await commitManifest(loaded.row, next, `chore: delete app ${slug}`);
  if ('error' in result) {
    return c.json({ error: result.error }, result.status as 400 | 502);
  }
  return c.json({ ok: true });
});

// POST /v1/projects/:projectId/apps/:slug/deploy — manual deploy. Mirrors
// what the sweep does on drift but bypasses the hash-equality skip.
projectsApp.post('/:projectId/apps/:slug/deploy', async (c) => {
  const projectId = c.req.param('projectId');
  const slug = c.req.param('slug');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const { specs } = await loadProjectApps(await withProjectGitAuth(loaded.row));
  const spec = specs.find((s) => s.slug === slug);
  if (!spec) return c.json({ error: 'Not found' }, 404);

  const latest = await getLatestDeployment(projectId, slug);
  const status = await deployAppSpec({
    project: loaded.row,
    spec,
    previousVersion: latest?.version ?? 0,
    manifestHash: manifestHashForApp(spec),
    source: 'manual',
  });

  const fresh = await getLatestDeployment(projectId, slug);
  return c.json(
    {
      status,
      app_slug: slug,
      deployment: fresh ? serializeDeploymentRow(fresh) : null,
    },
    status === 'active' ? 201 : 502,
  );
});

// POST /v1/projects/:projectId/apps/:slug/stop — tear down the latest
// deployment on the provider. Marks the row 'stopped' locally even if
// the provider call fails (best-effort).
projectsApp.post('/:projectId/apps/:slug/stop', async (c) => {
  const projectId = c.req.param('projectId');
  const slug = c.req.param('slug');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const latest = await getLatestDeployment(projectId, slug);
  if (!latest) return c.json({ error: 'No deployment found for this app' }, 404);

  const provider = getDeploymentProvider(latest.provider ?? undefined);
  if (latest.freestyleId) {
    try {
      await provider.stop(latest.freestyleId);
    } catch {
      // Best-effort — mark as stopped locally regardless.
    }
  }

  const [updated] = await db
    .update(deployments)
    .set({ status: 'stopped', updatedAt: new Date() })
    .where(eq(deployments.deploymentId, latest.deploymentId))
    .returning();

  return c.json({ ok: true, deployment: updated ? serializeDeploymentRow(updated) : null });
});

// GET /v1/projects/:projectId/apps/:slug/logs — provider logs for the
// latest deployment.
projectsApp.get('/:projectId/apps/:slug/logs', async (c) => {
  const projectId = c.req.param('projectId');
  const slug = c.req.param('slug');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const latest = await getLatestDeployment(projectId, slug);
  if (!latest) return c.json({ error: 'No deployment found for this app' }, 404);

  const provider = getDeploymentProvider(latest.provider ?? undefined);
  try {
    const data = await provider.logs(latest.freestyleId ?? '');
    return c.json({ ok: true, data });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : 'logs unavailable' }, 502);
  }
});

// GET /v1/projects/:projectId
projectsApp.get('/:projectId', async (c) => {
  const projectId = c.req.param('projectId');

  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  await db
    .update(projects)
    .set({ lastOpenedAt: new Date(), updatedAt: new Date() })
    .where(eq(projects.projectId, projectId));

  return c.json(serializeProject(loaded.row, {
    projectRole: loaded.projectRole,
    effectiveRole: loaded.effectiveRole,
  }));
});

// GET /v1/projects/:projectId/detail
projectsApp.get('/:projectId/detail', async (c) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const gitProject = await withProjectGitAuth(loaded.row);
  let files: Awaited<ReturnType<typeof listRepoFiles>> = [];
  try {
    files = await listRepoFiles(gitProject, loaded.row.defaultBranch);
  } catch (error) {
    console.warn('[projects] repo detail listing unavailable', {
      projectId,
      error: error instanceof Error ? error.message : String(error),
    });
    c.header('X-Kortix-Repo-Status', 'unavailable');
  }
  const config = await loadProjectConfig(gitProject, files);
  return c.json({
    project: serializeProject(loaded.row, {
      projectRole: loaded.projectRole,
      effectiveRole: loaded.effectiveRole,
    }),
    git_connection: serializeProjectGitConnection(await getProjectGitConnection(projectId)),
    config,
    file_count: files.length,
    files: files.slice(0, 300),
  });
});

// GET /v1/projects/:projectId/files
projectsApp.get('/:projectId/files', async (c) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const gitProject = await withProjectGitAuth(loaded.row);
  let files: Awaited<ReturnType<typeof listRepoFiles>> = [];
  try {
    files = await listRepoFiles(gitProject, c.req.query('ref') || loaded.row.defaultBranch, c.req.query('path'));
  } catch (error) {
    console.warn('[projects] repo file listing unavailable', {
      projectId,
      error: error instanceof Error ? error.message : String(error),
    });
    c.header('X-Kortix-Repo-Status', 'unavailable');
  }
  return c.json(files.slice(0, 1000));
});

// GET /v1/projects/:projectId/files/archive?path=...&ref=...
// Streams a zip archive of the repo (or a subtree) at the given ref.
projectsApp.get('/:projectId/files/archive', async (c) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const path = normalizeString(c.req.query('path'));
  const ref = c.req.query('ref') || loaded.row.defaultBranch;

  try {
    const stream = await archiveRepoSubtree(await withProjectGitAuth(loaded.row), ref, path);
    const fileName = (path?.split('/').filter(Boolean).pop() || 'workspace') + '.zip';
    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${fileName.replace(/"/g, '')}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to archive directory';
    return c.json({ error: message }, 400);
  }
});

// GET /v1/projects/:projectId/files/content?path=...
projectsApp.get('/:projectId/files/search', async (c) => {
  const projectId = c.req.param('projectId');
  const query = normalizeString(c.req.query('q'));
  if (!query) return c.json({ error: 'q query param is required' }, 400);

  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const contentSearch = c.req.query('content') === '1';
  const ref = c.req.query('ref') || loaded.row.defaultBranch;
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 200);

  try {
    const gitProject = await withProjectGitAuth(loaded.row);
    if (contentSearch) {
      const matches = await grepRepoFiles(gitProject, query, ref, limit);
      return c.json({ query, ref, content_search: true, results: matches });
    }
    const files = await searchRepoFileNames(gitProject, query, ref, limit);
    return c.json({
      query,
      ref,
      content_search: false,
      results: files.map((f) => ({ path: f.path })),
    });
  } catch (error) {
    console.warn('[projects] file search unavailable', {
      projectId,
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json({ query, ref, content_search: contentSearch, results: [] });
  }
});

projectsApp.get('/:projectId/files/content', async (c) => {
  const projectId = c.req.param('projectId');
  const path = normalizeString(c.req.query('path'));
  if (!path) return c.json({ error: 'path query param is required' }, 400);
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const ref = c.req.query('ref') || loaded.row.defaultBranch;
  const content = await readRepoFile(await withProjectGitAuth(loaded.row), path, ref);
  return c.json({ path, ref, content });
});

// GET /v1/projects/:projectId/files/history?path=...&ref=...&limit=...&skip=...
projectsApp.get('/:projectId/files/history', async (c) => {
  const projectId = c.req.param('projectId');
  const path = normalizeString(c.req.query('path'));
  if (!path) return c.json({ error: 'path query param is required' }, 400);
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const ref = c.req.query('ref') || loaded.row.defaultBranch;
  const limit = Number(c.req.query('limit') || '50');
  const skip = Number(c.req.query('skip') || '0');
  try {
    const result = await getFileHistory(await withProjectGitAuth(loaded.row), path, { ref, limit, skip });
    return c.json({ path, ref, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load history';
    return c.json({ error: message }, 400);
  }
});

// GET /v1/projects/:projectId/branches
projectsApp.get('/:projectId/branches', async (c) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  try {
    const branches = await listBranches(await withProjectGitAuth(loaded.row));
    return c.json({
      default_branch: loaded.row.defaultBranch,
      branches,
    });
  } catch (error) {
    console.warn('[projects] branch listing unavailable', {
      projectId,
      error: error instanceof Error ? error.message : String(error),
    });
    c.header('X-Kortix-Repo-Status', 'unavailable');
    return c.json({ default_branch: loaded.row.defaultBranch, branches: [] });
  }
});

// GET /v1/projects/:projectId/commits?ref=...&path=...&limit=...&skip=...
projectsApp.get('/:projectId/commits', async (c) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const ref = c.req.query('ref') || loaded.row.defaultBranch;
  const path = normalizeString(c.req.query('path'));
  const limit = Number(c.req.query('limit') || '50');
  const skip = Number(c.req.query('skip') || '0');
  try {
    const result = await listCommits(await withProjectGitAuth(loaded.row), { ref, path, limit, skip });
    return c.json({ ref, path: path ?? null, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load commits';
    return c.json({ error: message }, 400);
  }
});

// GET /v1/projects/:projectId/commits/:sha
projectsApp.get('/:projectId/commits/:sha', async (c) => {
  const projectId = c.req.param('projectId');
  const sha = c.req.param('sha');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  try {
    const commit = await getCommit(await withProjectGitAuth(loaded.row), sha);
    if (!commit) return c.json({ error: 'Commit not found' }, 404);
    return c.json(commit);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load commit';
    return c.json({ error: message }, 400);
  }
});

// GET /v1/projects/:projectId/commits/:sha/diff?path=...
projectsApp.get('/:projectId/commits/:sha/diff', async (c) => {
  const projectId = c.req.param('projectId');
  const sha = c.req.param('sha');
  const path = normalizeString(c.req.query('path'));
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  try {
    const diff = await getCommitDiff(await withProjectGitAuth(loaded.row), sha, { path });
    return c.json({ path: path ?? null, ...diff });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load diff';
    return c.json({ error: message }, 400);
  }
});

// GET /v1/projects/:projectId/version-diff?from=<ref>&into=<ref>
// Lightweight preview used by the "Open change request" dialog so the user
// can see whether there's anything to merge BEFORE creating the CR. Returns
// a summary (no patch body) so the dialog can show "X files changed, +Y -Z"
// live and gate the submit button.
projectsApp.get('/:projectId/version-diff', async (c) => {
  const projectId = c.req.param('projectId');
  const fromRef = normalizeString(c.req.query('from') ?? c.req.query('head'));
  const intoRef = normalizeString(c.req.query('into') ?? c.req.query('base'));
  if (!fromRef || !intoRef) {
    return c.json({ error: 'from and into query params are required' }, 400);
  }
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  if (fromRef === intoRef) {
    return c.json({
      from: fromRef,
      into: intoRef,
      from_sha: null,
      into_sha: null,
      merge_base: null,
      files_changed: 0,
      additions: 0,
      deletions: 0,
      is_up_to_date: true,
      is_same_ref: true,
    });
  }

  try {
    const diff = await getBranchDiff(await withProjectGitAuth(loaded.row), intoRef, fromRef);
    return c.json({
      from: fromRef,
      into: intoRef,
      from_sha: diff.head_sha,
      into_sha: diff.base_sha,
      merge_base: diff.merge_base,
      files_changed: diff.files_changed,
      additions: diff.additions,
      deletions: diff.deletions,
      is_up_to_date: diff.head_sha === diff.base_sha,
      is_same_ref: false,
    });
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Failed to compute diff preview',
    }, 400);
  }
});

// PATCH /v1/projects/:projectId
projectsApp.patch('/:projectId', async (c) => {
  const projectId = c.req.param('projectId');
  const body = await readBody(c);
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const updates: Partial<typeof projects.$inferInsert> = { updatedAt: new Date() };
  const name = normalizeString(body.name);
  const defaultBranch = normalizeString(body.default_branch ?? body.defaultBranch);
  const manifestPath = normalizeString(body.manifest_path ?? body.manifestPath);

  if (name) updates.name = name;
  if (defaultBranch) updates.defaultBranch = defaultBranch;
  if (manifestPath) updates.manifestPath = manifestPath;

  const [row] = await db
    .update(projects)
    .set(updates)
    .where(eq(projects.projectId, projectId))
    .returning();

  if (!row || row.status === 'archived') return c.json({ error: 'Not found' }, 404);
  return c.json(serializeProject(row, {
    projectRole: loaded.projectRole,
    effectiveRole: loaded.effectiveRole,
  }));
});

// GET /v1/projects/:projectId/warm-pool
// Live warm pool config + status for the Customize → Sandbox card: how many
// sandboxes are ready (parked) vs warming (booting) right now.
projectsApp.get('/:projectId/warm-pool', async (c) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  const cfg = resolveWarmConfig(loaded.row.metadata);
  const counts = warmPoolEnabled() ? await getWarmPoolCounts(projectId) : { ready: 0, warming: 0 };
  return c.json({ available: warmPoolEnabled(), enabled: cfg.enabled, size: cfg.size, ...counts });
});

// PATCH /v1/projects/:projectId/warm-pool
// Per-project warm pool config (Customize → Sandbox). DB-only — stored in
// projects.metadata.warm_pool, never in kortix.toml. Applies immediately by
// kicking a refill toward the new desired size.
projectsApp.patch('/:projectId/warm-pool', async (c) => {
  const projectId = c.req.param('projectId');
  const body = await readBody(c);
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const meta = (loaded.row.metadata ?? {}) as Record<string, unknown>;
  const prev = (meta.warm_pool && typeof meta.warm_pool === 'object' && !Array.isArray(meta.warm_pool)
    ? meta.warm_pool
    : {}) as Record<string, unknown>;
  const enabled =
    typeof body.enabled === 'boolean' ? body.enabled : typeof prev.enabled === 'boolean' ? prev.enabled : true;
  let size =
    body.size !== undefined && Number.isFinite(Number(body.size))
      ? Math.floor(Number(body.size))
      : typeof prev.size === 'number'
        ? prev.size
        : config.KORTIX_WARM_POOL_SIZE;
  if (size < 0) size = 0;
  if (size > 25) size = 25;
  const warm_pool = { enabled, size };

  const [row] = await db
    .update(projects)
    .set({ metadata: { ...meta, warm_pool }, updatedAt: new Date() })
    .where(eq(projects.projectId, projectId))
    .returning();
  if (!row) return c.json({ error: 'Not found' }, 404);
  void refillProjectPool(projectId).catch(() => {});
  return c.json(serializeProject(row, { projectRole: loaded.projectRole, effectiveRole: loaded.effectiveRole }));
});

// PATCH /v1/projects/:projectId/apps-config
// Per-project toggle for the experimental [[apps]] deployment surface
// (Customize → Settings). DB-only — stored in projects.metadata.apps_enabled,
// never in kortix.toml. Overrides the operator default KORTIX_APPS_EXPERIMENTAL.
// `enabled: null` clears the override and falls back to the operator default.
projectsApp.patch('/:projectId/apps-config', async (c) => {
  const projectId = c.req.param('projectId');
  const body = await readBody(c);
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const meta = (loaded.row.metadata ?? {}) as Record<string, unknown>;
  const nextMeta: Record<string, unknown> = { ...meta };
  if (body.enabled === null) {
    delete nextMeta.apps_enabled;
  } else if (typeof body.enabled === 'boolean') {
    nextMeta.apps_enabled = body.enabled;
  } else {
    return c.json({ error: 'enabled must be a boolean or null' }, 400);
  }

  const [row] = await db
    .update(projects)
    .set({ metadata: nextMeta, updatedAt: new Date() })
    .where(eq(projects.projectId, projectId))
    .returning();
  if (!row || row.status === 'archived') return c.json({ error: 'Not found' }, 404);
  return c.json(serializeProject(row, { projectRole: loaded.projectRole, effectiveRole: loaded.effectiveRole }));
});

// PATCH /v1/projects/:projectId/onboarding
// Persist whether the project's guided onboarding wizard has been completed
// (or explicitly skipped). Stored in `metadata.onboarding_completed_at` so we
// avoid a schema migration — the projects.metadata jsonb already exists and
// is already exposed by serializeProject. Project-wide state (not per-user).
projectsApp.patch('/:projectId/onboarding', async (c) => {
  const projectId = c.req.param('projectId');
  const body = await readBody(c);
  const loaded = await loadProjectForUser(c, projectId, 'write');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const completed = body.completed === true;
  const previousMetadata = (loaded.row.metadata ?? {}) as Record<string, unknown>;
  const nextMetadata: Record<string, unknown> = { ...previousMetadata };
  if (completed) {
    nextMetadata.onboarding_completed_at = new Date().toISOString();
  } else {
    delete nextMetadata.onboarding_completed_at;
  }

  const [row] = await db
    .update(projects)
    .set({ metadata: nextMetadata, updatedAt: new Date() })
    .where(eq(projects.projectId, projectId))
    .returning();

  if (!row || row.status === 'archived') return c.json({ error: 'Not found' }, 404);
  return c.json(serializeProject(row, {
    projectRole: loaded.projectRole,
    effectiveRole: loaded.effectiveRole,
  }));
});

// DELETE /v1/projects/:projectId
projectsApp.delete('/:projectId', async (c) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  // Deletion is admin-only. Project Editor explicitly excludes
  // project.delete; loadProjectForUser('manage') would otherwise let
  // editors through via project.write.
  await assertAuthorized(loaded.userId, loaded.row.accountId, PROJECT_ACTIONS.PROJECT_DELETE, { type: 'project', id: projectId });

  const [row] = await db
    .update(projects)
    .set({ status: 'archived', updatedAt: new Date() })
    .where(eq(projects.projectId, projectId))
    .returning();

  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json({ ok: true });
});

// GET /v1/projects/:projectId/access
// Lists every account member and their explicit/effective project access.
projectsApp.get('/:projectId/access', async (c) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const [accountRows, grantRows, projectGroupRows] = await Promise.all([
    db
      .select({
        userId: accountMembers.userId,
        accountRole: accountMembers.accountRole,
        joinedAt: accountMembers.joinedAt,
      })
      .from(accountMembers)
      .where(eq(accountMembers.accountId, loaded.row.accountId)),
    db
      .select({
        userId: projectMembers.userId,
        projectRole: projectMembers.projectRole,
        grantedBy: projectMembers.grantedBy,
        createdAt: projectMembers.createdAt,
        updatedAt: projectMembers.updatedAt,
        expiresAt: projectMembers.expiresAt,
      })
      .from(projectMembers)
      .where(eq(projectMembers.projectId, loaded.row.projectId)),
    // V2 group grants attached to this project. Each row lifts everyone in
    // the group to at least the grant's role on this project. Per-user
    // membership lookup happens below; we fetch group → role mapping +
    // name in one shot here so we can label sources on the response.
    db
      .select({
        groupId: projectGroupGrants.groupId,
        groupName: accountGroups.name,
        role: projectGroupGrants.role,
      })
      .from(projectGroupGrants)
      .innerJoin(accountGroups, eq(accountGroups.groupId, projectGroupGrants.groupId))
      .where(eq(projectGroupGrants.projectId, loaded.row.projectId)),
  ]);

  // For every grant-bearing group, fetch its members so we can fold their
  // inherited role into each user's effective access. One round-trip
  // covering all groups at once.
  const grantGroupIds = projectGroupRows.map((g) => g.groupId);
  const groupMemberRows = grantGroupIds.length
    ? await db
        .select({
          groupId: accountGroupMembers.groupId,
          userId: accountGroupMembers.userId,
        })
        .from(accountGroupMembers)
        .where(inArray(accountGroupMembers.groupId, grantGroupIds))
    : [];

  // Index: userId → list of { group_id, group_name, role } that contribute.
  type GroupSource = { group_id: string; group_name: string; role: ProjectRole };
  const groupSourcesByUser = new Map<string, GroupSource[]>();
  const grantByGroup = new Map(
    projectGroupRows.map((g) => [g.groupId, g] as const),
  );
  for (const m of groupMemberRows) {
    const grant = grantByGroup.get(m.groupId);
    if (!grant) continue;
    const arr = groupSourcesByUser.get(m.userId) ?? [];
    arr.push({
      group_id: grant.groupId,
      group_name: grant.groupName,
      role: grant.role as ProjectRole,
    });
    groupSourcesByUser.set(m.userId, arr);
  }

  const emails = await lookupEmailsByUserIds(accountRows.map((r) => r.userId));
  const grantsByUser = new Map(grantRows.map((r) => [r.userId, r]));
  const rank: Record<AccountRole, number> = { owner: 0, admin: 1, member: 2 };

  const members = accountRows
    .map((member) => {
      const accountRole = member.accountRole as AccountRole;
      const grant = grantsByUser.get(member.userId);
      const projectRole = (grant?.projectRole as ProjectRole | undefined) ?? null;
      const groupSources = groupSourcesByUser.get(member.userId) ?? [];

      // Pure fold — see projects/access.ts for the precedence rules.
      const fold = foldEffectiveProjectAccess({
        accountRole,
        directRole: projectRole,
        groupSources,
      });

      return {
        user_id: member.userId,
        email: emails.get(member.userId) ?? null,
        account_role: accountRole,
        project_role: projectRole,
        effective_project_role: fold.effective_project_role,
        has_implicit_access: isAccountManager(accountRole),
        /** What ultimately decided the effective role. UI labels with
         *  it: "Manager (account admin)" vs "Editor (via Engineering)". */
        effective_source: fold.effective_source,
        /** Every group attachment that includes this user. Lets the UI
         *  list multi-source access ("Editor via Engineering + Viewer
         *  via Viewers") without further API calls. */
        group_sources: fold.group_sources,
        expires_at: grant?.expiresAt?.toISOString() ?? null,
        joined_at: member.joinedAt.toISOString(),
        granted_by: grant?.grantedBy ?? null,
        granted_at: grant?.createdAt?.toISOString() ?? null,
        updated_at: grant?.updatedAt?.toISOString() ?? null,
      };
    })
    .sort((a, b) => {
      const roleDelta = rank[a.account_role] - rank[b.account_role];
      if (roleDelta !== 0) return roleDelta;
      return (a.email ?? a.user_id).localeCompare(b.email ?? b.user_id);
    });

  return c.json({
    project_id: loaded.row.projectId,
    account_id: loaded.row.accountId,
    can_manage: roleAllows(loaded.effectiveRole, 'manage'),
    viewer_user_id: loaded.userId,
    members,
  });
});

// PUT /v1/projects/:projectId/access/:userId
// POST /v1/projects/:projectId/access/invite
// Invite a person to a project by email: looks up their Kortix account, ensures
// they're an org member (creating a 'member' org row if needed), then grants the
// project role. Account managers get implicit project access (no explicit grant).
projectsApp.post('/:projectId/access/invite', async (c) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const body = await readBody(c);
  const email = (typeof body.email === 'string' ? body.email : '').trim().toLowerCase();
  const role = parseProjectRole(body.role);
  if (!email) return c.json({ error: 'email is required' }, 400);
  if (!role) return c.json({ error: 'role must be one of manager|editor|viewer' }, 400);
  const expires = parseExpiresAtBody(body.expires_at);
  if (!expires.ok) return c.json({ error: expires.error }, 400);

  const targetUserId = await lookupUserIdByEmail(email);
  if (!targetUserId) {
    // No Kortix user yet. Upsert an account invitation carrying a
    // bootstrap_grant so when they accept, they're added to the org
    // AND granted the project role in one step — no separate "invite
    // to org, then invite to project" dance. The unique index on
    // (account_id, email) makes this idempotent; re-inviting the
    // same email to a second project merges the grants list.
    const bootstrap = {
      project_id: projectId,
      role,
      ...(expires.value
        ? { expires_at: expires.value.toISOString() }
        : {}),
    };
    // Wrap the find-or-create in a transaction with SELECT … FOR UPDATE
    // so two concurrent admins inviting the same email can't both see
    // the same pre-state and produce a last-write-wins merge that
    // drops one of their grants. The lock blocks the second admin's
    // SELECT until the first transaction commits; the second admin
    // then sees the first's grant and merges on top of it.
    const inviteId = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({
          inviteId: accountInvitations.inviteId,
          bootstrapGrants: accountInvitations.bootstrapGrants,
        })
        .from(accountInvitations)
        .where(
          and(
            eq(accountInvitations.accountId, loaded.row.accountId),
            sql`lower(${accountInvitations.email}) = ${email}`,
            isNull(accountInvitations.acceptedAt),
          ),
        )
        .for('update')
        .limit(1);
      if (existing) {
        // Merge bootstrap grants by project_id (later wins on role).
        const merged = [...(existing.bootstrapGrants ?? [])];
        const idx = merged.findIndex((g) => g.project_id === projectId);
        if (idx >= 0) merged[idx] = bootstrap;
        else merged.push(bootstrap);
        await tx
          .update(accountInvitations)
          .set({ bootstrapGrants: merged })
          .where(eq(accountInvitations.inviteId, existing.inviteId));
        return existing.inviteId;
      }
      const [created] = await tx
        .insert(accountInvitations)
        .values({
          accountId: loaded.row.accountId,
          email,
          invitedBy: loaded.userId,
          initialRole: 'member',
          bootstrapGrants: [bootstrap],
        })
        .returning({ inviteId: accountInvitations.inviteId });
      return created.inviteId;
    });

    // Fire the invite email — same transport + template as account-level
    // invites, framed around this project. Best-effort: the invitation row
    // already exists, so on skip/failure we still return the invite_url for
    // the inviter to share the link manually (mirrors the account route).
    const callerEmail = (c.get('userEmail') as string | undefined) ?? null;
    const [accountRow] = await db
      .select({ name: accounts.name })
      .from(accounts)
      .where(eq(accounts.accountId, loaded.row.accountId))
      .limit(1);
    const delivery = await sendAccountInviteEmail({
      email,
      accountName: accountRow?.name ?? 'Kortix',
      inviterEmail: callerEmail,
      inviteId,
      role,
      projectName: loaded.row.name,
    });
    const emailSent = delivery.ok === true;

    return c.json(
      {
        status: 'invited',
        email,
        invite_id: inviteId,
        project_role: role,
        invite_url: buildInviteUrl(inviteId),
        email_sent: emailSent,
        email_skip_reason:
          delivery.ok === false && 'reason' in delivery ? delivery.reason : null,
        message: emailSent
          ? `No Kortix account for that email yet — an invitation email has been sent. They'll land on this project as ${role} when they sign up.`
          : `No Kortix account for that email yet — invitation created. Share the invite link with them; they'll land on this project as ${role} when they sign up.`,
      },
      201,
    );
  }

  const targetAccountRole = await ensureOrgMembership(loaded.row.accountId, targetUserId);
  if (isAccountManager(targetAccountRole)) {
    return c.json({
      user_id: targetUserId,
      email,
      account_role: targetAccountRole,
      project_role: null,
      effective_project_role: 'manager',
      has_implicit_access: true,
    });
  }

  await grantProjectRole({
    accountId: loaded.row.accountId,
    projectId,
    userId: targetUserId,
    role,
    grantedBy: loaded.userId,
    expiresAt: expires.value,
  });

  return c.json({
    user_id: targetUserId,
    email,
    account_role: targetAccountRole,
    project_role: role,
    effective_project_role: role,
    has_implicit_access: false,
  });
});

// GET /v1/projects/:projectId/access/pending-invites
// Lists pending account_invitations whose bootstrap_grants target this
// project. Surfaces the "I invited someone whose email doesn't have a
// Kortix account yet" intermediate state — without this the UI looks
// the same before and after a successful invite, leaving the inviter
// to wonder if anything happened.
//
// Restricted to project managers — viewers don't need to see who's
// queued up for membership.
projectsApp.get('/:projectId/access/pending-invites', async (c) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertAuthorized(loaded.userId, loaded.row.accountId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE, { type: 'project', id: projectId });

  // JSONB containment check (`@>`) finds invitations whose grants array
  // contains an entry with this project_id. Includes expired invites in
  // the result with a flag so the UI can show them dimmed + a "Resend"
  // affordance later if we want it (out of scope for now — just hide).
  const rows = await db
    .select({
      inviteId: accountInvitations.inviteId,
      email: accountInvitations.email,
      initialRole: accountInvitations.initialRole,
      invitedBy: accountInvitations.invitedBy,
      createdAt: accountInvitations.createdAt,
      expiresAt: accountInvitations.expiresAt,
      bootstrapGrants: accountInvitations.bootstrapGrants,
    })
    .from(accountInvitations)
    .where(
      and(
        eq(accountInvitations.accountId, loaded.row.accountId),
        isNull(accountInvitations.acceptedAt),
        sql`${accountInvitations.bootstrapGrants} @> ${JSON.stringify([{ project_id: projectId }])}::jsonb`,
      ),
    );

  // Resolve inviter emails in one shot (one auth.admin call per inviter
  // since the Supabase helper has no batch API; the set is tiny in
  // practice — usually 1 or 2 distinct admins).
  const inviterIds = Array.from(
    new Set(rows.map((r) => r.invitedBy).filter((v): v is string => !!v)),
  );
  const inviterEmails = await lookupEmailsByUserIds(inviterIds);

  const now = Date.now();
  const items = rows
    .map((r) => {
      const grant = (r.bootstrapGrants ?? []).find((g) => g.project_id === projectId);
      // Defensive — the WHERE already filtered for project_id, but the
      // type system doesn't know that, and a corrupt row shouldn't 500.
      if (!grant) return null;
      return {
        invite_id: r.inviteId,
        email: r.email,
        project_role: grant.role as 'manager' | 'editor' | 'viewer',
        expires_at: grant.expires_at ?? null,
        invited_by_email: r.invitedBy ? (inviterEmails.get(r.invitedBy) ?? null) : null,
        created_at: r.createdAt.toISOString(),
        invite_expires_at: r.expiresAt.toISOString(),
        invite_expired: r.expiresAt.getTime() <= now,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  return c.json({ pending: items });
});

// DELETE /v1/projects/:projectId/access/pending-invites/:inviteId
// Removes this project's bootstrap_grant from a pending invitation. If
// that was the only grant AND the invitation is the auto-created
// "member" variety (always how project /access/invite creates them), the
// whole invitation row goes away — the user simply isn't being invited
// anywhere anymore. If the inviter had set a higher initial_role
// (admin/owner) or other project grants remain, we keep the invitation
// and just strip this project from it.
projectsApp.delete('/:projectId/access/pending-invites/:inviteId', async (c) => {
  const projectId = c.req.param('projectId');
  const inviteId = c.req.param('inviteId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertAuthorized(loaded.userId, loaded.row.accountId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE, { type: 'project', id: projectId });

  const [invite] = await db
    .select({
      inviteId: accountInvitations.inviteId,
      accountId: accountInvitations.accountId,
      initialRole: accountInvitations.initialRole,
      acceptedAt: accountInvitations.acceptedAt,
      bootstrapGrants: accountInvitations.bootstrapGrants,
    })
    .from(accountInvitations)
    .where(eq(accountInvitations.inviteId, inviteId))
    .limit(1);

  if (!invite || invite.accountId !== loaded.row.accountId) {
    return c.json({ error: 'Invitation not found' }, 404);
  }
  if (invite.acceptedAt) {
    return c.json({ error: 'Invitation has already been accepted' }, 409);
  }

  const remaining = (invite.bootstrapGrants ?? []).filter(
    (g) => g.project_id !== projectId,
  );

  // Auto-cancel the whole invitation if (a) nothing else is being
  // granted AND (b) the original invite was for a plain member (which
  // is the only role our project invite endpoint creates). Anything
  // higher-tier must have been set deliberately at the account level
  // and shouldn't be silently dropped.
  if (remaining.length === 0 && invite.initialRole === 'member') {
    await db
      .delete(accountInvitations)
      .where(eq(accountInvitations.inviteId, inviteId));
    return c.json({ ok: true, invitation_cancelled: true });
  }

  await db
    .update(accountInvitations)
    .set({ bootstrapGrants: remaining })
    .where(eq(accountInvitations.inviteId, inviteId));

  return c.json({ ok: true, invitation_cancelled: false });
});

// POST /v1/projects/:projectId/access/pending-invites/:inviteId/resend
// Re-sends the project invite email and refreshes the invitation's 14-day
// expiry. Mirrors the account-level resend, but re-frames the email around
// this project and reads the role from the bootstrap grant for this project.
projectsApp.post('/:projectId/access/pending-invites/:inviteId/resend', async (c) => {
  const projectId = c.req.param('projectId');
  const inviteId = c.req.param('inviteId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertAuthorized(loaded.userId, loaded.row.accountId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE, { type: 'project', id: projectId });

  const [invite] = await db
    .select({
      inviteId: accountInvitations.inviteId,
      accountId: accountInvitations.accountId,
      email: accountInvitations.email,
      acceptedAt: accountInvitations.acceptedAt,
      bootstrapGrants: accountInvitations.bootstrapGrants,
    })
    .from(accountInvitations)
    .where(eq(accountInvitations.inviteId, inviteId))
    .limit(1);

  if (!invite || invite.accountId !== loaded.row.accountId) {
    return c.json({ error: 'Invitation not found' }, 404);
  }
  if (invite.acceptedAt) {
    return c.json({ error: 'Invitation has already been accepted' }, 409);
  }
  const grant = (invite.bootstrapGrants ?? []).find((g) => g.project_id === projectId);
  if (!grant) {
    return c.json({ error: 'Invitation does not target this project' }, 404);
  }

  const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  await db
    .update(accountInvitations)
    .set({ expiresAt })
    .where(eq(accountInvitations.inviteId, inviteId));

  const callerEmail = (c.get('userEmail') as string | undefined) ?? null;
  const [accountRow] = await db
    .select({ name: accounts.name })
    .from(accounts)
    .where(eq(accounts.accountId, loaded.row.accountId))
    .limit(1);
  const delivery = await sendAccountInviteEmail({
    email: invite.email,
    accountName: accountRow?.name ?? 'Kortix',
    inviterEmail: callerEmail,
    inviteId: invite.inviteId,
    role: grant.role,
    projectName: loaded.row.name,
  });

  return c.json({
    ok: true,
    expires_at: expiresAt.toISOString(),
    invite_url: buildInviteUrl(invite.inviteId),
    email_sent: delivery.ok === true,
    email_skip_reason:
      delivery.ok === false && 'reason' in delivery ? delivery.reason : null,
  });
});

projectsApp.put('/:projectId/access/:userId', async (c) => {
  const projectId = c.req.param('projectId');
  const targetUserId = c.req.param('userId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  // Member management is admin-only; loadProjectForUser('manage') now
  // resolves to project.write (editor-tier), so we add an explicit
  // stricter gate here.
  await assertAuthorized(loaded.userId, loaded.row.accountId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE, { type: 'project', id: projectId });

  const body = await readBody(c);
  const role = parseProjectRole(body.role);
  if (!role) return c.json({ error: 'role must be one of manager|editor|viewer' }, 400);
  const expires = parseExpiresAtBody(body.expires_at);
  if (!expires.ok) return c.json({ error: expires.error }, 400);

  const targetMembership = await getAccountMembership(targetUserId, loaded.row.accountId);
  if (!targetMembership) {
    return c.json({ error: 'User is not a member of this account' }, 404);
  }

  const targetAccountRole = targetMembership.accountRole as AccountRole;
  if (isAccountManager(targetAccountRole)) {
    await db
      .delete(projectMembers)
      .where(and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, targetUserId),
      ));

    return c.json({
      user_id: targetUserId,
      account_role: targetAccountRole,
      project_role: null,
      effective_project_role: 'manager',
      has_implicit_access: true,
    });
  }

  await grantProjectRole({
    accountId: loaded.row.accountId,
    projectId,
    userId: targetUserId,
    role,
    grantedBy: loaded.userId,
    expiresAt: expires.value,
  });

  return c.json({
    user_id: targetUserId,
    account_role: targetAccountRole,
    project_role: role,
    effective_project_role: role,
    has_implicit_access: false,
  });
});

// DELETE /v1/projects/:projectId/access/:userId
projectsApp.delete('/:projectId/access/:userId', async (c) => {
  const projectId = c.req.param('projectId');
  const targetUserId = c.req.param('userId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertAuthorized(loaded.userId, loaded.row.accountId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE, { type: 'project', id: projectId });

  const targetMembership = await getAccountMembership(targetUserId, loaded.row.accountId);
  if (!targetMembership) {
    return c.json({ error: 'User is not a member of this account' }, 404);
  }

  const targetAccountRole = targetMembership.accountRole as AccountRole;
  if (isAccountManager(targetAccountRole)) {
    return c.json({ error: 'Owners and admins have implicit access to every project' }, 409);
  }

  await db
    .delete(projectMembers)
    .where(and(
      eq(projectMembers.projectId, projectId),
      eq(projectMembers.userId, targetUserId),
    ));

  return c.json({ ok: true });
});

// ─── Project group grants (IAM V2 bulk-access channel) ────────────────────
//
// A row in project_group_grants attaches an account_group to a project
// with a chosen project_role. Every member of the group inherits that
// role on that project.

const PROJECT_ROLES = ['manager', 'editor', 'viewer'] as const;
type ProjectGroupGrantRole = typeof PROJECT_ROLES[number];

function isProjectRole(v: unknown): v is ProjectGroupGrantRole {
  return typeof v === 'string' && (PROJECT_ROLES as readonly string[]).includes(v);
}

// GET /v1/projects/:projectId/group-grants
// List every group attached to this project, with the role + group name.
projectsApp.get('/:projectId/group-grants', async (c) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const rows = await db
    .select({
      groupId: projectGroupGrants.groupId,
      role: projectGroupGrants.role,
      grantedBy: projectGroupGrants.grantedBy,
      createdAt: projectGroupGrants.createdAt,
      expiresAt: projectGroupGrants.expiresAt,
      groupName: accountGroups.name,
    })
    .from(projectGroupGrants)
    .innerJoin(accountGroups, eq(accountGroups.groupId, projectGroupGrants.groupId))
    .where(eq(projectGroupGrants.projectId, projectId))
    // Deterministic order — without ORDER BY, Postgres can return rows
    // in heap-scan order, which shifts when the row is UPDATEd (e.g., a
    // role change). The UI list would then visibly reshuffle after a
    // role flip. Oldest attachments first matches the "Attached <date>"
    // subtitle most users scan along.
    .orderBy(asc(projectGroupGrants.createdAt), asc(projectGroupGrants.groupId));

  // Per-group member breakdown so the UI can flag attachments where the
  // grant role won't apply uniformly. When a group includes account
  // owners/admins, those users have implicit Manager on every project,
  // so the group's grant role is moot for them. Surfacing
  // override_count = N lets the project admin see at a glance "this
  // Viewer attachment doesn't actually viewer-cap 3 of these 5 people".
  const groupIds = rows.map((r) => r.groupId);
  type GroupStats = { total: number; overrideCount: number };
  const statsByGroup = new Map<string, GroupStats>();
  if (groupIds.length > 0) {
    const memberRows = await db
      .select({
        groupId: accountGroupMembers.groupId,
        accountRole: accountMembers.accountRole,
        isSuperAdmin: accountMembers.isSuperAdmin,
      })
      .from(accountGroupMembers)
      .innerJoin(
        accountMembers,
        and(
          eq(accountMembers.userId, accountGroupMembers.userId),
          eq(accountMembers.accountId, loaded.row.accountId),
        ),
      )
      .where(inArray(accountGroupMembers.groupId, groupIds));
    for (const m of memberRows) {
      const stats = statsByGroup.get(m.groupId) ?? { total: 0, overrideCount: 0 };
      stats.total += 1;
      if (
        m.isSuperAdmin ||
        m.accountRole === 'owner' ||
        m.accountRole === 'admin'
      ) {
        stats.overrideCount += 1;
      }
      statsByGroup.set(m.groupId, stats);
    }
  }

  return c.json({
    grants: rows.map((r) => {
      const stats = statsByGroup.get(r.groupId) ?? { total: 0, overrideCount: 0 };
      return {
        group_id: r.groupId,
        group_name: r.groupName,
        role: r.role,
        granted_by: r.grantedBy,
        created_at: r.createdAt.toISOString(),
        /** Auto-revoke timestamp. NULL = permanent attachment. */
        expires_at: r.expiresAt?.toISOString() ?? null,
        member_count: stats.total,
        // How many of the group's members are account owners/admins —
        // their implicit Manager access overrides this grant's role.
        override_count: stats.overrideCount,
      };
    }),
  });
});

// POST /v1/projects/:projectId/group-grants
// Attach a group to this project at the given role. Idempotent — if the
// group already has a grant, the role is updated.
projectsApp.post('/:projectId/group-grants', async (c) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertAuthorized(
    loaded.userId,
    loaded.row.accountId,
    PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE,
    { type: 'project', id: projectId },
  );

  const body = await readBody(c);
  const groupId = normalizeString(body.group_id ?? body.groupId);
  const role = body.role;
  if (!groupId) return c.json({ error: 'group_id is required' }, 400);
  if (!isProjectRole(role)) {
    return c.json({ error: 'role must be manager, editor, or viewer' }, 400);
  }
  const expires = parseExpiresAtBody(body.expires_at);
  if (!expires.ok) return c.json({ error: expires.error }, 400);

  // Confirm the group exists and belongs to this account — prevents
  // attaching a foreign-account group via a guessed UUID.
  const [group] = await db
    .select({ groupId: accountGroups.groupId })
    .from(accountGroups)
    .where(
      and(eq(accountGroups.groupId, groupId), eq(accountGroups.accountId, loaded.row.accountId)),
    )
    .limit(1);
  if (!group) return c.json({ error: 'group not found in this account' }, 404);

  const now = new Date();
  await db
    .insert(projectGroupGrants)
    .values({
      projectId,
      groupId,
      accountId: loaded.row.accountId,
      role,
      grantedBy: loaded.userId,
      expiresAt: expires.value ?? null,
    })
    .onConflictDoUpdate({
      target: [projectGroupGrants.projectId, projectGroupGrants.groupId],
      set: {
        role,
        grantedBy: loaded.userId,
        updatedAt: now,
        // Only overwrite when caller explicitly set the field.
        ...(expires.value !== undefined ? { expiresAt: expires.value } : {}),
      },
    });

  return c.json({ project_id: projectId, group_id: groupId, role }, 201);
});

// PATCH /v1/projects/:projectId/group-grants/:groupId
// Change the role on an existing attachment. Returns 404 when there's
// nothing to change.
projectsApp.patch('/:projectId/group-grants/:groupId', async (c) => {
  const projectId = c.req.param('projectId');
  const groupId = c.req.param('groupId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertAuthorized(
    loaded.userId,
    loaded.row.accountId,
    PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE,
    { type: 'project', id: projectId },
  );

  const body = await readBody(c);
  if (!isProjectRole(body.role)) {
    return c.json({ error: 'role must be manager, editor, or viewer' }, 400);
  }
  const expires = parseExpiresAtBody(body.expires_at);
  if (!expires.ok) return c.json({ error: expires.error }, 400);

  const result = await db
    .update(projectGroupGrants)
    .set({
      role: body.role,
      updatedAt: new Date(),
      ...(expires.value !== undefined ? { expiresAt: expires.value } : {}),
    })
    .where(
      and(
        eq(projectGroupGrants.projectId, projectId),
        eq(projectGroupGrants.groupId, groupId),
      ),
    )
    .returning({ groupId: projectGroupGrants.groupId });

  if (result.length === 0) return c.json({ error: 'grant not found' }, 404);
  return c.json({ project_id: projectId, group_id: groupId, role: body.role });
});

// DELETE /v1/projects/:projectId/group-grants/:groupId
// Detach a group. Members of the group lose access via this grant
// immediately; any direct project_members row they have is unaffected.
projectsApp.delete('/:projectId/group-grants/:groupId', async (c) => {
  const projectId = c.req.param('projectId');
  const groupId = c.req.param('groupId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertAuthorized(
    loaded.userId,
    loaded.row.accountId,
    PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE,
    { type: 'project', id: projectId },
  );

  await db
    .delete(projectGroupGrants)
    .where(
      and(
        eq(projectGroupGrants.projectId, projectId),
        eq(projectGroupGrants.groupId, groupId),
      ),
    );

  return c.json({ ok: true });
});

// Session routes. Invariant: session_id == sandbox_id == git branch name.

// POST /v1/projects/:projectId/sessions
projectsApp.post('/:projectId/sessions', async (c) => {
  const projectId = c.req.param('projectId');
  const body = await readBody(c);
  const loaded = await loadProjectForUser(c, projectId, 'write');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  const result = await createProjectSession({
    project: loaded.row,
    userId: loaded.userId,
    body,
    request: requestAuditContext(c),
  });
  if (result.error) return sendSessionCreateError(c, result.error);
  for (const [key, value] of Object.entries(result.headers ?? {})) {
    c.header(key, value);
  }
  return c.json(
    serializeSession(result.row!, {
      viewerId: loaded.userId,
      canManageProject: roleAllows(loaded.effectiveRole, 'manage'),
    }),
    201,
  );
});

// GET /v1/projects/:projectId/sessions
projectsApp.get('/:projectId/sessions', async (c) => {
  const projectId = c.req.param('projectId');

  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const rows = await db
    .select()
    .from(projectSessions)
    .where(and(eq(projectSessions.projectId, projectId), eq(projectSessions.accountId, loaded.row.accountId)))
    .orderBy(desc(projectSessions.updatedAt));

  // Filter to sessions the viewer may see: their own, project-wide, or ones
  // shared with them (restricted + grant). Then surface owner + sharing so the
  // list can show "shared by X".
  const subject = await resolveShareSubject(loaded.userId);
  const canManageProject = roleAllows(loaded.effectiveRole, 'manage');
  const grantsBySession = await loadSessionGrants(
    rows.filter((r) => r.visibility === 'restricted').map((r) => r.sessionId),
  );
  const visible = rows.filter((r) =>
    isSessionVisibleTo(
      r.visibility as 'private' | 'project' | 'restricted',
      r.createdBy,
      grantsBySession.get(r.sessionId) ?? [],
      subject,
    ),
  );
  // Owner emails only for sessions someone else owns (for the "shared by" label).
  const ownerIds = [...new Set(visible.map((r) => r.createdBy).filter((id): id is string => !!id && id !== loaded.userId))];
  const emails = await lookupEmailsByUserIds(ownerIds);

  return c.json(
    visible.map((r) =>
      serializeSession(r, {
        grants: grantsBySession.get(r.sessionId) ?? [],
        viewerId: loaded.userId,
        canManageProject,
        ownerEmail: r.createdBy ? emails.get(r.createdBy) ?? null : null,
      }),
    ),
  );
});

// GET /v1/projects/:projectId/sessions/:sessionId
projectsApp.get('/:projectId/sessions/:sessionId', async (c) => {
  const projectId = c.req.param('projectId');
  const sessionId = c.req.param('sessionId');
  if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const visible = await loadVisibleSession(loaded, sessionId);
  if (!visible) return c.json({ error: 'Not found' }, 404);

  const ownerEmail = visible.row.createdBy && !visible.isOwner
    ? (await lookupEmailsByUserIds([visible.row.createdBy])).get(visible.row.createdBy) ?? null
    : null;
  return c.json(serializeSession(visible.row, {
    grants: visible.grants,
    viewerId: loaded.userId,
    canManageProject: visible.canManageProject,
    ownerEmail,
  }));
});

// POST /v1/projects/:projectId/sessions/:sessionId/ensure-opencode
// Backend-owned mapping: resolve the sandbox's canonical OpenCode root id and
// persist it to project_sessions.opencode_session_id. This is the sole
// authoritative writer of the pin. Idempotent — repeated calls are no-ops once
// the pin matches the live root; heals a stale/missing pin; creates a root if
// the sandbox has none.
projectsApp.post('/:projectId/sessions/:sessionId/ensure-opencode', async (c) => {
  const projectId = c.req.param('projectId');
  const sessionId = c.req.param('sessionId');
  if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

  const loaded = await loadProjectForUser(c, projectId, 'write');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  const visible = await loadVisibleSession(loaded, sessionId);
  if (!visible) return c.json({ error: 'Not found' }, 404);

  const [sandbox] = await db
    .select({ externalId: sessionSandboxes.externalId })
    .from(sessionSandboxes)
    .where(and(
      eq(sessionSandboxes.sessionId, sessionId),
      eq(sessionSandboxes.projectId, projectId),
      eq(sessionSandboxes.accountId, loaded.row.accountId),
    ))
    .limit(1);
  if (!sandbox?.externalId) return c.json({ error: 'sandbox not provisioned' }, 409);

  const result = await ensureOpencodeSessionPin({
    projectId,
    sessionId,
    accountId: loaded.row.accountId,
    externalId: sandbox.externalId,
    userId: loaded.userId,
    currentPin: visible.row.opencodeSessionId ?? null,
  });

  // Re-read so the serialized row reflects the (possibly) updated pin.
  const [row] = await db
    .select()
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);

  return c.json({
    ...serializeSession(row ?? visible.row, {
      grants: visible.grants,
      viewerId: loaded.userId,
      canManageProject: visible.canManageProject,
    }),
    ensure: { reason: result.reason, changed: result.changed, pin: result.pin },
  });
});

// PUT /v1/projects/:projectId/sessions/:sessionId/sharing
// Owner or project manager sets who can see/open this session
// (private | project | members). Mirrors connector/secret sharing.
projectsApp.put('/:projectId/sessions/:sessionId/sharing', async (c) => {
  const projectId = c.req.param('projectId');
  const sessionId = c.req.param('sessionId');
  if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

  const body = await readBody(c);
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const visible = await loadVisibleSession(loaded, sessionId);
  if (!visible) return c.json({ error: 'Not found' }, 404);
  if (!visible.canManageSharing) {
    return c.json({ error: 'Only the session owner or a project manager can change sharing' }, 403);
  }

  const intent = parseSharingIntent(body, loaded.userId);
  if (!intent) return c.json({ error: 'invalid sharing — mode must be project|private|members' }, 400);

  await setSessionSharing(sessionId, intent);

  const fresh = await loadVisibleSession(loaded, sessionId);
  return c.json(fresh ? serializeSession(fresh.row, {
    grants: fresh.grants,
    viewerId: loaded.userId,
    canManageProject: fresh.canManageProject,
  }) : { ok: true });
});

// PATCH /v1/projects/:projectId/sessions/:sessionId
projectsApp.patch('/:projectId/sessions/:sessionId', async (c) => {
  const projectId = c.req.param('projectId');
  const sessionId = c.req.param('sessionId');
  if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

  const body = await readBody(c);
  const loaded = await loadProjectForUser(c, projectId, 'write');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const serverManagedFields = ['status', 'sandbox_url', 'sandboxUrl', 'error'];
  const attemptedServerField = serverManagedFields.find((field) => hasOwn(body, field));
  if (attemptedServerField) {
    return c.json({ error: `field is server-managed: ${attemptedServerField}` }, 400);
  }

  // opencode_session_id is SERVER-MANAGED: the backend is the sole authority
  // for the OpenCode↔Kortix mapping (see ensure-opencode + opencode-mapping.ts).
  // Clients must never set it, so a stale/forged client value can't drift it.
  const opencodeManagedField = ['opencode_session_id', 'opencodeSessionId'].find((f) => hasOwn(body, f));
  if (opencodeManagedField) {
    return c.json({ error: `field is server-managed: ${opencodeManagedField}` }, 400);
  }

  const allowedFields = ['name', 'metadata'];
  const unknownField = Object.keys(body).find((field) => !allowedFields.includes(field));
  if (unknownField) {
    return c.json({ error: `field is not user-editable: ${unknownField}` }, 400);
  }

  const visible = await loadVisibleSession(loaded, sessionId);
  if (!visible) return c.json({ error: 'Not found' }, 404);
  const existing = visible.row;

  const updates: Partial<typeof projectSessions.$inferInsert> = { updatedAt: new Date() };

  const name = normalizeString(body.name);
  const metadata = body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
    ? body.metadata as Record<string, unknown>
    : null;

  if (name || metadata) {
    updates.metadata = {
      ...(existing.metadata ?? {}),
      ...(metadata ?? {}),
      ...(name ? { name } : {}),
    };
  }

  const [row] = await db
    .update(projectSessions)
    .set(updates)
    .where(and(
      eq(projectSessions.sessionId, sessionId),
      eq(projectSessions.projectId, projectId),
      eq(projectSessions.accountId, loaded.row.accountId),
    ))
    .returning();

  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json(serializeSession(row, {
    grants: visible.grants,
    viewerId: loaded.userId,
    canManageProject: visible.canManageProject,
  }));
});

// POST /v1/projects/sync-opencode-sessions
// Mirrors session data from the sandbox-local opencode DB into our cloud DB.
// The project_sessions row remains the branch+sandbox root;
// metadata.opencode_sessions stores the local OpenCode root/sub-session graph
// for sidebar/list rendering when the sandbox is not the active runtime.
const syncOpencodeSessionsHandler = async (c: Context<AppEnv>) => {
  const userId = c.get('userId') as string;
  const body = await readBody(c);
  const rawEntries = body.entries;
  if (!Array.isArray(rawEntries)) {
    return c.json({ error: 'entries must be an array' }, 400);
  }

  type OpenCodeSessionSnapshot = {
    id: string;
    title: string | null;
    parent_id: string | null;
    project_id: string | null;
    created_at: number | null;
    updated_at: number | null;
    archived_at: number | null;
  };

  const desiredByOcId = new Map<string, OpenCodeSessionSnapshot>();
  for (const raw of rawEntries) {
    if (!isPlainObject(raw)) continue;
    const opencodeSessionId = normalizeString(
      raw.opencode_session_id ?? raw.opencodeSessionId,
    );
    if (!opencodeSessionId) continue;
    const title = normalizeString(raw.title);
    const parentId = normalizeString(raw.parent_id ?? raw.parentID ?? raw.parentId);
    const projectId = normalizeString(raw.project_id ?? raw.projectID ?? raw.projectId);
    const createdAt = typeof raw.created_at === 'number'
      ? raw.created_at
      : typeof raw.createdAt === 'number'
        ? raw.createdAt
        : null;
    const updatedAt = typeof raw.updated_at === 'number'
      ? raw.updated_at
      : typeof raw.updatedAt === 'number'
        ? raw.updatedAt
        : null;
    const archivedAt = typeof raw.archived_at === 'number'
      ? raw.archived_at
      : typeof raw.archivedAt === 'number'
        ? raw.archivedAt
        : null;
    desiredByOcId.set(opencodeSessionId, {
      id: opencodeSessionId,
      title,
      parent_id: parentId,
      project_id: projectId,
      created_at: createdAt,
      updated_at: updatedAt,
      archived_at: archivedAt,
    });
  }
  if (desiredByOcId.size === 0) return c.json({ updated: 0 });

  const ids = Array.from(desiredByOcId.keys());
  const rootByOcId = new Map<string, string>();
  const resolveRoot = (id: string): string => {
    const cached = rootByOcId.get(id);
    if (cached) return cached;
    const seen = new Set<string>();
    let current = id;
    while (true) {
      if (seen.has(current)) break;
      seen.add(current);
      const parent = desiredByOcId.get(current)?.parent_id;
      if (!parent) break;
      if (!desiredByOcId.has(parent)) {
        current = parent;
        break;
      }
      current = parent;
    }
    for (const seenId of seen) rootByOcId.set(seenId, current);
    return current;
  };
  for (const id of ids) resolveRoot(id);
  const rootIds = Array.from(new Set(Array.from(rootByOcId.values())));
  const rows = await db
    .select()
    .from(projectSessions)
    .where(inArray(projectSessions.opencodeSessionId, Array.from(new Set([...ids, ...rootIds]))));
  if (rows.length === 0) return c.json({ updated: 0 });

  // Per-row IAM authz. The engine answers from a per-request cache
  // (see iam/cache.ts) so duplicate (account, project) probes collapse
  // to a single SQL pass — N rows over K distinct projects = K
  // authorize() calls, not N.
  const requestCtx = deriveRequestContext(c);
  const actingTokenId =
    ((c as unknown as { get(k: string): unknown }).get('iamTokenId') as
      | string
      | undefined) ?? undefined;

  let updated = 0;
  for (const row of rows) {
    const verdict = await authorize(
      userId,
      row.accountId,
      PROJECT_ACTIONS.PROJECT_WRITE,
      { type: 'project', id: row.projectId },
      actingTokenId,
      requestCtx,
    );
    if (!verdict.allowed) continue;
    const ocId = row.opencodeSessionId;
    if (!ocId) continue;
    const rootId = rootByOcId.get(ocId) ?? ocId;
    const current = typeof row.metadata?.name === 'string' ? row.metadata.name : null;
    const rootEntry = desiredByOcId.get(ocId);
    const desired = rootEntry ? rootEntry.title : current;
    const scopedSessions = Array.from(desiredByOcId.values())
      .filter((entry) => (rootByOcId.get(entry.id) ?? entry.id) === rootId)
      .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
    const currentSessions = JSON.stringify(row.metadata?.opencode_sessions ?? []);
    const nextSessions = JSON.stringify(scopedSessions);
    if (desired === current && currentSessions === nextSessions) continue;
    const nextMetadata: Record<string, unknown> = { ...(row.metadata ?? {}) };
    if (desired) nextMetadata.name = desired;
    else delete nextMetadata.name;
    nextMetadata.opencode_sessions = scopedSessions;
    await db
      .update(projectSessions)
      .set({ metadata: nextMetadata, updatedAt: new Date() })
      .where(eq(projectSessions.sessionId, row.sessionId));
    updated += 1;
  }
  return c.json({ updated });
};

projectsApp.post('/sync-opencode-sessions', syncOpencodeSessionsHandler);

// GET /v1/projects/:projectId/sessions/:sessionId/sandbox
// Returns the session's sandbox runtime row from `kortix.session_sandboxes`.
// Decoupled from the legacy /instances sandbox table: no billing fields, no
// team-membership coupling. Returns 404 while the row is being inserted —
// the frontend polls.
// Provision a sandbox for a dormant session (e.g. a migrated legacy session) on
// first open. Fire-and-forget; flips the session to 'provisioning' first so the
// status guard at the call sites prevents re-kicking on every poll.
async function kickProvisionOnOpen(
  loaded: { row: { accountId: string; repoUrl: string; defaultBranch: string; manifestPath: string }; userId: string },
  session: { sandboxProvider: string; baseRef: string | null; agentName: string | null },
  projectId: string,
  sessionId: string,
): Promise<void> {
  const providerName = session.sandboxProvider as SandboxProviderName;
  if (!(config.ALLOWED_SANDBOX_PROVIDERS as readonly string[]).includes(providerName)) return;
  if (sandboxCallbackUnreachableReason()) return;
  const gitAuth = await resolveProjectGitAuth(loaded.row as ProjectRow);
  await db.update(projectSessions)
    .set({ status: 'provisioning', error: null, updatedAt: new Date() })
    .where(eq(projectSessions.sessionId, sessionId));
  // Migrated session — restore its original chat as part of provisioning, before
  // the sandbox goes 'active' (so the frontend's ensure-opencode pin survives).
  const legacySandboxId = (loaded.row as { metadata?: { legacy_migration?: { source_sandbox_id?: unknown } } })
    .metadata?.legacy_migration?.source_sandbox_id;

  void (async () => {
    try {
      const extraEnvVars = await buildSessionSandboxEnvVars({
        accountId: loaded.row.accountId,
        projectId,
        sessionId,
        userId: loaded.userId,
        repoUrl: loaded.row.repoUrl,
        baseRef: session.baseRef ?? loaded.row.defaultBranch,
        agentName: session.agentName ?? 'default',
      });
      await provisionSessionSandbox({
        sandboxId: sessionId,
        accountId: loaded.row.accountId,
        projectId,
        userId: loaded.userId,
        provider: providerName,
        metadata: { session_id: sessionId, project_id: projectId, opened_at: new Date().toISOString() },
        extraEnvVars,
        gitProject: {
          projectId,
          repoUrl: loaded.row.repoUrl,
          defaultBranch: loaded.row.defaultBranch,
          manifestPath: loaded.row.manifestPath,
          gitAuthToken: gitAuth.auth?.token ?? null,
        },
        baseRef: session.baseRef ?? loaded.row.defaultBranch,
        beforeActive: typeof legacySandboxId === 'string'
          ? (externalId) => rehydrateSessionChat({ sessionId, legacySandboxId, newExternalId: externalId })
          : undefined,
      });
    } catch (err) {
      const message = (err as Error)?.message || 'Sandbox provisioning failed';
      console.error(`[projects] provision-on-open failed for ${sessionId}:`, err);
      await db.update(projectSessions)
        .set({ status: 'failed', error: message, updatedAt: new Date() })
        .where(eq(projectSessions.sessionId, sessionId)).catch(() => {});
    }
  })();
}

projectsApp.get('/:projectId/sessions/:sessionId/sandbox', async (c) => {
  const projectId = c.req.param('projectId');
  const sessionId = c.req.param('sessionId');
  if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  // Only members who can see the session may reach its sandbox.
  const sandboxVisible = await loadVisibleSession(loaded, sessionId);
  if (!sandboxVisible) return c.json({ error: 'Not found' }, 404);

  const [row] = await db
    .select()
    .from(sessionSandboxes)
    .where(and(
      eq(sessionSandboxes.sessionId, sessionId),
      eq(sessionSandboxes.projectId, projectId),
      eq(sessionSandboxes.accountId, loaded.row.accountId),
    ))
    .limit(1);

  // (Re)provision on open when there's no usable sandbox: a dormant migrated
  // session (no row), or a dead one whose Daytona sandbox was idle-GC'd /
  // errored (row in error/stopped/archived). The UI polls this endpoint, so it's
  // the natural trigger. The project_session 'provisioning' flag (set by
  // kickProvisionOnOpen) guards against re-kicking on subsequent 404 polls.
  const usable = row && (row.status === 'provisioning' || row.status === 'active');
  if (!usable) {
    if (sandboxVisible.row.status !== 'provisioning') {
      if (row) {
        await db.delete(sessionSandboxes).where(eq(sessionSandboxes.sandboxId, sessionId)).catch(() => {});
      }
      await kickProvisionOnOpen(loaded, sandboxVisible.row, projectId, sessionId);
    }
    return c.json({ error: 'Not found' }, 404);
  }

  return c.json({
    sandbox_id: row.sandboxId,
    session_id: row.sessionId,
    project_id: row.projectId,
    account_id: row.accountId,
    provider: row.provider,
    external_id: row.externalId,
    base_url: row.baseUrl,
    status: row.status,
    config: serializeSessionSandboxConfig(row.config),
    metadata: row.metadata ?? {},
    last_used_at: row.lastUsedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  });
});

// DELETE /v1/projects/:projectId/sessions/:sessionId
// Soft delete only. We deliberately keep the remote branch so the user can
// still merge or recover work.
projectsApp.delete('/:projectId/sessions/:sessionId', async (c) => {
  const projectId = c.req.param('projectId');
  const sessionId = c.req.param('sessionId');
  if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

  const loaded = await loadProjectForUser(c, projectId, 'write');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  // Stopping a session is reserved for its owner or a project manager.
  const visible = await loadVisibleSession(loaded, sessionId);
  if (!visible) return c.json({ error: 'Not found' }, 404);
  if (!visible.canManageSharing) {
    return c.json({ error: 'Only the session owner or a project manager can stop this session' }, 403);
  }

  const [sandbox] = await db
    .select()
    .from(sessionSandboxes)
    .where(and(
      eq(sessionSandboxes.sessionId, sessionId),
      eq(sessionSandboxes.projectId, projectId),
      eq(sessionSandboxes.accountId, loaded.row.accountId),
    ))
    .limit(1);

  const [row] = await db
    .update(projectSessions)
    .set({ status: 'stopped', updatedAt: new Date() })
    .where(and(
      eq(projectSessions.sessionId, sessionId),
      eq(projectSessions.projectId, projectId),
      eq(projectSessions.accountId, loaded.row.accountId),
    ))
    .returning();

  if (!row) return c.json({ error: 'Not found' }, 404);

  if (sandbox) {
    await db
      .update(sessionSandboxes)
      .set({
        status: 'stopped',
        metadata: {
          ...(sandbox.metadata ?? {}),
          stoppedAt: new Date().toISOString(),
          initStatus: sandbox.status === 'active' ? 'ready' : 'failed',
          ...(sandbox.status === 'active'
            ? {}
            : { lastInitError: 'Session was stopped before sandbox initialization completed' }),
        },
        updatedAt: new Date(),
      })
      .where(eq(sessionSandboxes.sandboxId, sandbox.sandboxId))
      .catch((err) => {
        console.warn(`[projects] failed to mark session sandbox stopped for ${sessionId}:`, err);
      });

    if (sandbox.externalId && (config.ALLOWED_SANDBOX_PROVIDERS as readonly string[]).includes(sandbox.provider)) {
      const provider = getProvider(sandbox.provider as SandboxProviderName);
      void provider.remove(sandbox.externalId).catch((err) => {
        console.warn(`[projects] failed to remove provider sandbox ${sandbox.externalId} for stopped session ${sessionId}:`, err);
      });
    }
  }

  void pauseComputeSession(sessionId).catch((err) =>
    console.warn(`[projects] compute pause failed for ${sessionId}:`, err),
  );

  return c.json({ ok: true });
});

// POST /v1/projects/:projectId/sessions/:sessionId/wake
// Wake a sandbox that the provider auto-stopped while idle. The DB row still
// reads `active` (nothing updates it when Daytona auto-stops after ~15min), so
// opening such a session would otherwise hit a dead container and spin on the
// health poll. The frontend fires this on open: a running sandbox is a cheap
// status no-op; a stopped one gets started in the background while the health
// poll picks up readiness — so the request returns instantly either way.
projectsApp.post('/:projectId/sessions/:sessionId/wake', async (c) => {
  const projectId = c.req.param('projectId');
  const sessionId = c.req.param('sessionId');
  if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  const wakeVisible = await loadVisibleSession(loaded, sessionId);
  if (!wakeVisible) return c.json({ error: 'Not found' }, 404);

  // Billing v2 — same gate as session create. An unsubscribed account can
  // own a stopped sandbox (e.g. they cancelled their sub after creating it),
  // but they shouldn't be able to resume it without re-activating billing.
  // Body shape mirrors createProjectSession's 402 (see note there).
  const billingCheck = await checkBillingActive(loaded.row.accountId);
  if (!billingCheck.ok) {
    return c.json(
      {
        error: billingCheck.message,
        message: billingCheck.message,
        code: billingCheck.reason,
        balance: billingCheck.balance,
      },
      402,
    );
  }

  const [row] = await db
    .select()
    .from(sessionSandboxes)
    .where(and(
      eq(sessionSandboxes.sessionId, sessionId),
      eq(sessionSandboxes.projectId, projectId),
      eq(sessionSandboxes.accountId, loaded.row.accountId),
    ))
    .limit(1);

  // Dormant session with no sandbox yet (e.g. a migrated legacy session) —
  // provision one on open (same trigger as GET /sandbox).
  if (!row) {
    if (wakeVisible.row.status === 'stopped') {
      await kickProvisionOnOpen(loaded, wakeVisible.row, projectId, sessionId);
      return c.json({ status: 'provisioning' });
    }
    return c.json({ status: 'unknown' });
  }

  if (!row.externalId) return c.json({ status: 'unknown' });

  const providerName = row.provider as SandboxProviderName;
  if (!(config.ALLOWED_SANDBOX_PROVIDERS as readonly string[]).includes(providerName)) {
    return c.json({ status: 'unknown' });
  }
  const provider = getProvider(providerName);

  let status: string;
  try {
    status = await provider.getStatus(row.externalId);
  } catch {
    return c.json({ status: 'unknown' });
  }
  if (status === 'running') return c.json({ status: 'running' });

  // Stopped/archived → kick the start in the background so the caller gets an
  // instant answer and the health poll observes readiness. Don't block the
  // request on the provider's start (~10-30s on a cold wake).
  void provider.start(row.externalId).catch((err) =>
    console.warn(`[wake] failed to start sandbox ${row.externalId} (session ${sessionId}):`, err),
  );
  return c.json({ status: 'waking' });
});

// POST /v1/projects/:projectId/sessions/:sessionId/restart
// Tear down the current sandbox container, revoke its sandbox-scoped api keys,
// and re-provision a fresh one with the latest project secrets + rotated
// LLM/GitHub tokens. The git branch is preserved.
projectsApp.post('/:projectId/sessions/:sessionId/restart', async (c) => {
  const projectId = c.req.param('projectId');
  const sessionId = c.req.param('sessionId');
  if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

  const loaded = await loadProjectForUser(c, projectId, 'write');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  // Restart is reserved for the session owner or a project manager.
  const visible = await loadVisibleSession(loaded, sessionId);
  if (!visible) return c.json({ error: 'Not found' }, 404);
  if (!visible.canManageSharing) {
    return c.json({ error: 'Only the session owner or a project manager can restart this session' }, 403);
  }
  const session = visible.row;

  const providerName = session.sandboxProvider as SandboxProviderName;
  if (!(config.ALLOWED_SANDBOX_PROVIDERS as readonly string[]).includes(providerName)) {
    return c.json({ error: `Restart is not supported for provider ${providerName}` }, 400);
  }

  // Same loopback-callback guard as create: restarting into an unreachable
  // KORTIX_URL just rebuilds the same dead sandbox.
  const restartUnreachable = sandboxCallbackUnreachableReason();
  if (restartUnreachable) {
    return c.json({ error: restartUnreachable, code: 'KORTIX_URL_UNREACHABLE' }, 503);
  }

  // Resolve git auth fresh — installation tokens rotate.
  const gitAuth = await resolveProjectGitAuth(loaded.row);

  const initialPrompt = typeof session.metadata?.initial_prompt === 'string'
    ? session.metadata.initial_prompt as string
    : null;
  const opencodeModel = typeof session.metadata?.opencode_model === 'string'
    ? session.metadata.opencode_model as string
    : null;

  // Best-effort tear down: remove the old external container and revoke its
  // sandbox keys. Failures are logged but don't block restart — a stuck row
  // is exactly what restart exists to fix.
  const [existingSandbox] = await db
    .select()
    .from(sessionSandboxes)
    .where(eq(sessionSandboxes.sandboxId, sessionId))
    .limit(1);

  if (
    existingSandbox?.externalId &&
    existingSandbox.provider === 'daytona'
  ) {
    try {
      const provider = getProvider('daytona');
      await provider.remove(existingSandbox.externalId);
    } catch (err) {
      console.warn(`[projects] restart: failed to remove provider container for ${sessionId}:`, err);
    }
  }

  // Billing v2 — finalize compute metering for the pre-restart sandbox.
  // The new sandbox will open a fresh metering row when it boots.
  if (existingSandbox) {
    void endComputeSession(sessionId).catch((err) =>
      console.warn(`[projects] restart: compute endComputeSession failed for ${sessionId}:`, err),
    );
  }

  await db
    .update(kortixApiKeys)
    .set({ status: 'revoked' })
    .where(and(
      eq(kortixApiKeys.sandboxId, sessionId),
      eq(kortixApiKeys.type, 'sandbox'),
      eq(kortixApiKeys.status, 'active'),
    ))
    .catch((err) => {
      console.warn(`[projects] restart: failed to revoke sandbox keys for ${sessionId}:`, err);
    });

  if (existingSandbox) {
    await db
      .delete(sessionSandboxes)
      .where(eq(sessionSandboxes.sandboxId, sessionId));
  }

  // Flip session back to provisioning so the dashboard's connecting screen
  // re-engages.
  await db
    .update(projectSessions)
    .set({
      status: 'provisioning',
      error: null,
      sandboxUrl: null,
      updatedAt: new Date(),
    })
    .where(eq(projectSessions.sessionId, sessionId));

  // Fire-and-forget the actual re-provision. Same shape as session-create.
  void (async () => {
    try {
      const extraEnvVars = await buildSessionSandboxEnvVars({
        accountId: loaded.row.accountId,
        projectId,
        sessionId,
        userId: loaded.userId,
        repoUrl: loaded.row.repoUrl,
        baseRef: session.baseRef ?? loaded.row.defaultBranch,
        agentName: session.agentName ?? 'default',
        initialPrompt,
        opencodeModel,
      });
      await provisionSessionSandbox({
        sandboxId: sessionId,
        accountId: loaded.row.accountId,
        projectId,
        userId: loaded.userId,
        provider: providerName,
        metadata: {
          session_id: sessionId,
          project_id: projectId,
          restarted_at: new Date().toISOString(),
        },
        extraEnvVars,
        gitProject: {
          projectId,
          repoUrl: loaded.row.repoUrl,
          defaultBranch: loaded.row.defaultBranch,
          manifestPath: loaded.row.manifestPath,
          gitAuthToken: gitAuth.auth?.token ?? null,
        },
        baseRef: session.baseRef ?? loaded.row.defaultBranch,
      });
    } catch (err) {
      const message = (err as Error)?.message || 'Sandbox restart failed';
      console.error(`[projects] restart: provisioning failed for ${sessionId}:`, err);
      await db
        .update(projectSessions)
        .set({ status: 'failed', error: message, updatedAt: new Date() })
        .where(eq(projectSessions.sessionId, sessionId))
        .catch(() => {});
    }
  })();

  return c.json({ ok: true, session_id: sessionId, status: 'provisioning' }, 202);
});

// ─── Change Requests ────────────────────────────────────────────────────────
// Kortix-native PR layer. The CR is metadata stored alongside the project;
// the underlying merge runs through ./git.ts which works against any git
// backend (GitHub, GitLab, plain git) — so the merge UI lives in
// Kortix even when the repo is hosted elsewhere.
//
// v1 is intentionally minimal: open / merged / closed, head_ref + base_ref,
// head/base commit SHAs auto-refreshed on read. No reviews, no comments,
// no mirrored revision history — git remains the source of truth.

/**
 * Refresh the CR's cached head/base SHAs against the live git tips. Used by
 * read endpoints so the UI never shows stale "X commits behind" state. No-op
 * when the SHAs already match or the CR is no longer open.
 */
async function refreshCrTips(input: {
  cr: typeof changeRequests.$inferSelect;
  project: {
    projectId: string;
    repoUrl: string;
    defaultBranch: string;
    manifestPath: string;
    gitAuthToken?: string | null;
  };
}) {
  const { cr, project } = input;
  if (cr.status !== 'open') return;
  try {
    const [baseSha, headSha] = await Promise.all([
      resolveBranchTip(project, cr.baseRef),
      resolveBranchTip(project, cr.headRef),
    ]);
    if (cr.headCommitSha === headSha && cr.baseCommitSha === baseSha) return;
    await db
      .update(changeRequests)
      .set({ headCommitSha: headSha, baseCommitSha: baseSha, updatedAt: new Date() })
      .where(eq(changeRequests.crId, cr.crId));
  } catch (error) {
    // Repo unreachable or branch missing — leave the CR alone so the UI can
    // still render the metadata it has.
    console.warn('[change-requests] tip refresh failed', {
      crId: cr.crId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// GET /v1/projects/:projectId/change-requests?status=open|merged|closed|all
projectsApp.get('/:projectId/change-requests', async (c) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const statusFilter = normalizeString(c.req.query('status'))?.toLowerCase();
  const whereClauses = [eq(changeRequests.projectId, projectId)];
  if (statusFilter && statusFilter !== 'all') {
    if (!['open', 'merged', 'closed'].includes(statusFilter)) {
      return c.json({ error: 'Invalid status filter' }, 400);
    }
    whereClauses.push(eq(changeRequests.status, statusFilter as 'open' | 'merged' | 'closed'));
  }

  const rows = await db
    .select()
    .from(changeRequests)
    .where(and(...whereClauses))
    .orderBy(desc(changeRequests.number));

  return c.json({
    change_requests: rows.map(serializeChangeRequest),
  });
});

// POST /v1/projects/:projectId/change-requests
// Body: { title, description?, head_ref, base_ref?, session_id? }
projectsApp.post('/:projectId/change-requests', async (c) => {
  const projectId = c.req.param('projectId');
  const body = await readBody(c);
  const loaded = await loadProjectForUser(c, projectId, 'write');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const title = normalizeString(body.title);
  if (!title) return c.json({ error: 'title is required' }, 400);
  const description = normalizeString(body.description) ?? '';
  const headRef = normalizeString(body.head_ref ?? body.headRef);
  if (!headRef) return c.json({ error: 'head_ref is required' }, 400);
  const baseRef = normalizeString(body.base_ref ?? body.baseRef) ?? loaded.row.defaultBranch;
  if (baseRef === headRef) {
    return c.json({ error: 'head_ref and base_ref must differ' }, 400);
  }

  let originSessionId: string | null = normalizeString(body.session_id ?? body.sessionId);
  if (originSessionId) {
    const [sessionRow] = await db
      .select({ sessionId: projectSessions.sessionId })
      .from(projectSessions)
      .where(and(eq(projectSessions.sessionId, originSessionId), eq(projectSessions.projectId, projectId)))
      .limit(1);
    if (!sessionRow) originSessionId = null;
  }

  // Resolve current tips so the CR has anchored SHAs from the start.
  let baseSha: string | null = null;
  let headSha: string | null = null;
  try {
    const projectForGit = await withProjectGitAuth(loaded.row);
    [baseSha, headSha] = await Promise.all([
      resolveBranchTip(projectForGit, baseRef),
      resolveBranchTip(projectForGit, headRef),
    ]);
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Failed to resolve branches',
    }, 400);
  }

  // Atomically allocate the next per-project number and insert. Retry once on
  // unique-constraint collision (only happens under racing opens).
  let inserted: typeof changeRequests.$inferSelect | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const number = await getNextCrNumber(projectId);
    try {
      const [row] = await db
        .insert(changeRequests)
        .values({
          accountId: loaded.row.accountId,
          projectId,
          number,
          title,
          description,
          baseRef,
          headRef,
          headCommitSha: headSha,
          baseCommitSha: baseSha,
          originSessionId,
          createdBy: loaded.userId,
        })
        .returning();
      inserted = row;
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/duplicate key/.test(message)) throw error;
    }
  }
  if (!inserted) return c.json({ error: 'Failed to allocate CR number' }, 500);

  return c.json(serializeChangeRequest(inserted), 201);
});

// POST /v1/projects/:projectId/sessions/:sessionId/commit-push
// Commits the session sandbox's working-tree changes and pushes them to the
// session branch — the host-driven path that lets the dashboard open a change
// request without routing through the agent. Idempotent: a clean tree with
// nothing left to push returns { nothing_to_do: true }.
//
// NOTE (2026-05-29): currently UNUSED by the UI. The shipped change-request
// flow lets the agent commit + open the CR from a single chat prompt instead.
// Kept (wired through to the daemon /kortix/git/commit-push route) as the
// host-driven primitive for a possible fully-UI flow. Remove together with the
// daemon route + web client/hook if that direction is dropped.
projectsApp.post('/:projectId/sessions/:sessionId/commit-push', async (c) => {
  const projectId = c.req.param('projectId');
  const sessionId = c.req.param('sessionId');
  const loaded = await loadProjectForUser(c, projectId, 'write');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const body = await readBody(c);
  const message = normalizeString(body.message) ?? undefined;

  const [row] = await db
    .select()
    .from(sessionSandboxes)
    .where(and(
      eq(sessionSandboxes.sessionId, sessionId),
      eq(sessionSandboxes.projectId, projectId),
      eq(sessionSandboxes.accountId, loaded.row.accountId),
    ))
    .limit(1);
  if (!row || !row.externalId) {
    return c.json({ error: 'Session sandbox not found' }, 404);
  }
  if (row.status !== 'active') {
    return c.json({ error: 'Session sandbox is not running', status: row.status }, 409);
  }

  const providerName = row.provider as SandboxProviderName;
  if (!(config.ALLOWED_SANDBOX_PROVIDERS as readonly string[]).includes(providerName)) {
    return c.json({ error: 'Unsupported sandbox provider' }, 409);
  }

  // resolveEndpoint already injects the sandbox service key as a Bearer token
  // (and the Daytona preview headers), which the daemon's /kortix/git route
  // validates against KORTIX_TOKEN — same contract as /kortix/env.
  let endpoint: { url: string; headers: Record<string, string> };
  try {
    endpoint = await getProvider(providerName).resolveEndpoint(row.externalId);
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : 'Failed to reach sandbox' },
      502,
    );
  }

  let daemonRes: Response;
  try {
    daemonRes = await fetch(`${endpoint.url.replace(/\/$/, '')}/kortix/git/commit-push`, {
      method: 'POST',
      headers: endpoint.headers,
      body: JSON.stringify({ message }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : 'Sandbox unreachable' },
      502,
    );
  }

  const result = (await daemonRes.json().catch(() => null)) as
    | {
        ok?: boolean;
        committed?: boolean;
        pushed?: boolean;
        nothingToDo?: boolean;
        branch?: string | null;
        headSha?: string | null;
        message?: string;
      }
    | null;

  if (!daemonRes.ok || !result?.ok) {
    return c.json(
      { error: result?.message || 'Failed to save changes' },
      daemonRes.status === 409 ? 409 : 502,
    );
  }

  // A fresh commit just landed on the session branch and was pushed to origin.
  // Force the next mirror read to re-fetch so the CR we open immediately after
  // sees the new tip (the mirror is otherwise refresh-throttled).
  invalidateProjectMirror(projectId);

  return c.json({
    committed: Boolean(result.committed),
    pushed: Boolean(result.pushed),
    nothing_to_do: Boolean(result.nothingToDo),
    branch: result.branch ?? null,
    head_sha: result.headSha ?? null,
  });
});

// GET /v1/projects/:projectId/change-requests/:crId
// Auto-refreshes the cached head/base SHAs against the live git tips so the
// UI never shows stale "X commits behind" state.
projectsApp.get('/:projectId/change-requests/:crId', async (c) => {
  const projectId = c.req.param('projectId');
  const crId = c.req.param('crId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  let cr = await getCrById(crId, projectId);
  if (!cr) return c.json({ error: 'Change request not found' }, 404);

  await refreshCrTips({
    cr,
    project: await withProjectGitAuth(loaded.row),
  });
  cr = (await getCrById(crId, projectId))!;

  return c.json({ change_request: serializeChangeRequest(cr) });
});

// PATCH /v1/projects/:projectId/change-requests/:crId
// Body: { title?, description? }
projectsApp.patch('/:projectId/change-requests/:crId', async (c) => {
  const projectId = c.req.param('projectId');
  const crId = c.req.param('crId');
  const body = await readBody(c);
  const loaded = await loadProjectForUser(c, projectId, 'write');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const cr = await getCrById(crId, projectId);
  if (!cr) return c.json({ error: 'Change request not found' }, 404);
  if (cr.status !== 'open') {
    return c.json({ error: `Cannot edit a ${cr.status} change request` }, 409);
  }

  const updates: Partial<typeof changeRequests.$inferInsert> = { updatedAt: new Date() };
  const title = normalizeString(body.title);
  if (title) updates.title = title;
  if (typeof body.description === 'string') updates.description = body.description;

  const [row] = await db
    .update(changeRequests)
    .set(updates)
    .where(eq(changeRequests.crId, crId))
    .returning();
  return c.json(serializeChangeRequest(row));
});

// GET /v1/projects/:projectId/change-requests/:crId/diff
// For open / closed CRs: lives off the live branch tips (three-dot diff).
// For merged CRs: uses the SHAs captured at merge time, so the diff still
// renders even though the head branch is now fully reachable from base.
projectsApp.get('/:projectId/change-requests/:crId/diff', async (c) => {
  const projectId = c.req.param('projectId');
  const crId = c.req.param('crId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const cr = await getCrById(crId, projectId);
  if (!cr) return c.json({ error: 'Change request not found' }, 404);

  const projectForGit = await withProjectGitAuth(loaded.row);

  try {
    const useSnapshot = cr.status === 'merged' && cr.baseCommitSha && cr.headCommitSha;
    const diff = useSnapshot
      ? await getDiffBetweenShas(projectForGit, cr.baseCommitSha!, cr.headCommitSha!)
      : await getBranchDiff(projectForGit, cr.baseRef, cr.headRef);
    return c.json({
      cr_id: cr.crId,
      base_ref: cr.baseRef,
      head_ref: cr.headRef,
      base_sha: diff.base_sha,
      head_sha: diff.head_sha,
      merge_base: diff.merge_base,
      files: diff.files,
      files_changed: diff.files_changed,
      additions: diff.additions,
      deletions: diff.deletions,
      patch: diff.patch,
    });
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Failed to compute diff',
    }, 400);
  }
});

// GET /v1/projects/:projectId/change-requests/:crId/merge-preview
projectsApp.get('/:projectId/change-requests/:crId/merge-preview', async (c) => {
  const projectId = c.req.param('projectId');
  const crId = c.req.param('crId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const cr = await getCrById(crId, projectId);
  if (!cr) return c.json({ error: 'Change request not found' }, 404);

  try {
    const preview = await previewMerge(await withProjectGitAuth(loaded.row), cr.baseRef, cr.headRef);
    return c.json(preview);
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Failed to preview merge',
    }, 400);
  }
});

// POST /v1/projects/:projectId/change-requests/:crId/merge
// Body: { message?: string }
projectsApp.post('/:projectId/change-requests/:crId/merge', async (c) => {
  const projectId = c.req.param('projectId');
  const crId = c.req.param('crId');
  const body = await readBody(c);
  const loaded = await loadProjectForUser(c, projectId, 'write');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const cr = await getCrById(crId, projectId);
  if (!cr) return c.json({ error: 'Change request not found' }, 404);
  if (cr.status !== 'open') {
    return c.json({ error: `Change request is ${cr.status}` }, 409);
  }

  const customMessage = normalizeString(body.message);
  const projectForGit = await withProjectGitAuth(loaded.row);

  // Manifest gate: a CR cannot merge if the would-be-merged kortix.toml
  // doesn't validate against the canonical schema. We read the manifest from
  // the HEAD branch (what's about to be merged). If the head doesn't have a
  // manifest, that's fine — projects with a `.kortix/`-only layout still
  // merge. The same validator runs in the CLI's `kortix ship` pre-flight, so
  // CLI users see the same diagnostic locally before push.
  try {
    const headManifestRaw = await readRepoFile(projectForGit, MANIFEST_FILENAME, cr.headRef);
    if (headManifestRaw && headManifestRaw.trim()) {
      const { validateManifest } = await import('@kortix/manifest-schema');
      const verdict = validateManifest(headManifestRaw);
      if (!verdict.valid) {
        return c.json(
          {
            error: 'Manifest validation failed — merge blocked.',
            code: 'MANIFEST_INVALID',
            issues: verdict.issues,
          },
          422,
        );
      }
    }
  } catch (err) {
    // Manifest absent on this branch (404 in the mirror) is fine; surface
    // anything else as a 502 so the user knows something else is broken.
    const msg = err instanceof Error ? err.message : String(err);
    if (!/(not found|enoent|404)/i.test(msg)) {
      return c.json(
        { error: `Failed to read kortix.toml from head branch: ${msg}` },
        502,
      );
    }
  }

  let result: Awaited<ReturnType<typeof mergeBranches>>;
  try {
    result = await mergeBranches(projectForGit, cr.baseRef, cr.headRef, {
      message: customMessage ?? `Merge CR #${cr.number}: ${cr.title}`,
      authorName: 'Kortix',
      authorEmail: 'noreply@kortix.ai',
    });
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Merge failed',
    }, 409);
  }

  const [row] = await db
    .update(changeRequests)
    .set({
      status: 'merged',
      mergedAt: new Date(),
      mergedBy: loaded.userId,
      mergeCommitSha: result.merge_commit_sha,
      // Capture the SHAs that were active at merge time. head_commit_sha
      // intentionally stays at the head branch's tip (not the merge commit)
      // so the merged-CR diff can re-render the changes via base...head.
      headCommitSha: result.fast_forward ? result.merge_commit_sha : (cr.headCommitSha ?? result.merge_commit_sha),
      baseCommitSha: result.base_sha_before,
      updatedAt: new Date(),
    })
    .where(eq(changeRequests.crId, crId))
    .returning();

  invalidateProjectMirror(projectId);

  // A merged CR may have edited a `[[sandbox.templates]]` Dockerfile or spec.
  // Reconcile this project's own templates and pre-build any whose identity
  // drifted, so the next session boots off cache instead of a cold build. The
  // platform default is global (built at startup), so it's deliberately not
  // touched here. Best-effort, never blocks the merge response.
  kickProjectTemplatePrebuilds(projectForGit, {
    accountId: loaded.row.accountId,
    source: 'cr-merge',
  });

  // A merged CR may have edited kortix.toml's [[connectors]]. The connector DB
  // cache (what the gateway + dashboard read) is derived from the manifest, so
  // reconcile it from the new tip — best-effort, never blocks the merge
  // response. The manifest in git stays the source of truth either way; the
  // periodic sweep is the backstop if this best-effort call fails.
  void import('../executor/sync')
    .then(({ syncProjectConnectors }) => syncProjectConnectors(projectId, loaded.row.accountId))
    .then((res) => {
      if (res.errors.length) {
        console.warn('[change-requests] connector reconcile had errors', projectId, res.errors);
      }
    })
    .catch((err) =>
      console.warn('[change-requests] connector reconcile failed', projectId, err instanceof Error ? err.message : err),
    );

  return c.json({
    change_request: serializeChangeRequest(row),
    merge: result,
  });
});

// POST /v1/projects/:projectId/change-requests/:crId/close
projectsApp.post('/:projectId/change-requests/:crId/close', async (c) => {
  const projectId = c.req.param('projectId');
  const crId = c.req.param('crId');
  const loaded = await loadProjectForUser(c, projectId, 'write');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const cr = await getCrById(crId, projectId);
  if (!cr) return c.json({ error: 'Change request not found' }, 404);
  if (cr.status === 'merged') {
    return c.json({ error: 'Cannot close a merged change request' }, 409);
  }

  const [row] = await db
    .update(changeRequests)
    .set({
      status: 'closed',
      closedAt: new Date(),
      closedBy: loaded.userId,
      updatedAt: new Date(),
    })
    .where(eq(changeRequests.crId, crId))
    .returning();
  return c.json(serializeChangeRequest(row));
});

// POST /v1/projects/:projectId/change-requests/:crId/reopen
projectsApp.post('/:projectId/change-requests/:crId/reopen', async (c) => {
  const projectId = c.req.param('projectId');
  const crId = c.req.param('crId');
  const loaded = await loadProjectForUser(c, projectId, 'write');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const cr = await getCrById(crId, projectId);
  if (!cr) return c.json({ error: 'Change request not found' }, 404);
  if (cr.status !== 'closed') {
    return c.json({ error: `Cannot reopen a ${cr.status} change request` }, 409);
  }

  const [row] = await db
    .update(changeRequests)
    .set({
      status: 'open',
      closedAt: null,
      closedBy: null,
      updatedAt: new Date(),
    })
    .where(eq(changeRequests.crId, crId))
    .returning();
  return c.json(serializeChangeRequest(row));
});
