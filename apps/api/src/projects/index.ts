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
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  accountGithubInstallations,
  accountMembers,
  kortixApiKeys,
  projects,
  projectMembers,
  projectSecrets,
  projectTriggerEvents,
  projectTriggerRuntime,
  projectTriggers,
  projectSessions,
  sessionSandboxes,
  changeRequests,
} from '@kortix/db';
import type { AppEnv } from '../types';
import { db } from '../shared/db';
import { resolveAccountId } from '../shared/resolve-account';
import { supabaseAuth } from '../middleware/auth';
import { getSupabase } from '../shared/supabase';
import {
  archiveRepoSubtree,
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
  resolveCommitSha,
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
  deleteFile,
  getFileSha,
  getGitHubAppInstallation,
  isGithubAppConfigured,
  isGithubPatConfigured,
  type GitHubAuthContext,
} from './github';
import { buildStarterFiles } from './starter';
import {
  ensureBuildForLatestCommit,
  listSnapshotsForProject,
} from '../snapshots/builder';
import { provisionSessionSandbox } from '../platform/services/session-sandbox';
import { getProvider } from '../platform/providers';
import { config, type SandboxProviderName } from '../config';
import { encodeSessionLlmToken } from '../shared/session-llm-token';
import { maxConcurrentSessionsForTier, resolveAccountTier } from '../shared/account-limits';
import { recordAuditEvent } from '../shared/audit';
import {
  encryptProjectSecret,
  getProjectSecretValue,
  isValidSecretName,
  listProjectSecrets,
} from './secrets';
import {
  SUPPORTED_OAUTH_PROVIDERS,
  buildOpencodeAuthContent,
  deleteOauthCredential,
  isSupportedOauthProvider,
  listOauthCredentials,
  summarizeCredential,
  upsertOauthCredential,
  type OauthProviderId,
} from './oauth';
import {
  pollOnceCopilot,
  pollOnceOpenAi,
  startCopilotDeviceFlow,
  startOpenAiDeviceFlow,
} from './oauth-flow';
import {
  bumpInterval,
  createFlow,
  deleteFlow,
  getFlow,
} from './oauth-flow-store';
import {
  effectiveProjectRole,
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
  parseManifestString,
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
  type AppBuildSpec,
  type AppSourceSpec,
  type AppSpec,
} from './apps';
import {
  channelSpecToTomlEntry,
  extractChannels,
  type ChannelSpec,
} from '../channels/manifest';
import { loadProjectChannels } from '../channels/load';
import { syncProjectChannelBindings } from '../channels/sync';
import {
  deleteSlackInstall,
  loadSlackInstall,
  saveSlackInstall,
} from '../channels/install-store';
import {
  buildDeploymentRequest,
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
} from '../repositories/account-tokens';

export const projectsApp = new Hono<AppEnv>();
export const projectWebhooksApp = new Hono<AppEnv>();

projectsApp.use('/*', supabaseAuth);

type ProjectRow = typeof projects.$inferSelect;
type ProjectSessionRow = typeof projectSessions.$inferSelect;
type ProjectTriggerRow = typeof projectTriggers.$inferSelect;
type ProjectTriggerEventRow = typeof projectTriggerEvents.$inferSelect;
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

function serializeSession(row: ProjectSessionRow) {
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
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function serializeProject(row: ProjectRow, access?: { projectRole: ProjectRole | null; effectiveRole: ProjectRole }) {
  return {
    project_id: row.projectId,
    account_id: row.accountId,
    name: row.name,
    repo_url: row.repoUrl,
    default_branch: row.defaultBranch,
    manifest_path: row.manifestPath,
    status: row.status,
    metadata: row.metadata ?? {},
    last_opened_at: row.lastOpenedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    project_role: access?.projectRole ?? null,
    effective_project_role: access?.effectiveRole ?? null,
  };
}

/**
 * Fire-and-forget initial snapshot build for a freshly-created project.
 *
 * Called from both project-creation paths (`POST /v1/projects` and
 * `POST /v1/projects/create-repo`) so every project gets its own
 * `kortix-snap-…` image built right away — sessions can boot from it as
 * soon as it lands. Swallows errors (logs only) because project creation
 * already succeeded; a failed initial build just means the user sees the
 * "still building" prompt on first session start.
 */
function kickInitialSnapshotBuild(
  project: ProjectRow,
  accountId: string,
  options: { gitAuthToken?: string | null } = {},
): void {
  void ensureBuildForLatestCommit(
    {
      projectId: project.projectId,
      repoUrl: project.repoUrl,
      defaultBranch: project.defaultBranch,
      manifestPath: project.manifestPath,
      gitAuthToken: options.gitAuthToken ?? null,
    },
    {
      branch: project.defaultBranch,
      accountId,
      source: 'project-create',
    },
  ).catch((err) => {
    console.warn(
      `[projects] initial snapshot build kickoff failed for ${project.projectId}:`,
      err,
    );
  });
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
      error: 'concurrent session limit',
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

function serializeProjectSecret(row: typeof projectSecrets.$inferSelect) {
  return {
    secret_id: row.secretId,
    project_id: row.projectId,
    name: row.name,
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function serializeProjectTrigger(row: ProjectTriggerRow) {
  const publicConfig = { ...normalizeJsonObject(row.config) };
  const hasSecret = Boolean(publicConfig.secret || publicConfig.webhook_secret || publicConfig.webhookSecret);
  delete publicConfig.secret;
  delete publicConfig.webhook_secret;
  delete publicConfig.webhookSecret;
  if (hasSecret) publicConfig.has_secret = true;

  return {
    trigger_id: row.triggerId,
    account_id: row.accountId,
    project_id: row.projectId,
    type: row.type,
    config: publicConfig,
    agent_name: row.agentName,
    prompt_template: row.promptTemplate,
    enabled: row.enabled,
    created_by: row.createdBy,
    metadata: row.metadata ?? {},
    last_fired_at: row.lastFiredAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function serializeProjectTriggerEvent(row: ProjectTriggerEventRow) {
  return {
    event_id: row.eventId,
    trigger_id: row.triggerId,
    account_id: row.accountId,
    project_id: row.projectId,
    status: row.status,
    payload: row.payload ?? {},
    rendered_prompt: row.renderedPrompt,
    session_id: row.sessionId,
    error: row.error,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function serializeGitHubInstallation(row: typeof accountGithubInstallations.$inferSelect | null, accountId: string) {
  const installed = Boolean(row);
  const kortixDefaultAvailable = isGithubPatConfigured();
  // requires_installation is now only true when neither a per-account
  // install nor a Kortix-owned default exists. The default Create flow
  // always uses the Kortix org via PAT when one is configured, so users
  // don't need to install anything to get started.
  const requiresInstallation = isGithubAppConfigured() && !installed && !kortixDefaultAvailable;
  return {
    account_id: accountId,
    installed,
    configured: isGithubAppConfigured(),
    requires_installation: requiresInstallation,
    kortix_default_available: kortixDefaultAvailable,
    pat_fallback_available: !isGithubAppConfigured() && kortixDefaultAvailable,
    install_url: installed ? null : buildGitHubAppInstallUrl(accountId),
    installation_id: row?.installationId ?? null,
    owner_login: row?.ownerLogin ?? null,
    owner_type: row?.ownerType ?? null,
    repository_selection: row?.repositorySelection ?? null,
    permissions: row?.permissions ?? {},
    updated_at: row?.updatedAt.toISOString() ?? null,
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

function parseProjectTriggerType(value: unknown): 'cron' | 'webhook' | null {
  const type = normalizeString(value);
  if (type === 'cron' || type === 'webhook') return type;
  return null;
}

function normalizeRepoUrl(value: unknown): string | null {
  const repoUrl = normalizeString(value);
  if (!repoUrl) return null;
  return repoUrl.replace(/\/+$/, '');
}

function hasOwn(body: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key);
}

export function buildProjectLlmBaseUrl(kortixUrl: string): string {
  const base = kortixUrl.replace(/\/+$/, '');
  if (base.endsWith('/v1/router')) return `${base}/llm`;
  if (base.endsWith('/v1')) return `${base}/router/llm`;
  return `${base}/v1/router/llm`;
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

async function getAccountGitHubInstallation(accountId: string) {
  const [row] = await db
    .select()
    .from(accountGithubInstallations)
    .where(eq(accountGithubInstallations.accountId, accountId))
    .limit(1);
  return row ?? null;
}

class GitHubInstallationRequiredError extends Error {
  constructor(public readonly accountId: string) {
    super('GitHub App installation required for this account');
  }
}

async function resolveGitHubRepoAuth(accountId: string): Promise<{
  auth?: GitHubAuthContext;
  authSource: 'app_installation' | 'pat';
}> {
  const installation = await getAccountGitHubInstallation(accountId);
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
    };
  }

  // No per-account installation. Default Create flow puts the repo under the
  // Kortix-owned org via PAT — users don't have to install anything to get
  // started. Per-account App install remains an opt-in for "use my own org".
  if (isGithubPatConfigured()) {
    return { authSource: 'pat' };
  }

  if (isGithubAppConfigured()) {
    throw new GitHubInstallationRequiredError(accountId);
  }

  throw new Error('GitHub is not configured on the server');
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
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [projectMembers.projectId, projectMembers.userId],
      set: {
        projectRole: input.role,
        grantedBy: input.grantedBy,
        updatedAt: now,
      },
    });
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
  const effectiveRole = effectiveProjectRole(accountRole, projectRole);
  if (!roleAllows(effectiveRole, action)) {
    throw new HTTPException(403, { message: 'You do not have access to this project' });
  }
  (c as any).set('accountId', row.accountId);

  return {
    row,
    userId,
    accountRole,
    projectRole,
    effectiveRole: effectiveRole as ProjectRole,
  };
}

async function buildSessionSandboxEnvVars(input: {
  accountId: string;
  projectId: string;
  sessionId: string;
  userId: string;
  repoUrl: string;
  baseRef: string;
  agentName: string;
  initialPrompt?: string | null;
  githubToken?: string | null;
}): Promise<Record<string, string>> {
  // Project secrets + OAuth credentials + project-scoped CLI token all
  // funnel into the sandbox env. Run them in parallel — the CLI token
  // path mints a fresh token per session boot so the in-container CLI
  // works out of the box.
  const [runtimeSecrets, opencodeAuthContent, cliToken] = await Promise.all([
    listProjectSecrets(input.projectId),
    buildOpencodeAuthContent(input.projectId),
    mintSessionCliToken(input.projectId, input.userId, input.accountId, input.sessionId),
  ]);
  const llmBaseUrl = buildProjectLlmBaseUrl(config.KORTIX_URL);
  const llmToken = encodeSessionLlmToken({
    accountId: input.accountId,
    projectId: input.projectId,
    sessionId: input.sessionId,
    userId: input.userId,
  });
  const githubToken =
    input.githubToken
    || process.env.KORTIX_GITHUB_TOKEN
    || process.env.GITHUB_TOKEN
    || '';
  return {
    ...runtimeSecrets,
    KORTIX_PROJECT_AUTO_CLONE: '1',
    KORTIX_REPO_URL: input.repoUrl,
    KORTIX_DEFAULT_BRANCH: input.baseRef,
    KORTIX_BASE_REF: input.baseRef,
    KORTIX_BRANCH_NAME: input.sessionId,
    KORTIX_PROJECT_ID: input.projectId,
    KORTIX_SESSION_ID: input.sessionId,
    KORTIX_LLM_BASE_URL: llmBaseUrl,
    KORTIX_LLM_TOKEN: llmToken,
    KORTIX_SERVICE_PORT: '8000',
    KORTIX_AGENT_NAME: input.agentName,
    // The project-scoped CLI token. `kortix login`-less auth for any
    // shell inside the sandbox. The CLI reads KORTIX_CLI_TOKEN; we set
    // both names so `kortix` works without configuration AND user code
    // that already reads $KORTIX_TOKEN (e.g. older agents) keeps working.
    ...(cliToken ? { KORTIX_TOKEN: cliToken, KORTIX_CLI_TOKEN: cliToken } : {}),
    KORTIX_API_URL: deriveKortixApiBase(),
    ...(input.initialPrompt ? { KORTIX_INITIAL_PROMPT: input.initialPrompt } : {}),
    ...(githubToken ? { KORTIX_GITHUB_TOKEN: githubToken } : {}),
    ...(opencodeAuthContent ? { OPENCODE_AUTH_CONTENT: opencodeAuthContent } : {}),
  };
}

/** Mint a project-scoped CLI token at session boot. Stored hashed
 *  alongside user-scoped tokens; auth middleware enforces the project
 *  scope based on the `project_id` column. */
async function mintSessionCliToken(
  projectId: string,
  userId: string,
  accountId: string,
  sessionId: string,
): Promise<string | null> {
  try {
    const result = await createAccountToken({
      accountId,
      userId,
      projectId,
      name: `session ${sessionId.slice(0, 8)}`,
    });
    return result.secretKey;
  } catch (err) {
    console.warn(
      `[mintSessionCliToken] could not mint CLI token for session ${sessionId}:`,
      err,
    );
    return null;
  }
}

/** Best-effort derivation of the API base URL we want sandboxes to
 *  call as `$KORTIX_API_URL`. KORTIX_URL is the platform's router URL
 *  with `/v1/router` suffix; we strip that to get the API root. */
function deriveKortixApiBase(): string {
  const url = config.KORTIX_URL;
  if (!url) return 'https://api.kortix.com';
  return url.replace(/\/v1\/router\/?$/, '');
}

export async function createProjectSession(input: {
  project: ProjectRow;
  userId: string;
  body: Record<string, unknown>;
  enforceAccountCap?: boolean;
  metadata?: Record<string, unknown>;
  request?: RequestAuditContext;
}): Promise<{ row?: ProjectSessionRow; error?: SessionCreateError; headers?: Record<string, string> }> {
  const { project, userId, body } = input;
  const projectId = project.projectId;
  const accountId = project.accountId;

  const baseRef = normalizeString(body.base_ref ?? body.baseRef) ?? project.defaultBranch;
  const agentName = normalizeString(body.agent_name ?? body.agentName) ?? 'default';
  const requestedProvider = normalizeString(body.provider);
  let providerName: SandboxProviderName = config.getDefaultProvider();
  if (requestedProvider) {
    if (!(config.ALLOWED_SANDBOX_PROVIDERS as readonly string[]).includes(requestedProvider)) {
      return { error: { status: 400, body: { error: `Unknown or disabled sandbox provider: ${requestedProvider}` } } };
    }
    providerName = requestedProvider as SandboxProviderName;
  }

  let responseHeaders: Record<string, string> | undefined;

  if (input.enforceAccountCap !== false) {
    const capResult = await checkConcurrentSessionCap(accountId, userId, input.request);
    responseHeaders = capResult.headers;
    if (capResult.error) return { error: capResult.error };
  }

  const sessionId = randomUUID();
  let gitAuth: Awaited<ReturnType<typeof resolveGitHubRepoAuth>>;

  try {
    gitAuth = await resolveGitHubRepoAuth(accountId);
  } catch (error) {
    if (error instanceof GitHubInstallationRequiredError) {
      return {
        error: {
          status: 409,
          body: {
            error: error.message,
            install_url: buildGitHubAppInstallUrl(error.accountId),
          },
        },
      };
    }
    const message = (error as Error).message || 'GitHub is not configured on the server';
    return { error: { status: 503, body: { error: message } } };
  }

  const projectWithGitAuth = {
    ...project,
    gitAuthToken: gitAuth.auth?.token ?? null,
  };

  try {
    await createRemoteSessionBranch(projectWithGitAuth, sessionId, baseRef);
  } catch (error) {
    const message = (error as Error).message || 'Failed to create remote branch';
    return { error: { status: 502, body: { error: message } } };
  }

  const initialPrompt = normalizeString(body.initial_prompt ?? body.initialPrompt);
  const sessionName = normalizeString(body.name);
  const requestMetadata = normalizeJsonObject(body.metadata);
  const metadata = {
    ...requestMetadata,
    ...(sessionName ? { name: sessionName } : {}),
    ...(initialPrompt ? { initial_prompt: initialPrompt } : {}),
    ...(input.metadata ?? {}),
  };

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
    try {
      const extraEnvVars = await buildSessionSandboxEnvVars({
        accountId,
        projectId,
        sessionId,
        userId,
        repoUrl: project.repoUrl,
        baseRef,
        agentName,
        initialPrompt,
        githubToken: gitAuth.auth?.token ?? null,
      });
      await provisionSessionSandbox({
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
          gitAuthToken: gitAuth.auth?.token ?? null,
        },
        baseRef,
      });
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

function triggerWebhookSecret(row: ProjectTriggerRow): string | null {
  const cfg = normalizeJsonObject(row.config);
  return normalizeString(cfg.secret ?? cfg.webhook_secret ?? cfg.webhookSecret);
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
  const configured = Number((config as any).KORTIX_TRIGGER_MAX_PROVISIONING_SESSIONS_PER_PROJECT);
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

async function fireProjectTrigger(input: {
  trigger: ProjectTriggerRow;
  project: ProjectRow;
  payload: Record<string, unknown>;
  renderedPrompt: string;
  request?: RequestAuditContext;
  markAcceptedAt?: Date;
}): Promise<{
  status: 'queued' | 'fired' | 'failed';
  reason?: string;
  error?: string;
  event: ProjectTriggerEventRow;
  session?: ProjectSessionRow;
  httpStatus?: number;
  backpressure?: Awaited<ReturnType<typeof triggerBackpressureState>>;
}> {
  const { trigger, project, payload, renderedPrompt } = input;
  const backpressure = await triggerBackpressureState(trigger.accountId, trigger.projectId);
  const [event] = await db
    .insert(projectTriggerEvents)
    .values({
      triggerId: trigger.triggerId,
      accountId: trigger.accountId,
      projectId: trigger.projectId,
      status: 'queued',
      payload,
      renderedPrompt,
      updatedAt: new Date(),
    })
    .returning();

  if (backpressure.shouldQueue) {
    if (input.markAcceptedAt) {
      await db
        .update(projectTriggers)
        .set({ lastFiredAt: input.markAcceptedAt, updatedAt: new Date() })
        .where(eq(projectTriggers.triggerId, trigger.triggerId))
        .returning();
    }
    return {
      status: 'queued',
      reason: backpressure.provisioning >= backpressure.projectProvisioningLimit
        ? 'project provisioning backpressure'
        : 'account session cap',
      event,
      backpressure,
    };
  }

  if (!trigger.createdBy) {
    const message = 'Trigger has no actor to own the session';
    const [failedEvent] = await db
      .update(projectTriggerEvents)
      .set({ status: 'failed', error: message, updatedAt: new Date() })
      .where(eq(projectTriggerEvents.eventId, event.eventId))
      .returning();
    return {
      status: 'failed',
      error: message,
      event: failedEvent ?? event,
      httpStatus: 409,
    };
  }

  const triggerConfig = normalizeJsonObject(trigger.config);
  const provider = normalizeString(triggerConfig.provider);
  const sessionResult = await createProjectSession({
    project,
    userId: trigger.createdBy,
    enforceAccountCap: false,
    request: input.request,
    body: {
      agent_name: trigger.agentName,
      initial_prompt: renderedPrompt,
      ...(provider ? { provider } : {}),
      metadata: {
        trigger_id: trigger.triggerId,
        trigger_event_id: event.eventId,
        trigger_type: trigger.type,
      },
    },
    metadata: {
      trigger_id: trigger.triggerId,
      trigger_event_id: event.eventId,
      trigger_type: trigger.type,
    },
  });

  if (sessionResult.error) {
    const message = String(sessionResult.error.body.error ?? 'Failed to create trigger session');
    const [failedEvent] = await db
      .update(projectTriggerEvents)
      .set({ status: 'failed', error: message, updatedAt: new Date() })
      .where(eq(projectTriggerEvents.eventId, event.eventId))
      .returning();
    return {
      status: 'failed',
      error: message,
      event: failedEvent ?? event,
      httpStatus: sessionResult.error.status,
    };
  }

  const session = sessionResult.row!;
  const [updatedEvent] = await db
    .update(projectTriggerEvents)
    .set({
      status: 'fired',
      sessionId: session.sessionId,
      updatedAt: new Date(),
    })
    .where(eq(projectTriggerEvents.eventId, event.eventId))
    .returning();

  await db
    .update(projectTriggers)
    .set({ lastFiredAt: input.markAcceptedAt ?? new Date(), updatedAt: new Date() })
    .where(eq(projectTriggers.triggerId, trigger.triggerId))
    .returning();

  return {
    status: 'fired',
    event: updatedEvent ?? event,
    session,
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

  const { specs } = await loadProjectTriggers({
    projectId: project.projectId,
    repoUrl: project.repoUrl,
    defaultBranch: project.defaultBranch,
    manifestPath: project.manifestPath,
  });
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

function triggerSchedulerIntervalMs() {
  const raw = Number((config as any).KORTIX_TRIGGER_SCHEDULER_INTERVAL_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 60_000;
}

function cronTriggerSchedule(row: ProjectTriggerRow): string | null {
  const cfg = normalizeJsonObject(row.config);
  return normalizeString(cfg.cron ?? cfg.schedule);
}

function cronTriggerTimezone(row: ProjectTriggerRow): string | undefined {
  const cfg = normalizeJsonObject(row.config);
  return normalizeString(cfg.timezone) ?? undefined;
}

export function nextCronRun(schedule: string, from: Date, timezone?: string): Date | null {
  const job = new Cron(schedule, { paused: true, ...(timezone ? { timezone } : {}) });
  return job.nextRun(from);
}

export function isCronTriggerDue(row: ProjectTriggerRow, now = new Date()): boolean {
  const schedule = cronTriggerSchedule(row);
  if (!schedule) return false;
  const next = nextCronRun(schedule, row.lastFiredAt ?? row.createdAt, cronTriggerTimezone(row));
  return Boolean(next && next.getTime() <= now.getTime());
}

/**
 * Walks every active project's git repo for `.opencode/triggers/*.md` and
 * fires due cron triggers. Triggers are 100% file-defined now — the DB
 * `project_triggers` table is no longer scanned.
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
 * Fire a git-backed trigger. Parallels `fireProjectTrigger` but skips the
 * `project_trigger_events` row (the events table is FK-bound to
 * `project_triggers`, and we want to keep that constraint clean). The
 * project_sessions row carries `trigger_slug` in metadata so audits still
 * reconstruct the firing path.
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
 * cron triggers that are due. Mirrors `runProjectTriggerSweep` for the
 * DB-backed path but writes to `project_trigger_runtime` instead of
 * `project_triggers.last_fired_at`.
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
      const loaded = await loadProjectTriggers({
        projectId: project.projectId,
        repoUrl: project.repoUrl,
        defaultBranch: project.defaultBranch,
        manifestPath: project.manifestPath,
      });
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
          schedule: spec.cron,
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
  if ((config as any).KORTIX_TRIGGER_SCHEDULER_ENABLED === false) return;
  if (globalForProjectTriggers.__kortixProjectTriggerSchedulerTimer) {
    clearInterval(globalForProjectTriggers.__kortixProjectTriggerSchedulerTimer);
  }
  triggerSchedulerTimer = setInterval(() => {
    runProjectTriggerSweep().then((result) => {
      if (result.fired || result.queued || result.failed) {
        console.log('[project-triggers] sweep completed', result);
      }
    }).catch((error) => {
      console.error('[project-triggers] sweep failed:', error);
    });

    // Same cadence drives the [[apps]] auto-deploy sweep. Run independently
    // so a slow app deploy never blocks the cron trigger fires. Skipped
    // entirely when the experimental flag is off — no point reading
    // every project's manifest just to ignore the `apps` block.
    if (config.KORTIX_APPS_EXPERIMENTAL) {
      runProjectAppSweep().then((result) => {
        if (result.deployed || result.failed) {
          console.log('[project-apps] sweep completed', result);
        }
      }).catch((error) => {
        console.error('[project-apps] sweep failed:', error);
      });
    }

    import('../channels/sweep').then(({ runChannelBindingSweep }) =>
      runChannelBindingSweep().then((result) => {
        if (result.inserted || result.updated || result.removed) {
          console.log('[channels] binding sweep completed', result);
        }
      }),
    ).catch((error) => {
      console.error('[channels] binding sweep failed:', error);
    });
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

  if (isAccountManager(scope.accountRole)) {
    const rows = await db
      .select()
      .from(projects)
      .where(and(eq(projects.accountId, scope.accountId), eq(projects.status, 'active')))
      .orderBy(desc(projects.updatedAt));

    return c.json(rows.map((row) => serializeProject(row, {
      projectRole: null,
      effectiveRole: 'manager',
    })));
  }

  const grants = await db
    .select({ projectId: projectMembers.projectId, projectRole: projectMembers.projectRole })
    .from(projectMembers)
    .where(and(
      eq(projectMembers.accountId, scope.accountId),
      eq(projectMembers.userId, scope.userId),
    ));

  if (grants.length === 0) return c.json([]);

  const roleByProject = new Map(grants.map((g) => [g.projectId, g.projectRole as ProjectRole]));
  const rows = await db
    .select()
    .from(projects)
    .where(and(
      eq(projects.accountId, scope.accountId),
      eq(projects.status, 'active'),
      inArray(projects.projectId, grants.map((g) => g.projectId)),
    ))
    .orderBy(desc(projects.updatedAt));

  return c.json(rows.map((row) => {
    const projectRole = roleByProject.get(row.projectId) ?? null;
    return serializeProject(row, {
      projectRole,
      effectiveRole: projectRole ?? 'viewer',
    });
  }));
});

// POST /v1/projects
projectsApp.post('/', async (c) => {
  const body = await readBody(c);
  const scope = await resolveProjectAccount(c, body);
  if (!isAccountManager(scope.accountRole)) {
    return c.json({ error: 'Owner or admin role required' }, 403);
  }

  const repoUrl = normalizeRepoUrl(body.repo_url ?? body.repoUrl);
  if (!repoUrl) {
    return c.json({ error: 'repo_url is required' }, 400);
  }

  const name = normalizeString(body.name) ?? deriveProjectName(repoUrl);
  const defaultBranch = normalizeString(body.default_branch ?? body.defaultBranch) ?? 'main';
  const manifestPath = normalizeString(body.manifest_path ?? body.manifestPath) ?? 'kortix.toml';
  const now = new Date();

  const [row] = await db
    .insert(projects)
    .values({
      accountId: scope.accountId,
      name,
      repoUrl,
      defaultBranch,
      manifestPath,
      status: 'active',
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [projects.accountId, projects.repoUrl],
      set: {
        name,
        defaultBranch,
        manifestPath,
        status: 'active',
        updatedAt: now,
      },
    })
    .returning();

  await grantProjectRole({
    accountId: scope.accountId,
    projectId: row.projectId,
    userId: scope.userId,
    role: 'manager',
    grantedBy: scope.userId,
  });

  // Kick off the first snapshot build for this project's default branch.
  // Fire-and-forget: snapshot builds take minutes, the API response must
  // not wait. The dashboard's Sandbox Snapshot panel polls the row
  // until it flips to `ready`. See apps/api/src/snapshots/builder.ts.
  void kickInitialSnapshotBuild(row, scope.accountId);

  return c.json(serializeProject(row, { projectRole: 'manager', effectiveRole: 'manager' }), 201);
});

// GET /v1/projects/github/installation?account_id=...
// Account-scoped GitHub App install state. The client only receives metadata;
// installation tokens are minted server-side at repo creation time.
projectsApp.get('/github/installation', async (c) => {
  const scope = await resolveProjectAccount(c);
  if (!isAccountManager(scope.accountRole)) {
    return c.json({ error: 'Owner or admin role required' }, 403);
  }

  const row = await getAccountGitHubInstallation(scope.accountId);
  return c.json(serializeGitHubInstallation(row, scope.accountId));
});

// POST /v1/projects/github/installation
// Called after GitHub redirects back with installation_id + state=account_id.
// We fetch installation metadata with the app JWT instead of trusting client
// supplied owner information.
projectsApp.post('/github/installation', async (c) => {
  const body = await readBody(c);
  const scope = await resolveProjectAccount(c, body);
  if (!isAccountManager(scope.accountRole)) {
    return c.json({ error: 'Owner or admin role required' }, 403);
  }

  const installationId = normalizeString(body.installation_id ?? body.installationId);
  if (!installationId) return c.json({ error: 'installation_id is required' }, 400);
  if (!/^[0-9]+$/.test(installationId)) {
    return c.json({ error: 'installation_id must be a GitHub installation id' }, 400);
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
      target: [accountGithubInstallations.accountId],
      set: {
        installationId,
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

  return c.json(serializeGitHubInstallation(row, scope.accountId), 200);
});

// DELETE /v1/projects/github/installation?account_id=...
projectsApp.delete('/github/installation', async (c) => {
  const scope = await resolveProjectAccount(c);
  if (!isAccountManager(scope.accountRole)) {
    return c.json({ error: 'Owner or admin role required' }, 403);
  }

  await db
    .delete(accountGithubInstallations)
    .where(eq(accountGithubInstallations.accountId, scope.accountId));

  return c.json({ ok: true });
});

// POST /v1/projects/create-repo
// Creates a new GitHub repository using the account's GitHub App installation,
// then registers it as a Kortix project.
projectsApp.post('/create-repo', async (c) => {
  const body = await readBody(c);
  const scope = await resolveProjectAccount(c, body);
  if (!isAccountManager(scope.accountRole)) {
    return c.json({ error: 'Owner or admin role required' }, 403);
  }

  const name = normalizeString(body.name);
  if (!name) return c.json({ error: 'name is required' }, 400);
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    return c.json({ error: 'name must contain only letters, numbers, hyphens, underscores or dots' }, 400);
  }

  const isPrivate = typeof body.private === 'boolean' ? body.private : true;
  const description = normalizeString(body.description);
  const owner = normalizeString(body.owner);

  let githubAuth: Awaited<ReturnType<typeof resolveGitHubRepoAuth>>;
  try {
    githubAuth = await resolveGitHubRepoAuth(scope.accountId);
  } catch (error) {
    if (error instanceof GitHubInstallationRequiredError) {
      return c.json({
        error: error.message,
        install_url: buildGitHubAppInstallUrl(error.accountId),
      }, 409);
    }
    const message = (error as Error).message || 'GitHub is not configured on the server';
    return c.json({ error: message }, 503);
  }

  let repo;
  try {
    repo = await createRepo({
      name,
      isPrivate,
      description: description ?? undefined,
      owner: githubAuth.auth ? undefined : owner ?? undefined,
      autoInit: true,
      auth: githubAuth.auth,
    });
  } catch (error) {
    const message = (error as Error).message || 'Failed to create GitHub repository';
    return c.json({ error: message }, 502);
  }

  const projectName = normalizeString(body.project_name ?? body.projectName) ?? deriveProjectName(repo.full_name);
  const defaultBranch = repo.default_branch || 'main';
  const now = new Date();

  // Commit the minimal Kortix starter (kortix.toml + .opencode runtime +
  // default agent + README + .gitignore) into the fresh repo so users land
  // with a working project shape on first session boot. GitHub's Contents
  // API updates the branch tip on every write, so these must be sequential.
  // A partial starter is not a usable project.
  const [ownerLogin, repoSlug] = repo.full_name.split('/');
  const starter = buildStarterFiles({ projectName, repoFullName: repo.full_name });
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

  const [row] = await db
    .insert(projects)
    .values({
      accountId: scope.accountId,
      name: projectName,
      repoUrl: repo.clone_url,
      defaultBranch,
      manifestPath: 'kortix.toml',
      status: 'active',
      metadata: {
        github: {
          full_name: repo.full_name,
          html_url: repo.html_url,
          private: repo.private,
          auth_source: githubAuth.authSource,
        },
      },
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [projects.accountId, projects.repoUrl],
      set: {
        name: projectName,
        defaultBranch,
        status: 'active',
        updatedAt: now,
      },
    })
    .returning();

  await grantProjectRole({
    accountId: scope.accountId,
    projectId: row.projectId,
    userId: scope.userId,
    role: 'manager',
    grantedBy: scope.userId,
  });

  // Kick off the first snapshot build (same fire-and-forget contract as the
  // plain POST /v1/projects path above). The starter is already committed
  // to the new repo, so .kortix/Dockerfile exists at this point.
  void kickInitialSnapshotBuild(row, scope.accountId, {
    gitAuthToken: githubAuth.auth?.token ?? null,
  });

  return c.json(serializeProject(row, { projectRole: 'manager', effectiveRole: 'manager' }), 201);
});

// ─── Snapshots ─────────────────────────────────────────────────────────────
// Per-project Daytona snapshots. The "Sandbox snapshot" panel on the project
// settings page calls these endpoints to show build status (latest commit
// on default branch vs commit of latest ready snapshot) and to trigger
// manual rebuilds.

function serializeProjectSnapshot(row: {
  snapshotRowId: string;
  projectId: string;
  provider: string;
  commitSha: string;
  branch: string;
  snapshotId: string | null;
  status: string;
  error: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    snapshot_row_id: row.snapshotRowId,
    project_id: row.projectId,
    provider: row.provider,
    commit_sha: row.commitSha,
    branch: row.branch,
    snapshot_id: row.snapshotId,
    status: row.status,
    error: row.error,
    metadata: row.metadata ?? {},
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

// GET /v1/projects/:projectId/snapshots
// Returns the snapshot history for a project plus the latest commit SHA on
// the project's default branch so the UI can compare it against the most
// recent `ready` snapshot's commit and show "needs rebuild" when they
// drift apart.
projectsApp.get('/:projectId/snapshots', async (c) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  let rows: Awaited<ReturnType<typeof listSnapshotsForProject>> = [];
  try {
    rows = await listSnapshotsForProject(projectId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: `Failed to list snapshots: ${message}` }, 500);
  }

  // Resolve the current HEAD on the default branch so the UI can detect
  // "the latest ready snapshot is behind the branch tip". Failure here is
  // non-fatal — we still return the snapshot history without it (e.g.
  // GitHub App not yet installed for the account).
  let headCommitSha: string | null = null;
  let headResolveError: string | null = null;
  try {
    const gitAuth = await resolveGitHubRepoAuth(loaded.row.accountId);
    headCommitSha = await resolveCommitSha(
      {
        projectId,
        repoUrl: loaded.row.repoUrl,
        defaultBranch: loaded.row.defaultBranch,
        manifestPath: loaded.row.manifestPath,
        gitAuthToken: gitAuth.auth?.token ?? null,
      },
      loaded.row.defaultBranch,
    );
  } catch (err) {
    headResolveError = err instanceof Error ? err.message : String(err);
  }

  return c.json({
    items: rows.map(serializeProjectSnapshot),
    default_branch: loaded.row.defaultBranch,
    head_commit_sha: headCommitSha,
    head_resolve_error: headResolveError,
  });
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
  if (!isAccountManager(loaded.accountRole)) {
    return c.json({ error: 'Owner or admin role required' }, 403);
  }

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
  if (!isAccountManager(loaded.accountRole)) {
    return c.json({ error: 'Owner or admin role required' }, 403);
  }
  const ok = await revokeAccountToken(tokenId, loaded.row.accountId);
  if (!ok) return c.json({ error: 'token not found or already revoked' }, 404);
  return c.json({ ok: true });
});

// POST /v1/projects/:projectId/snapshots/rebuild
// Manually kick off a build for the current HEAD of the project's default
// branch. Idempotent: if a `ready` snapshot already exists for that
// commit, returns immediately with `status: 'already-ready'`.
projectsApp.post('/:projectId/snapshots/rebuild', async (c) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  if (!isAccountManager(loaded.accountRole)) {
    return c.json({ error: 'Owner or admin role required' }, 403);
  }

  let gitAuth: Awaited<ReturnType<typeof resolveGitHubRepoAuth>>;
  try {
    gitAuth = await resolveGitHubRepoAuth(loaded.row.accountId);
  } catch (error) {
    if (error instanceof GitHubInstallationRequiredError) {
      return c.json(
        {
          error: error.message,
          install_url: buildGitHubAppInstallUrl(error.accountId),
        },
        409,
      );
    }
    const message = (error as Error).message || 'GitHub is not configured on the server';
    return c.json({ error: message }, 503);
  }

  const result = await ensureBuildForLatestCommit(
    {
      projectId,
      repoUrl: loaded.row.repoUrl,
      defaultBranch: loaded.row.defaultBranch,
      manifestPath: loaded.row.manifestPath,
      gitAuthToken: gitAuth.auth?.token ?? null,
    },
    {
      branch: loaded.row.defaultBranch,
      accountId: loaded.row.accountId,
      source: 'manual',
    },
  );

  if (result.status === 'failed-to-start') {
    return c.json({ error: result.error ?? 'Failed to start build' }, 502);
  }

  return c.json({
    status: result.status,
    branch: loaded.row.defaultBranch,
    commit_sha: result.commitSha ?? null,
  });
});

// GET /v1/projects/:projectId/secrets
// Returns stored secrets (names only, no plaintext) plus the manifest-
// declared required/optional env keys, so the UI can show a "must-set"
// checklist alongside what's already configured.
projectsApp.get('/:projectId/secrets', async (c) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  if (!isAccountManager(loaded.accountRole)) {
    return c.json({ error: 'Owner or admin role required' }, 403);
  }

  const rows = await db
    .select()
    .from(projectSecrets)
    .where(eq(projectSecrets.projectId, projectId))
    .orderBy(desc(projectSecrets.updatedAt));

  // Manifest is optional — a project without kortix.toml just gets empty
  // required/optional lists. We surface loaded/missing/error explicitly so the
  // UI can distinguish "no envs declared" from "we couldn't read the manifest".
  let required: string[] = [];
  let optional: string[] = [];
  let manifestStatus: 'loaded' | 'missing' | 'error' = 'missing';
  let manifestError: string | null = null;
  try {
    const projectConfig = await loadProjectConfig(loaded.row, []);
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

  return c.json({
    items: rows.map(serializeProjectSecret),
    required,
    optional,
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
  if (!isAccountManager(loaded.accountRole)) {
    return c.json({ error: 'Owner or admin role required' }, 403);
  }

  const name = normalizeString(body.name)?.toUpperCase();
  if (!name) return c.json({ error: 'name is required' }, 400);
  if (!isValidSecretName(name)) {
    return c.json({ error: 'name must be a valid env var name (A-Z, 0-9, _; max 64 chars)' }, 400);
  }
  if (name.startsWith('KORTIX_')) {
    return c.json({ error: 'KORTIX_* names are reserved for platform runtime variables' }, 400);
  }

  const value = typeof body.value === 'string' ? body.value : null;
  if (value === null) return c.json({ error: 'value is required' }, 400);

  const now = new Date();
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
      target: [projectSecrets.projectId, projectSecrets.name],
      set: {
        valueEnc: encryptProjectSecret(projectId, value),
        updatedAt: now,
      },
    })
    .returning();

  return c.json(serializeProjectSecret(row), 200);
});

// DELETE /v1/projects/:projectId/secrets/:name
projectsApp.delete('/:projectId/secrets/:name', async (c) => {
  const projectId = c.req.param('projectId');
  const name = c.req.param('name')?.trim().toUpperCase();
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  if (!isAccountManager(loaded.accountRole)) {
    return c.json({ error: 'Owner or admin role required' }, 403);
  }
  if (!name || !isValidSecretName(name)) {
    return c.json({ error: 'Invalid secret name' }, 400);
  }

  await db
    .delete(projectSecrets)
    .where(and(
      eq(projectSecrets.projectId, projectId),
      eq(projectSecrets.name, name),
    ));

  return c.json({ ok: true });
});

// ─── OAuth provider credentials ────────────────────────────────────────────
//
// Mirrors the opencode auth flow (codex.ts / github-copilot/copilot.ts) but
// persists tokens as encrypted per-project rows instead of opencode's local
// auth.json. At session boot, all connected providers are bundled into the
// `OPENCODE_AUTH_CONTENT` env var which opencode reads natively.

// GET /v1/projects/:projectId/oauth
projectsApp.get('/:projectId/oauth', async (c) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  if (!isAccountManager(loaded.accountRole)) {
    return c.json({ error: 'Owner or admin role required' }, 403);
  }

  const creds = await listOauthCredentials(projectId);
  return c.json({
    items: creds.map(summarizeCredential),
    supported: SUPPORTED_OAUTH_PROVIDERS,
  });
});

// POST /v1/projects/:projectId/oauth/:provider/start
projectsApp.post('/:projectId/oauth/:provider/start', async (c) => {
  const projectId = c.req.param('projectId');
  const provider = c.req.param('provider');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  if (!isAccountManager(loaded.accountRole)) {
    return c.json({ error: 'Owner or admin role required' }, 403);
  }
  if (!isSupportedOauthProvider(provider)) {
    return c.json({ error: `Unsupported OAuth provider: ${provider}` }, 400);
  }

  const body = await readBody(c);
  const enterpriseUrl = normalizeString(body.enterprise_url ?? body.enterpriseUrl);

  try {
    const flowStart = provider === 'openai'
      ? await startOpenAiDeviceFlow()
      : await startCopilotDeviceFlow({ enterpriseUrl: enterpriseUrl ?? undefined });

    const { flowId } = createFlow({
      projectId,
      providerId: provider,
      handle: flowStart.handle,
      intervalMs: flowStart.interval_ms,
      expiresAt: flowStart.expires_at,
    });

    return c.json({
      flow_id: flowId,
      provider_id: provider,
      verification_url: flowStart.verification_url,
      user_code: flowStart.user_code,
      interval_ms: flowStart.interval_ms,
      expires_at: flowStart.expires_at,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[projects] oauth start failed', { projectId, provider, error: msg });
    return c.json({ error: msg }, 502);
  }
});

// POST /v1/projects/:projectId/oauth/:provider/poll
// Body: { flow_id: string }
// Returns one of:
//   { status: 'pending', next_poll_ms }
//   { status: 'success', credential: {...} }
//   { status: 'expired' }
//   { status: 'failed', error }
projectsApp.post('/:projectId/oauth/:provider/poll', async (c) => {
  const projectId = c.req.param('projectId');
  const provider = c.req.param('provider');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  if (!isAccountManager(loaded.accountRole)) {
    return c.json({ error: 'Owner or admin role required' }, 403);
  }
  if (!isSupportedOauthProvider(provider)) {
    return c.json({ error: `Unsupported OAuth provider: ${provider}` }, 400);
  }

  const body = await readBody(c);
  const flowId = normalizeString(body.flow_id ?? body.flowId);
  if (!flowId) return c.json({ error: 'flow_id is required' }, 400);

  const flow = getFlow(flowId);
  if (!flow) return c.json({ status: 'expired' });
  if (flow.projectId !== projectId) return c.json({ error: 'Flow not found' }, 404);
  if (flow.providerId !== provider) return c.json({ error: 'Provider mismatch' }, 400);
  if (flow.expiresAt < Date.now()) {
    deleteFlow(flowId);
    return c.json({ status: 'expired' });
  }

  try {
    const result = provider === 'openai'
      ? await pollOnceOpenAi(flow.handle)
      : await pollOnceCopilot(flow.handle);

    if (result.status === 'pending') {
      return c.json({ status: 'pending', next_poll_ms: flow.recommendedIntervalMs });
    }
    if (result.status === 'slow_down') {
      bumpInterval(flowId, result.new_interval_ms);
      return c.json({ status: 'pending', next_poll_ms: result.new_interval_ms });
    }
    if (result.status === 'failed') {
      deleteFlow(flowId);
      return c.json({ status: 'failed', error: result.error });
    }

    const credential = await upsertOauthCredential({
      projectId,
      providerId: provider as OauthProviderId,
      refresh: result.refresh,
      access: result.access,
      expires: result.expires,
      accountId: result.accountId,
      enterpriseUrl: result.enterpriseUrl,
      createdBy: loaded.userId,
    });
    deleteFlow(flowId);

    return c.json({
      status: 'success',
      credential: summarizeCredential(credential),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[projects] oauth poll failed', { projectId, provider, error: msg });
    return c.json({ status: 'failed', error: msg }, 502);
  }
});

// DELETE /v1/projects/:projectId/oauth/:provider
projectsApp.delete('/:projectId/oauth/:provider', async (c) => {
  const projectId = c.req.param('projectId');
  const provider = c.req.param('provider');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  if (!isAccountManager(loaded.accountRole)) {
    return c.json({ error: 'Owner or admin role required' }, 403);
  }
  if (!isSupportedOauthProvider(provider)) {
    return c.json({ error: `Unsupported OAuth provider: ${provider}` }, 400);
  }

  await deleteOauthCredential(projectId, provider);
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
  const base = (config.KORTIX_URL || '').replace(/\/+$/, '');
  // Server-side webhooks are mounted at /v1/webhooks/projects/:projectId/:slug.
  // KORTIX_URL typically ends in `/v1/router`; we strip the trailing `/v1*`
  // segments and reattach `/v1/webhooks/...` so the URL is clean.
  const stripped = base.replace(/\/v1(\/.*)?$/, '');
  const root = stripped || base;
  return `${root}/v1/webhooks/projects/${projectId}/${slug}`;
}

// ── Git-backed trigger CRUD helpers ─────────────────────────────────────────

/** Builds the GET-listing response shape (specs + runtime + errors). */
async function loadTriggersForResponse(projectId: string, project: ProjectRow) {
  const { specs, errors } = await loadProjectTriggers(project);
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
    const cron = normalizeString((body as any).cron ?? (body as any).schedule);
    if (!cron) return { error: 'cron triggers must declare a `cron` expression' };
    return {
      slug,
      name,
      type: 'cron',
      agent,
      enabled,
      promptTemplate,
      cron,
      timezone: normalizeString((body as any).timezone) ?? 'UTC',
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

async function resolveTriggerCommitAuth(accountId: string) {
  const auth = await resolveGitHubRepoAuth(accountId);
  return auth.auth ?? undefined;
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
    timezone: draft.timezone,
    secretEnv: draft.secretEnv,
  };
}

/**
 * Read the project's manifest. If kortix.toml doesn't exist yet (brand-new
 * repo), synthesize a minimal valid one so the first POST /triggers can
 * scaffold it on save.
 */
async function loadManifestForEdit(project: ProjectRow): Promise<ParsedManifest> {
  const existing = await readManifest(project);
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
async function commitManifest(
  project: ProjectRow,
  manifest: ParsedManifest,
  message: string,
): Promise<{ ok: true } | { error: string; status: number }> {
  const repo = parseGitHubRepoUrl(project.repoUrl);
  if (!repo) return { error: 'Project repo URL is not a GitHub URL', status: 400 };

  let auth: GitHubAuthContext | undefined;
  try {
    auth = await resolveTriggerCommitAuth(project.accountId);
  } catch (err) {
    return {
      error: `GitHub auth unavailable: ${(err as Error).message || String(err)}`,
      status: 502,
    };
  }

  const branch = project.defaultBranch;
  const existingSha = await getFileSha({
    owner: repo.owner,
    repo: repo.repo,
    path: MANIFEST_FILENAME,
    branch,
    auth,
  });

  try {
    await commitFile({
      owner: repo.owner,
      repo: repo.repo,
      path: MANIFEST_FILENAME,
      content: serializeManifest(manifest),
      message,
      branch,
      existingSha: existingSha ?? undefined,
      auth,
    });
  } catch (err) {
    return {
      error: `Failed to commit ${MANIFEST_FILENAME}: ${(err as Error).message || String(err)}`,
      status: 502,
    };
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

// ─── Channels CRUD ───────────────────────────────────────────────────────
// All channel mutations round-trip through kortix.toml — read manifest,
// upsert/remove the [[channels]] entry, commit back via the GitHub App.
// Mirrors the trigger CRUD; uses the same loadManifestForEdit + commitManifest.

const CHANNEL_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/;

function upsertChannelInManifest(manifest: ParsedManifest, spec: ChannelSpec): ParsedManifest {
  const current = Array.isArray(manifest.raw.channels)
    ? (manifest.raw.channels as Record<string, unknown>[])
    : [];
  const entry = channelSpecToTomlEntry(spec);
  const idx = current.findIndex(
    (e) => typeof e?.slug === 'string' && e.slug === spec.slug,
  );
  const next = current.slice();
  if (idx >= 0) next[idx] = entry;
  else next.push(entry);
  return { ...manifest, raw: { ...manifest.raw, channels: next } };
}

function removeChannelFromManifest(manifest: ParsedManifest, slug: string): ParsedManifest {
  const current = Array.isArray(manifest.raw.channels)
    ? (manifest.raw.channels as Record<string, unknown>[])
    : [];
  const next = current.filter(
    (e) => !(typeof e?.slug === 'string' && e.slug === slug),
  );
  return { ...manifest, raw: { ...manifest.raw, channels: next } };
}

function parseChannelDraft(
  body: Record<string, unknown>,
  opts: { existingSlug: string | null },
): ChannelSpec | { error: string } {
  const slug = normalizeString(body.slug) ?? opts.existingSlug ?? '';
  if (!slug || !CHANNEL_SLUG_RE.test(slug)) {
    return { error: 'slug is required (lowercase letters, digits, dashes, underscores)' };
  }
  const platformRaw = normalizeString(body.platform) ?? 'slack';
  if (platformRaw !== 'slack') {
    return { error: `Unsupported platform "${platformRaw}". Currently: slack.` };
  }
  const channelId = normalizeString(body.channel_id ?? (body as any).channelId);
  const channelName = normalizeString(body.channel_name ?? (body as any).channelName);
  if (!channelId && !channelName) return { error: 'channel_id or channel_name is required' };
  if (channelId && channelName) return { error: 'set channel_id or channel_name, not both' };
  if (platformRaw === 'slack' && channelId && !/^[A-Z0-9]{2,32}$/.test(channelId)) {
    return { error: `Slack channel_id "${channelId}" does not look right` };
  }
  const prompt = normalizeString(body.prompt_prefix ?? (body as any).promptPrefix ?? body.prompt);
  if (!prompt) return { error: 'prompt_prefix is required' };

  const name = normalizeString(body.name) ?? slug;
  const agent = normalizeString(body.agent ?? (body as any).agent_name) ?? 'default';
  const enabled = body.enabled === undefined ? true : Boolean(body.enabled);
  const responseRaw = normalizeString(body.response ?? (body as any).response_style) ?? 'text';
  const responseStyle = (['plan', 'text', 'none'] as const).includes(responseRaw as any)
    ? (responseRaw as 'plan' | 'text' | 'none')
    : 'text';

  const eventsRaw = Array.isArray(body.events) ? body.events : ['mention'];
  const events: ChannelSpec['events'] = [];
  const validEvents = ['mention', 'dm', 'subscribed', 'slash', 'action'] as const;
  for (const e of eventsRaw) {
    if (typeof e !== 'string') continue;
    const v = e.trim().toLowerCase();
    if (validEvents.includes(v as never) && !events.includes(v as never)) {
      events.push(v as never);
    }
  }
  if (events.length === 0) events.push('mention');

  let maxConcurrentSessions: number | null = null;
  const mcs = body.max_concurrent_sessions ?? (body as any).maxConcurrentSessions;
  if (mcs !== undefined && mcs !== null) {
    const n = Number(mcs);
    if (!Number.isInteger(n) || n < 1) return { error: 'max_concurrent_sessions must be a positive integer' };
    maxConcurrentSessions = n;
  }

  const slashCommandsRaw = Array.isArray(body.slash_commands) ? body.slash_commands : [];
  const slashCommands: ChannelSpec['slashCommands'] = [];
  for (const cmd of slashCommandsRaw) {
    if (!cmd || typeof cmd !== 'object') continue;
    const c = cmd as Record<string, unknown>;
    const cmdName = normalizeString(c.name)?.replace(/^\//, '');
    const cmdPrompt = normalizeString(c.prompt ?? (c as any).prompt_template);
    if (!cmdName || !cmdPrompt) continue;
    slashCommands.push({ name: cmdName, promptTemplate: cmdPrompt });
  }

  return {
    slug,
    path: `${MANIFEST_FILENAME}#channels.${slug}`,
    name,
    platform: 'slack',
    enabled,
    channelId: channelId ?? null,
    channelName: channelName ?? null,
    agent,
    promptPrefix: prompt,
    events,
    responseStyle,
    maxConcurrentSessions,
    slashCommands,
  };
}

async function loadChannelsForResponse(project: ProjectRow) {
  const { specs, errors } = await loadProjectChannels(project);
  return { specs, errors };
}

// GET /v1/projects/:projectId/channels
projectsApp.get('/:projectId/channels', async (c) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  return c.json(await loadChannelsForResponse(loaded.row));
});

// POST /v1/projects/:projectId/channels
projectsApp.post('/:projectId/channels', async (c) => {
  const projectId = c.req.param('projectId');
  const body = await readBody(c);
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const draft = parseChannelDraft(body, { existingSlug: null });
  if ('error' in draft) return c.json({ error: draft.error }, 400);

  let manifest: ParsedManifest;
  try {
    manifest = await loadManifestForEdit(loaded.row);
  } catch (err) {
    return c.json({ error: (err as Error).message || 'Failed to read manifest' }, 400);
  }
  if (extractChannels(manifest).specs.some((s) => s.slug === draft.slug)) {
    return c.json({
      error: `A channel with slug "${draft.slug}" already exists.`,
    }, 409);
  }

  const next = upsertChannelInManifest(manifest, draft);
  const result = await commitManifest(loaded.row, next, `chore: add channel ${draft.slug}`);
  if ('error' in result) return c.json({ error: result.error }, result.status as 400 | 502);

  await syncProjectChannelBindings(loaded.row).catch((err) =>
    console.warn('[channels] sync after POST failed', err),
  );
  return c.json(await loadChannelsForResponse(loaded.row), 201);
});

// PATCH /v1/projects/:projectId/channels/:slug
projectsApp.patch('/:projectId/channels/:slug', async (c) => {
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
  const current = extractChannels(manifest).specs.find((s) => s.slug === slug);
  if (!current) return c.json({ error: 'Not found' }, 404);

  const merged = {
    name: current.name,
    platform: current.platform,
    enabled: current.enabled,
    agent: current.agent,
    events: current.events,
    response: current.responseStyle,
    prompt_prefix: current.promptPrefix,
    channel_id: current.channelId,
    channel_name: current.channelName,
    max_concurrent_sessions: current.maxConcurrentSessions,
    slash_commands: current.slashCommands.map((c) => ({ name: c.name, prompt: c.promptTemplate })),
    ...body,
    slug,
  };
  const draft = parseChannelDraft(merged, { existingSlug: slug });
  if ('error' in draft) return c.json({ error: draft.error }, 400);

  const next = upsertChannelInManifest(manifest, draft);
  const result = await commitManifest(loaded.row, next, `chore: update channel ${slug}`);
  if ('error' in result) return c.json({ error: result.error }, result.status as 400 | 502);

  await syncProjectChannelBindings(loaded.row).catch((err) =>
    console.warn('[channels] sync after PATCH failed', err),
  );
  return c.json(await loadChannelsForResponse(loaded.row));
});

// DELETE /v1/projects/:projectId/channels/:slug
projectsApp.delete('/:projectId/channels/:slug', async (c) => {
  const projectId = c.req.param('projectId');
  const slug = c.req.param('slug');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  if (!CHANNEL_SLUG_RE.test(slug)) return c.json({ error: 'Invalid slug' }, 400);

  let manifest: ParsedManifest;
  try {
    manifest = await loadManifestForEdit(loaded.row);
  } catch (err) {
    return c.json({ error: (err as Error).message || 'Failed to read manifest' }, 400);
  }
  if (!extractChannels(manifest).specs.some((s) => s.slug === slug)) {
    return c.json({ error: 'Not found' }, 404);
  }

  const next = removeChannelFromManifest(manifest, slug);
  const result = await commitManifest(loaded.row, next, `chore: delete channel ${slug}`);
  if ('error' in result) return c.json({ error: result.error }, result.status as 400 | 502);

  await syncProjectChannelBindings(loaded.row).catch((err) =>
    console.warn('[channels] sync after DELETE failed', err),
  );
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

// DELETE /v1/projects/:projectId/channels/slack
projectsApp.delete('/:projectId/channels/slack', async (c) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await deleteSlackInstall(projectId);
  return c.json({ status: 'disconnected' });
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

  const { specs } = await loadProjectTriggers(loaded.row);
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
// EXPERIMENTAL. The entire surface is gated behind
// `KORTIX_APPS_EXPERIMENTAL`. When off (the default), every /apps route
// returns 404 and the sweep skips every project. This middleware short-
// circuits before any of the handlers below run.

projectsApp.use('/:projectId/apps/*', async (c, next) => {
  if (!config.KORTIX_APPS_EXPERIMENTAL) {
    return c.json({
      error: 'kortix [[apps]] is experimental and disabled. Start the API with KORTIX_APPS_EXPERIMENTAL=true to enable.',
    }, 404);
  }
  await next();
});
projectsApp.use('/:projectId/apps', async (c, next) => {
  if (!config.KORTIX_APPS_EXPERIMENTAL) {
    return c.json({
      error: 'kortix [[apps]] is experimental and disabled. Start the API with KORTIX_APPS_EXPERIMENTAL=true to enable.',
    }, 404);
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

  const domainsRaw = (body as any).domains;
  if (!Array.isArray(domainsRaw) || domainsRaw.length === 0) {
    return { error: 'domains must be a non-empty array of strings' };
  }
  const domains: string[] = [];
  for (const d of domainsRaw) {
    const s = normalizeString(d);
    if (!s) return { error: 'domains entries must be non-empty strings' };
    domains.push(s);
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
  const { specs, errors } = await loadProjectApps(project);
  const apps = await Promise.all(
    specs.map(async (spec) => {
      const latest = await getLatestDeployment(projectId, spec.slug);
      const desiredHash = manifestHashForApp(spec);
      const currentHash = (latest?.metadata as Record<string, unknown> | null)?.manifest_hash;
      return {
        ...specToAppBody(spec),
        path: spec.path,
        manifest_hash: desiredHash,
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

  const { specs } = await loadProjectApps(loaded.row);
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

  let files: Awaited<ReturnType<typeof listRepoFiles>> = [];
  try {
    files = await listRepoFiles(loaded.row, loaded.row.defaultBranch);
  } catch (error) {
    console.warn('[projects] repo detail listing unavailable', {
      projectId,
      error: error instanceof Error ? error.message : String(error),
    });
    c.header('X-Kortix-Repo-Status', 'unavailable');
  }
  const config = await loadProjectConfig(loaded.row, files);
  return c.json({
    project: serializeProject(loaded.row, {
      projectRole: loaded.projectRole,
      effectiveRole: loaded.effectiveRole,
    }),
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

  let files: Awaited<ReturnType<typeof listRepoFiles>> = [];
  try {
    files = await listRepoFiles(loaded.row, c.req.query('ref') || loaded.row.defaultBranch, c.req.query('path'));
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
    const stream = await archiveRepoSubtree(loaded.row, ref, path);
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
projectsApp.get('/:projectId/files/content', async (c) => {
  const projectId = c.req.param('projectId');
  const path = normalizeString(c.req.query('path'));
  if (!path) return c.json({ error: 'path query param is required' }, 400);
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const ref = c.req.query('ref') || loaded.row.defaultBranch;
  const content = await readRepoFile(loaded.row, path, ref);
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
    const result = await getFileHistory(loaded.row, path, { ref, limit, skip });
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
    const branches = await listBranches(loaded.row);
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
    const result = await listCommits(loaded.row, { ref, path, limit, skip });
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
    const commit = await getCommit(loaded.row, sha);
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
    const diff = await getCommitDiff(loaded.row, sha, { path });
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
    const diff = await getBranchDiff(
      {
        projectId: loaded.row.projectId,
        repoUrl: loaded.row.repoUrl,
        defaultBranch: loaded.row.defaultBranch,
        manifestPath: loaded.row.manifestPath,
      },
      intoRef,
      fromRef,
    );
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

// DELETE /v1/projects/:projectId
projectsApp.delete('/:projectId', async (c) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

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

  const [accountRows, grantRows] = await Promise.all([
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
      })
      .from(projectMembers)
      .where(eq(projectMembers.projectId, loaded.row.projectId)),
  ]);

  const emails = await lookupEmailsByUserIds(accountRows.map((r) => r.userId));
  const grantsByUser = new Map(grantRows.map((r) => [r.userId, r]));
  const rank: Record<AccountRole, number> = { owner: 0, admin: 1, member: 2 };

  const members = accountRows
    .map((member) => {
      const accountRole = member.accountRole as AccountRole;
      const grant = grantsByUser.get(member.userId);
      const projectRole = (grant?.projectRole as ProjectRole | undefined) ?? null;
      const effectiveRole = effectiveProjectRole(accountRole, projectRole);
      return {
        user_id: member.userId,
        email: emails.get(member.userId) ?? null,
        account_role: accountRole,
        project_role: projectRole,
        effective_project_role: effectiveRole,
        has_implicit_access: isAccountManager(accountRole),
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
projectsApp.put('/:projectId/access/:userId', async (c) => {
  const projectId = c.req.param('projectId');
  const targetUserId = c.req.param('userId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const body = await readBody(c);
  const role = parseProjectRole(body.role);
  if (!role) return c.json({ error: 'role must be one of manager|editor|viewer' }, 400);

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
  return c.json(serializeSession(result.row!), 201);
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

  return c.json(rows.map(serializeSession));
});

// GET /v1/projects/:projectId/sessions/:sessionId
projectsApp.get('/:projectId/sessions/:sessionId', async (c) => {
  const projectId = c.req.param('projectId');
  const sessionId = c.req.param('sessionId');
  if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const [row] = await db
    .select()
    .from(projectSessions)
    .where(and(
      eq(projectSessions.sessionId, sessionId),
      eq(projectSessions.projectId, projectId),
      eq(projectSessions.accountId, loaded.row.accountId),
    ))
    .limit(1);

  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json(serializeSession(row));
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

  const allowedFields = ['name', 'opencode_session_id', 'opencodeSessionId', 'metadata'];
  const unknownField = Object.keys(body).find((field) => !allowedFields.includes(field));
  if (unknownField) {
    return c.json({ error: `field is not user-editable: ${unknownField}` }, 400);
  }

  const [existing] = await db
    .select()
    .from(projectSessions)
    .where(and(
      eq(projectSessions.sessionId, sessionId),
      eq(projectSessions.projectId, projectId),
      eq(projectSessions.accountId, loaded.row.accountId),
    ))
    .limit(1);

  if (!existing) return c.json({ error: 'Not found' }, 404);

  const updates: Partial<typeof projectSessions.$inferInsert> = { updatedAt: new Date() };

  const opencodeSessionId = normalizeString(body.opencode_session_id ?? body.opencodeSessionId);
  if (opencodeSessionId) updates.opencodeSessionId = opencodeSessionId;

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
  return c.json(serializeSession(row));
});

// POST /v1/projects/sync-opencode-titles
// Mirrors session titles from the sandbox-local opencode DB into our cloud DB
// (project_sessions.metadata.name). Opencode is the source of truth for the
// title; the frontend pipes opencode's session.list response and SSE
// session.updated events through this endpoint so the name is available even
// when the sandbox isn't running. Rename direction (UI -> opencode) goes via
// the SDK's session.update and lands back here through the same SSE pipe.
projectsApp.post('/sync-opencode-titles', async (c) => {
  const userId = c.get('userId') as string;
  const body = await readBody(c);
  const rawEntries = body.entries;
  if (!Array.isArray(rawEntries)) {
    return c.json({ error: 'entries must be an array' }, 400);
  }

  const desiredByOcId = new Map<string, string | null>();
  for (const raw of rawEntries) {
    if (!isPlainObject(raw)) continue;
    const opencodeSessionId = normalizeString(
      raw.opencode_session_id ?? raw.opencodeSessionId,
    );
    if (!opencodeSessionId) continue;
    const title = normalizeString(raw.title);
    desiredByOcId.set(opencodeSessionId, title);
  }
  if (desiredByOcId.size === 0) return c.json({ updated: 0 });

  const ids = Array.from(desiredByOcId.keys());
  const rows = await db
    .select()
    .from(projectSessions)
    .where(inArray(projectSessions.opencodeSessionId, ids));
  if (rows.length === 0) return c.json({ updated: 0 });

  const accountIds = Array.from(new Set(rows.map((r) => r.accountId)));
  const memberships = await db
    .select({ accountId: accountMembers.accountId })
    .from(accountMembers)
    .where(and(
      eq(accountMembers.userId, userId),
      inArray(accountMembers.accountId, accountIds),
    ));
  const allowedAccounts = new Set(memberships.map((m) => m.accountId));

  let updated = 0;
  for (const row of rows) {
    if (!allowedAccounts.has(row.accountId)) continue;
    const ocId = row.opencodeSessionId;
    if (!ocId) continue;
    const desired = desiredByOcId.get(ocId) ?? null;
    const current = typeof row.metadata?.name === 'string' ? row.metadata.name : null;
    if (desired === current) continue;
    const nextMetadata: Record<string, unknown> = { ...(row.metadata ?? {}) };
    if (desired) nextMetadata.name = desired;
    else delete nextMetadata.name;
    await db
      .update(projectSessions)
      .set({ metadata: nextMetadata, updatedAt: new Date() })
      .where(eq(projectSessions.sessionId, row.sessionId));
    updated += 1;
  }
  return c.json({ updated });
});

// GET /v1/projects/:projectId/sessions/:sessionId/sandbox
// Returns the session's sandbox runtime row from `kortix.session_sandboxes`.
// Decoupled from the legacy /instances sandbox table: no billing fields, no
// team-membership coupling. Returns 404 while the row is being inserted —
// the frontend polls.
projectsApp.get('/:projectId/sessions/:sessionId/sandbox', async (c) => {
  const projectId = c.req.param('projectId');
  const sessionId = c.req.param('sessionId');
  if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const [row] = await db
    .select()
    .from(sessionSandboxes)
    .where(and(
      eq(sessionSandboxes.sessionId, sessionId),
      eq(sessionSandboxes.projectId, projectId),
      eq(sessionSandboxes.accountId, loaded.row.accountId),
    ))
    .limit(1);

  if (!row) return c.json({ error: 'Not found' }, 404);

  return c.json({
    sandbox_id: row.sandboxId,
    session_id: row.sessionId,
    project_id: row.projectId,
    account_id: row.accountId,
    provider: row.provider,
    external_id: row.externalId,
    base_url: row.baseUrl,
    status: row.status,
    config: row.config ?? {},
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
  return c.json({ ok: true });
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

  const [session] = await db
    .select()
    .from(projectSessions)
    .where(and(
      eq(projectSessions.sessionId, sessionId),
      eq(projectSessions.projectId, projectId),
      eq(projectSessions.accountId, loaded.row.accountId),
    ))
    .limit(1);
  if (!session) return c.json({ error: 'Not found' }, 404);

  const providerName = session.sandboxProvider as SandboxProviderName;
  if (!(config.ALLOWED_SANDBOX_PROVIDERS as readonly string[]).includes(providerName)) {
    return c.json({ error: `Restart is not supported for provider ${providerName}` }, 400);
  }

  // Resolve git auth fresh — installation tokens rotate.
  let gitAuth: Awaited<ReturnType<typeof resolveGitHubRepoAuth>>;
  try {
    gitAuth = await resolveGitHubRepoAuth(loaded.row.accountId);
  } catch (error) {
    if (error instanceof GitHubInstallationRequiredError) {
      return c.json({
        error: error.message,
        install_url: buildGitHubAppInstallUrl(error.accountId),
      }, 409);
    }
    return c.json({ error: (error as Error).message || 'GitHub is not configured' }, 503);
  }

  const initialPrompt = typeof session.metadata?.initial_prompt === 'string'
    ? session.metadata.initial_prompt as string
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
        githubToken: gitAuth.auth?.token ?? null,
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
// backend (GitHub, GitLab, Freestyle, plain git) — so the merge UI lives in
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
    [baseSha, headSha] = await Promise.all([
      resolveBranchTip(
        {
          projectId: loaded.row.projectId,
          repoUrl: loaded.row.repoUrl,
          defaultBranch: loaded.row.defaultBranch,
          manifestPath: loaded.row.manifestPath,
        },
        baseRef,
      ),
      resolveBranchTip(
        {
          projectId: loaded.row.projectId,
          repoUrl: loaded.row.repoUrl,
          defaultBranch: loaded.row.defaultBranch,
          manifestPath: loaded.row.manifestPath,
        },
        headRef,
      ),
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
    project: {
      projectId: loaded.row.projectId,
      repoUrl: loaded.row.repoUrl,
      defaultBranch: loaded.row.defaultBranch,
      manifestPath: loaded.row.manifestPath,
    },
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

  const projectForGit = {
    projectId: loaded.row.projectId,
    repoUrl: loaded.row.repoUrl,
    defaultBranch: loaded.row.defaultBranch,
    manifestPath: loaded.row.manifestPath,
  };

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
    const preview = await previewMerge(
      {
        projectId: loaded.row.projectId,
        repoUrl: loaded.row.repoUrl,
        defaultBranch: loaded.row.defaultBranch,
        manifestPath: loaded.row.manifestPath,
      },
      cr.baseRef,
      cr.headRef,
    );
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
  const projectForGit = {
    projectId: loaded.row.projectId,
    repoUrl: loaded.row.repoUrl,
    defaultBranch: loaded.row.defaultBranch,
    manifestPath: loaded.row.manifestPath,
  };

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

