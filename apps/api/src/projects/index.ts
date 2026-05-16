/**
 * Project CRUD.
 *
 * Project is the new first-class source-of-truth object: one account-owned Git
 * repo plus the Kortix metadata needed to render and launch sessions later.
 * The old sandbox/instance tables remain as legacy compute state.
 */

import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Cron } from 'croner';
import { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  accountGithubInstallations,
  accountMembers,
  projects,
  projectMembers,
  projectConnectors,
  projectChannelEvents,
  projectChannels,
  projectSecrets,
  projectTriggerEvents,
  projectTriggers,
  projectSessions,
  sessionSandboxes,
} from '@kortix/db';
import type { AppEnv } from '../types';
import { db } from '../shared/db';
import { resolveAccountId } from '../shared/resolve-account';
import { supabaseAuth } from '../middleware/auth';
import { getSupabase } from '../shared/supabase';
import {
  createRemoteSessionBranch,
  getCommit,
  getCommitDiff,
  getFileHistory,
  listBranches,
  listCommits,
  listRepoFiles,
  loadProjectConfig,
  readRepoFile,
} from './git';
import {
  buildGitHubAppInstallUrl,
  commitFile,
  createInstallationToken,
  createRepo,
  getFileSha,
  getGitHubAppInstallation,
  isGithubAppConfigured,
  isGithubPatConfigured,
  type GitHubAuthContext,
} from './github';
import { buildStarterFiles } from './starter';
import { provisionSessionSandbox } from '../platform/services/session-sandbox';
import { config } from '../config';
import { encodeSessionLlmToken } from '../shared/session-llm-token';
import { encodeSessionConnectorToken } from '../shared/session-connector-token';
import { maxConcurrentSessionsForTier, resolveAccountTier } from '../shared/account-limits';
import { recordAuditEvent } from '../shared/audit';
import { getProviderFromRequest } from '../integrations/providers';
import {
  encryptProjectSecret,
  isValidSecretName,
  listProjectSecrets,
} from './secrets';
import {
  listProjectConnectors,
  parseProjectConnectorStatus,
  serializeProjectConnector,
  upsertProjectConnector,
} from './connectors';
import {
  effectiveProjectRole,
  isAccountManager,
  parseProjectRole,
  roleAllows,
  type AccountRole,
  type ProjectAccessAction,
  type ProjectRole,
} from './access';

export const projectsApp = new Hono<AppEnv>();
export const projectWebhooksApp = new Hono<AppEnv>();
export const projectChannelsApp = new Hono<AppEnv>();
export const projectConnectorOAuthApp = new Hono<AppEnv>();

projectsApp.use('/*', supabaseAuth);

type ProjectRow = typeof projects.$inferSelect;
type ProjectSessionRow = typeof projectSessions.$inferSelect;
type ProjectChannelRow = typeof projectChannels.$inferSelect;
type ProjectChannelEventRow = typeof projectChannelEvents.$inferSelect;
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

function serializeProjectChannel(row: ProjectChannelRow) {
  const publicConfig = { ...normalizeJsonObject(row.config) };
  const hasSecret = Boolean(
    publicConfig.secret ||
    publicConfig.signing_secret ||
    publicConfig.signingSecret ||
    publicConfig.webhook_secret ||
    publicConfig.webhookSecret,
  );
  delete publicConfig.secret;
  delete publicConfig.signing_secret;
  delete publicConfig.signingSecret;
  delete publicConfig.webhook_secret;
  delete publicConfig.webhookSecret;
  if (hasSecret) publicConfig.has_secret = true;

  return {
    channel_id: row.channelId,
    account_id: row.accountId,
    project_id: row.projectId,
    platform: row.platform,
    external_channel_id: row.externalChannelId,
    external_team_id: row.externalTeamId,
    name: row.name,
    config: publicConfig,
    agent_name: row.agentName,
    prompt_template: row.promptTemplate,
    enabled: row.enabled,
    status: row.status,
    created_by: row.createdBy,
    metadata: row.metadata ?? {},
    last_message_at: row.lastMessageAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function serializeProjectChannelEvent(row: ProjectChannelEventRow) {
  return {
    event_id: row.eventId,
    channel_id: row.channelId,
    account_id: row.accountId,
    project_id: row.projectId,
    platform: row.platform,
    external_message_id: row.externalMessageId,
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
  return {
    account_id: accountId,
    installed,
    configured: isGithubAppConfigured(),
    requires_installation: isGithubAppConfigured() && !installed,
    pat_fallback_available: !isGithubAppConfigured() && isGithubPatConfigured(),
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

function parseProjectChannelPlatform(value: unknown): 'slack' | 'telegram' | 'msteams' | 'discord' | null {
  const platform = normalizeString(value);
  if (platform === 'slack' || platform === 'telegram' || platform === 'msteams' || platform === 'discord') {
    return platform;
  }
  return null;
}

function parseIntegrationStatus(value: unknown): 'active' | 'revoked' | 'expired' | 'error' | null {
  if (value === 'active' || value === 'revoked' || value === 'expired' || value === 'error') {
    return value;
  }
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

export function buildProjectConnectorBaseUrl(kortixUrl: string): string {
  const base = kortixUrl.replace(/\/+$/, '');
  if (base.endsWith('/v1/router')) return `${base}/connectors`;
  if (base.endsWith('/v1')) return `${base}/router/connectors`;
  return `${base}/v1/router/connectors`;
}

type DirectOAuthSurface = 'connector' | 'channel';
type DirectOAuthState = {
  v: 1;
  surface: DirectOAuthSurface;
  account_id: string;
  project_id: string;
  user_id: string;
  app: string;
  scopes: string[];
  success_redirect_uri: string;
  error_redirect_uri: string;
  exp: number;
  nonce: string;
};
type DirectOAuthAppConfig = {
  provider: string;
  appName: string | null;
  authorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  authorizationParams: Record<string, string>;
  tokenAuth: 'body' | 'basic';
  tokenRequestContentType: 'form' | 'json';
  accountIdPath: string | null;
  accountNamePath: string | null;
  userInfoUrl: string | null;
  userInfoAccountIdPath: string | null;
  userInfoAccountNamePath: string | null;
};

function publicApiBaseUrl() {
  const raw = (config.KORTIX_URL || `http://localhost:${config.PORT}`).replace(/\/+$/, '');
  if (raw.endsWith('/v1/router')) return raw.slice(0, -'/v1/router'.length);
  if (raw.endsWith('/v1')) return raw.slice(0, -'/v1'.length);
  return raw;
}

function directOAuthCallbackUrl() {
  return `${publicApiBaseUrl()}/v1/connectors/oauth/callback`;
}

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.trim());
  }
  if (typeof value === 'string') {
    return value.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function normalizeStringMap(value: unknown): Record<string, string> {
  const object = normalizeJsonObject(value);
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(object)) {
    if (typeof item === 'string') out[key] = item;
    else if (typeof item === 'number' || typeof item === 'boolean') out[key] = String(item);
  }
  return out;
}

function directOAuthConfiguredApps(): Record<string, unknown> {
  const raw = normalizeString(process.env.KORTIX_DIRECT_OAUTH_APPS ?? (config as any).KORTIX_DIRECT_OAUTH_APPS);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return normalizeJsonObject(parsed);
  } catch {
    return {};
  }
}

function resolveDirectOAuthSecret(value: Record<string, unknown>, key: string): string | null {
  const literal = normalizeString(value[key]);
  if (literal) return literal;
  const envName = normalizeString(value[`${key}_env`]);
  return envName ? normalizeString(process.env[envName]) : null;
}

function getDirectOAuthAppConfig(app: string): DirectOAuthAppConfig | null {
  const rawConfig = directOAuthConfiguredApps()[app];
  const object = normalizeJsonObject(rawConfig);
  const authorizationUrl = normalizeString(object.authorization_url ?? object.authorizationUrl);
  const tokenUrl = normalizeString(object.token_url ?? object.tokenUrl);
  const clientId = resolveDirectOAuthSecret(object, 'client_id');
  const clientSecret = resolveDirectOAuthSecret(object, 'client_secret');
  if (!authorizationUrl || !tokenUrl || !clientId || !clientSecret) return null;

  const tokenAuth = normalizeString(object.token_auth ?? object.tokenAuth);
  const tokenRequestContentType = normalizeString(object.token_request_content_type ?? object.tokenRequestContentType);
  return {
    provider: normalizeString(object.provider) ?? app,
    appName: normalizeString(object.app_name ?? object.appName),
    authorizationUrl,
    tokenUrl,
    clientId,
    clientSecret,
    scopes: normalizeStringArray(object.scopes ?? object.scope),
    authorizationParams: normalizeStringMap(object.authorization_params ?? object.authorizationParams),
    tokenAuth: tokenAuth === 'basic' ? 'basic' : 'body',
    tokenRequestContentType: tokenRequestContentType === 'json' ? 'json' : 'form',
    accountIdPath: normalizeString(object.account_id_path ?? object.accountIdPath),
    accountNamePath: normalizeString(object.account_name_path ?? object.accountNamePath),
    userInfoUrl: normalizeString(object.user_info_url ?? object.userInfoUrl),
    userInfoAccountIdPath: normalizeString(object.user_info_account_id_path ?? object.userInfoAccountIdPath),
    userInfoAccountNamePath: normalizeString(object.user_info_account_name_path ?? object.userInfoAccountNamePath),
  };
}

function encodeDirectOAuthState(state: DirectOAuthState): string {
  const payload = Buffer.from(JSON.stringify(state)).toString('base64url');
  const sig = createHmac('sha256', config.API_KEY_SECRET).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

function decodeDirectOAuthState(token: string | null): DirectOAuthState | null {
  if (!token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig || !/^[a-f0-9]{64}$/i.test(sig)) return null;
  const expected = createHmac('sha256', config.API_KEY_SECRET).update(payload).digest('hex');
  const actualBuffer = Buffer.from(sig, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) return null;

  try {
    const state = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as DirectOAuthState;
    if (state.v !== 1) return null;
    if (state.surface !== 'connector' && state.surface !== 'channel') return null;
    if (!UUID_V4_REGEX.test(state.project_id) || !UUID_V4_REGEX.test(state.account_id) || !UUID_V4_REGEX.test(state.user_id)) return null;
    if (!normalizeString(state.app) || !Array.isArray(state.scopes)) return null;
    if (Date.now() > state.exp) return null;
    return state;
  } catch {
    return null;
  }
}

function readPath(value: unknown, path: string | null): unknown {
  if (!path) return undefined;
  let current: unknown = value;
  for (const part of path.split('.')) {
    if (!isPlainObject(current)) return undefined;
    current = current[part];
  }
  return current;
}

function readFirstString(value: unknown, paths: Array<string | null>): string | null {
  for (const path of paths) {
    const item = readPath(value, path);
    const normalized = normalizeString(item);
    if (normalized) return normalized;
  }
  return null;
}

async function exchangeDirectOAuthCode(input: {
  cfg: DirectOAuthAppConfig;
  code: string;
  redirectUri: string;
}) {
  const headers: Record<string, string> = {};
  let body: BodyInit;

  if (input.cfg.tokenRequestContentType === 'json') {
    headers['content-type'] = 'application/json';
    const payload: Record<string, string> = {
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: input.cfg.clientId,
    };
    if (input.cfg.tokenAuth === 'body') payload.client_secret = input.cfg.clientSecret;
    body = JSON.stringify(payload);
  } else {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: input.cfg.clientId,
    });
    if (input.cfg.tokenAuth === 'body') form.set('client_secret', input.cfg.clientSecret);
    body = form;
  }

  if (input.cfg.tokenAuth === 'basic') {
    headers.authorization = `Basic ${Buffer.from(`${input.cfg.clientId}:${input.cfg.clientSecret}`).toString('base64')}`;
  }

  const response = await fetch(input.cfg.tokenUrl, { method: 'POST', headers, body });
  const text = await response.text();
  let payload: Record<string, unknown>;
  try {
    payload = normalizeJsonObject(JSON.parse(text));
  } catch {
    payload = { raw: text };
  }

  if (!response.ok || payload.error) {
    const description = normalizeString(payload.error_description ?? payload.error) ?? `OAuth token exchange failed with HTTP ${response.status}`;
    throw new Error(description);
  }
  return payload;
}

async function fetchDirectOAuthUserInfo(cfg: DirectOAuthAppConfig, tokenPayload: Record<string, unknown>) {
  if (!cfg.userInfoUrl) return null;
  const accessToken = normalizeString(tokenPayload.access_token);
  if (!accessToken) return null;
  const response = await fetch(cfg.userInfoUrl, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json',
    },
  });
  const text = await response.text();
  try {
    return normalizeJsonObject(JSON.parse(text));
  } catch {
    return { raw: text };
  }
}

function directOAuthRedirect(baseUri: string, params: Record<string, string | null | undefined>) {
  const url = new URL(baseUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

function allowedRelayOrigins() {
  return normalizeStringArray(process.env.KORTIX_OAUTH_RELAY_ALLOWED_ORIGINS ?? (config as any).KORTIX_OAUTH_RELAY_ALLOWED_ORIGINS)
    .map((origin) => origin.replace(/\/+$/, ''));
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

  if (isGithubAppConfigured()) {
    throw new GitHubInstallationRequiredError(accountId);
  }

  if (isGithubPatConfigured()) {
    return { authSource: 'pat' };
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

async function startDirectOAuthForProject(c: Context, surface: DirectOAuthSurface) {
  const projectId = c.req.param('projectId');
  const body = await readBody(c);
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  if (!isAccountManager(loaded.accountRole)) {
    return c.json({ error: 'Owner or admin role required' }, 403);
  }

  const app = normalizeString(body.app ?? body.platform);
  if (!app) return c.json({ error: 'app is required' }, 400);

  const cfg = getDirectOAuthAppConfig(app);
  if (!cfg) {
    return c.json({
      error: 'Direct OAuth app is not configured',
      app,
    }, 400);
  }

  const scopes = normalizeStringArray(body.scopes ?? body.scope);
  const requestedScopes = scopes.length > 0 ? scopes : cfg.scopes;
  const successRedirectUri = normalizeString(body.success_redirect_uri ?? body.successRedirectUri)
    ?? `${config.FRONTEND_URL}/projects/${projectId}/settings?section=${surface === 'channel' ? 'channels' : 'connectors'}&connected=true`;
  const errorRedirectUri = normalizeString(body.error_redirect_uri ?? body.errorRedirectUri)
    ?? `${config.FRONTEND_URL}/projects/${projectId}/settings?section=${surface === 'channel' ? 'channels' : 'connectors'}&connected=false`;
  const expiresAt = Date.now() + 10 * 60 * 1000;
  const state = encodeDirectOAuthState({
    v: 1,
    surface,
    account_id: loaded.row.accountId,
    project_id: projectId,
    user_id: loaded.userId,
    app,
    scopes: requestedScopes,
    success_redirect_uri: successRedirectUri,
    error_redirect_uri: errorRedirectUri,
    exp: expiresAt,
    nonce: randomUUID(),
  });

  const redirectUri = directOAuthCallbackUrl();
  const authorizationUrl = new URL(cfg.authorizationUrl);
  authorizationUrl.searchParams.set('response_type', 'code');
  authorizationUrl.searchParams.set('client_id', cfg.clientId);
  authorizationUrl.searchParams.set('redirect_uri', redirectUri);
  authorizationUrl.searchParams.set('state', state);
  if (requestedScopes.length > 0) authorizationUrl.searchParams.set('scope', requestedScopes.join(' '));
  for (const [key, value] of Object.entries(cfg.authorizationParams)) {
    if (!authorizationUrl.searchParams.has(key)) authorizationUrl.searchParams.set(key, value);
  }

  return c.json({
    provider: cfg.provider,
    app,
    surface,
    authorization_url: authorizationUrl.toString(),
    redirect_uri: redirectUri,
    expires_at: new Date(expiresAt).toISOString(),
  });
}

async function completeDirectOAuth(input: {
  state: DirectOAuthState;
  code: string;
}) {
  const cfg = getDirectOAuthAppConfig(input.state.app);
  if (!cfg) throw new Error('Direct OAuth app is not configured');

  const tokenPayload = await exchangeDirectOAuthCode({
    cfg,
    code: input.code,
    redirectUri: directOAuthCallbackUrl(),
  });
  const userInfo = await fetchDirectOAuthUserInfo(cfg, tokenPayload);
  const providerAccountId = readFirstString(tokenPayload, [
    cfg.accountIdPath,
    'account_id',
    'team.id',
    'workspace.id',
    'authed_user.id',
    'user.id',
    'id',
  ]) ?? readFirstString(userInfo, [
    cfg.userInfoAccountIdPath,
    'account_id',
    'team.id',
    'workspace.id',
    'user.id',
    'id',
  ]) ?? `${input.state.app}:${createHash('sha256').update(JSON.stringify(tokenPayload)).digest('hex').slice(0, 16)}`;

  const accountName = readFirstString(tokenPayload, [
    cfg.accountNamePath,
    'account_name',
    'team.name',
    'workspace.name',
    'user.name',
    'name',
  ]) ?? readFirstString(userInfo, [
    cfg.userInfoAccountNamePath,
    'account_name',
    'team.name',
    'workspace.name',
    'user.name',
    'name',
  ]);

  const tokenType = normalizeString(tokenPayload.token_type);
  const expiresIn = typeof tokenPayload.expires_in === 'number'
    ? tokenPayload.expires_in
    : Number(normalizeString(tokenPayload.expires_in));
  const expiresAt = Number.isFinite(expiresIn)
    ? new Date(Date.now() + expiresIn * 1000).toISOString()
    : null;

  const connector = await upsertProjectConnector({
    accountId: input.state.account_id,
    projectId: input.state.project_id,
    providerName: cfg.provider,
    app: input.state.app,
    appName: cfg.appName,
    providerAccountId,
    label: accountName,
    scopes: input.state.scopes,
    metadata: {
      direct_oauth: true,
      surface: input.state.surface,
      provider_account_name: accountName,
      token_type: tokenType,
      expires_at: expiresAt,
      user_info_present: Boolean(userInfo),
    },
    createdBy: input.state.user_id,
  });

  return {
    connector,
    provider: cfg.provider,
    app: input.state.app,
    providerAccountId,
  };
}

async function createProjectSession(input: {
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
  let providerName: 'daytona' | 'local_docker' = config.getDefaultProvider();
  if (requestedProvider) {
    if (requestedProvider === 'daytona' || requestedProvider === 'local_docker') {
      if (!config.ALLOWED_SANDBOX_PROVIDERS.includes(requestedProvider)) {
        return { error: { status: 400, body: { error: `Sandbox provider not enabled: ${requestedProvider}` } } };
      }
      providerName = requestedProvider;
    } else {
      return { error: { status: 400, body: { error: `Unknown sandbox provider: ${requestedProvider}` } } };
    }
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
      const runtimeSecrets = await listProjectSecrets(projectId);
      const llmBaseUrl = buildProjectLlmBaseUrl(config.KORTIX_URL);
      const llmToken = encodeSessionLlmToken({
        accountId,
        projectId,
        sessionId,
        userId,
      });
      const connectorBaseUrl = buildProjectConnectorBaseUrl(config.KORTIX_URL);
      const connectorToken = encodeSessionConnectorToken({
        accountId,
        projectId,
        sessionId,
        userId,
      });
      // Env vars consumed by the Daytona/local sandbox entrypoint.
      const githubToken = gitAuth.auth?.token || process.env.KORTIX_GITHUB_TOKEN || process.env.GITHUB_TOKEN || '';
      await provisionSessionSandbox({
        sandboxId: sessionId,
        accountId,
        projectId,
        userId,
        provider: providerName,
        metadata: { session_id: sessionId, project_id: projectId, ...(input.metadata ?? {}) },
        extraEnvVars: {
          ...runtimeSecrets,
          KORTIX_PROJECT_AUTO_CLONE: '1',
          KORTIX_REPO_URL: project.repoUrl,
          KORTIX_DEFAULT_BRANCH: baseRef,
          KORTIX_BASE_REF: baseRef,
          KORTIX_BRANCH_NAME: sessionId,
          KORTIX_PROJECT_ID: projectId,
          KORTIX_SESSION_ID: sessionId,
          KORTIX_LLM_BASE_URL: llmBaseUrl,
          KORTIX_LLM_TOKEN: llmToken,
          KORTIX_CONNECTOR_BASE_URL: connectorBaseUrl,
          KORTIX_CONNECTOR_TOKEN: connectorToken,
          KORTIX_SERVICE_PORT: '8000',
          KORTIX_AGENT_NAME: agentName,
          ...(initialPrompt ? { KORTIX_INITIAL_PROMPT: initialPrompt } : {}),
          ...(githubToken ? { KORTIX_GITHUB_TOKEN: githubToken } : {}),
        },
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

function channelSecret(row: ProjectChannelRow): string | null {
  const cfg = normalizeJsonObject(row.config);
  return normalizeString(
    cfg.secret ??
    cfg.signing_secret ??
    cfg.signingSecret ??
    cfg.webhook_secret ??
    cfg.webhookSecret,
  );
}

function verifySlackRequestSignature(rawBody: string, secret: string, c: Context) {
  const timestamp = normalizeString(c.req.header('x-slack-request-timestamp'));
  const signature = normalizeString(c.req.header('x-slack-signature'));
  if (!timestamp || !signature?.startsWith('v0=')) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - ts) > 60 * 5) return false;

  const expected = createHmac('sha256', secret)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest('hex');
  const actual = signature.slice('v0='.length);
  if (!/^[a-f0-9]{64}$/i.test(actual)) return false;
  const actualBuffer = Buffer.from(actual, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

function verifyChannelSignature(channel: ProjectChannelRow, rawBody: string, c: Context) {
  const secret = channelSecret(channel);
  if (!secret) return { ok: false as const, reason: 'Channel secret is not configured' };

  if (channel.platform === 'telegram') {
    const telegramSecret = normalizeString(c.req.header('x-telegram-bot-api-secret-token'));
    if (telegramSecret && telegramSecret === secret) return { ok: true as const };
  }

  if (channel.platform === 'slack' && verifySlackRequestSignature(rawBody, secret, c)) {
    return { ok: true as const };
  }

  const signatureHeader = c.req.header('x-kortix-signature') || c.req.header('x-hub-signature-256') || null;
  if (verifyWebhookSignature(rawBody, secret, signatureHeader)) return { ok: true as const };

  return { ok: false as const, reason: 'Invalid channel signature' };
}

function channelMessageText(platform: ProjectChannelRow['platform'], body: unknown): string {
  const objectBody = normalizeJsonObject(body);
  if (platform === 'slack') {
    const event = normalizeJsonObject(objectBody.event);
    return normalizeString(event.text ?? objectBody.text) ?? '';
  }
  if (platform === 'telegram') {
    const message = isPlainObject(objectBody.message)
      ? normalizeJsonObject(objectBody.message)
      : isPlainObject(objectBody.edited_message)
        ? normalizeJsonObject(objectBody.edited_message)
        : normalizeJsonObject(objectBody.channel_post);
    return normalizeString(message.text ?? message.caption) ?? '';
  }
  const message = normalizeJsonObject(objectBody.message);
  return normalizeString(objectBody.text ?? objectBody.content ?? message.text ?? message.content) ?? '';
}

function channelExternalMessageId(platform: ProjectChannelRow['platform'], body: unknown): string | null {
  const objectBody = normalizeJsonObject(body);
  if (platform === 'slack') {
    const event = normalizeJsonObject(objectBody.event);
    return normalizeString(objectBody.event_id ?? event.client_msg_id ?? event.ts);
  }
  if (platform === 'telegram') {
    const message = isPlainObject(objectBody.message)
      ? normalizeJsonObject(objectBody.message)
      : isPlainObject(objectBody.edited_message)
        ? normalizeJsonObject(objectBody.edited_message)
        : normalizeJsonObject(objectBody.channel_post);
    const messageId = message.message_id;
    return normalizeString(objectBody.update_id) ?? (typeof messageId === 'number' ? String(messageId) : normalizeString(messageId));
  }
  return normalizeString(objectBody.id ?? objectBody.event_id ?? objectBody.message_id);
}

function channelPayload(channel: ProjectChannelRow, c: Context, rawBody: string) {
  const body = parseWebhookJsonBody(rawBody);
  const text = channelMessageText(channel.platform, body);
  return {
    platform: channel.platform,
    channel: {
      id: channel.channelId,
      external_channel_id: channel.externalChannelId,
      external_team_id: channel.externalTeamId,
      name: channel.name,
    },
    message: {
      text,
      external_message_id: channelExternalMessageId(channel.platform, body),
    },
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

async function fireProjectChannel(input: {
  channel: ProjectChannelRow;
  project: ProjectRow;
  payload: Record<string, unknown>;
  renderedPrompt: string;
  request?: RequestAuditContext;
}): Promise<{
  status: 'queued' | 'fired' | 'failed';
  reason?: string;
  error?: string;
  event: ProjectChannelEventRow;
  session?: ProjectSessionRow;
  httpStatus?: number;
  backpressure?: Awaited<ReturnType<typeof triggerBackpressureState>>;
}> {
  const { channel, project, payload, renderedPrompt } = input;
  const backpressure = await triggerBackpressureState(channel.accountId, channel.projectId);
  const externalMessageId = normalizeString(normalizeJsonObject(payload.message).external_message_id);
  const [event] = await db
    .insert(projectChannelEvents)
    .values({
      channelId: channel.channelId,
      accountId: channel.accountId,
      projectId: channel.projectId,
      platform: channel.platform,
      externalMessageId,
      status: 'queued',
      payload,
      renderedPrompt,
      updatedAt: new Date(),
    })
    .returning();

  if (backpressure.shouldQueue) {
    return {
      status: 'queued',
      reason: backpressure.provisioning >= backpressure.projectProvisioningLimit
        ? 'project provisioning backpressure'
        : 'account session cap',
      event,
      backpressure,
    };
  }

  if (!channel.createdBy) {
    const message = 'Channel has no actor to own the session';
    const [failedEvent] = await db
      .update(projectChannelEvents)
      .set({ status: 'failed', error: message, updatedAt: new Date() })
      .where(eq(projectChannelEvents.eventId, event.eventId))
      .returning();
    return {
      status: 'failed',
      error: message,
      event: failedEvent ?? event,
      httpStatus: 409,
    };
  }

  const channelConfig = normalizeJsonObject(channel.config);
  const provider = normalizeString(channelConfig.provider);
  const sessionResult = await createProjectSession({
    project,
    userId: channel.createdBy,
    enforceAccountCap: false,
    request: input.request,
    body: {
      agent_name: channel.agentName,
      initial_prompt: renderedPrompt,
      ...(provider ? { provider } : {}),
      metadata: {
        channel_id: channel.channelId,
        channel_event_id: event.eventId,
        channel_platform: channel.platform,
        external_message_id: externalMessageId,
      },
    },
    metadata: {
      channel_id: channel.channelId,
      channel_event_id: event.eventId,
      channel_platform: channel.platform,
      external_message_id: externalMessageId,
    },
  });

  if (sessionResult.error) {
    const message = String(sessionResult.error.body.error ?? 'Failed to create channel session');
    const [failedEvent] = await db
      .update(projectChannelEvents)
      .set({ status: 'failed', error: message, updatedAt: new Date() })
      .where(eq(projectChannelEvents.eventId, event.eventId))
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
    .update(projectChannelEvents)
    .set({
      status: 'fired',
      sessionId: session.sessionId,
      updatedAt: new Date(),
    })
    .where(eq(projectChannelEvents.eventId, event.eventId))
    .returning();

  await db
    .update(projectChannels)
    .set({ lastMessageAt: new Date(), updatedAt: new Date() })
    .where(eq(projectChannels.channelId, channel.channelId))
    .returning();

  return {
    status: 'fired',
    event: updatedEvent ?? event,
    session,
  };
}

// GET /v1/connectors/oauth/relay
// Cloud OAuth proxy for self-hosted deployments. It is intentionally a narrow
// redirect relay: the destination origin must be explicitly allowlisted.
projectConnectorOAuthApp.get('/relay', async (c) => {
  const target = normalizeString(c.req.query('target') ?? c.req.query('callback_uri') ?? c.req.query('redirect_uri'));
  if (!target) return c.json({ error: 'target is required' }, 400);

  let targetUrl: URL;
  try {
    targetUrl = new URL(target);
  } catch {
    return c.json({ error: 'target must be an absolute URL' }, 400);
  }

  const allowedOrigins = allowedRelayOrigins();
  if (allowedOrigins.length === 0 || !allowedOrigins.includes(targetUrl.origin)) {
    return c.json({ error: 'target origin is not allowed' }, 403);
  }

  for (const key of ['code', 'state', 'error', 'error_description', 'scope']) {
    const value = normalizeString(c.req.query(key));
    if (value) targetUrl.searchParams.set(key, value);
  }

  return c.redirect(targetUrl.toString());
});

// GET /v1/connectors/oauth/callback
// Direct provider OAuth callback. Tokens are exchanged cloud-side and stored as
// encrypted project connector secrets; raw provider tokens never enter sandboxes.
projectConnectorOAuthApp.get('/callback', async (c) => {
  const state = decodeDirectOAuthState(normalizeString(c.req.query('state')));
  if (!state) return c.json({ error: 'Invalid or expired OAuth state' }, 400);

  const providerError = normalizeString(c.req.query('error'));
  if (providerError) {
    return c.redirect(directOAuthRedirect(state.error_redirect_uri, {
      connected: 'false',
      direct_oauth: 'error',
      error: providerError,
      error_description: normalizeString(c.req.query('error_description')),
      app: state.app,
      surface: state.surface,
    }));
  }

  const code = normalizeString(c.req.query('code'));
  if (!code) {
    return c.redirect(directOAuthRedirect(state.error_redirect_uri, {
      connected: 'false',
      direct_oauth: 'error',
      error: 'missing_code',
      app: state.app,
      surface: state.surface,
    }));
  }

  try {
    const result = await completeDirectOAuth({ state, code });
    return c.redirect(directOAuthRedirect(state.success_redirect_uri, {
      connected: 'true',
      direct_oauth: 'connected',
      provider: result.provider,
      app: result.app,
      surface: state.surface,
      connector_id: result.connector.connectorId,
      provider_account_id: result.providerAccountId,
    }));
  } catch (error) {
    return c.redirect(directOAuthRedirect(state.error_redirect_uri, {
      connected: 'false',
      direct_oauth: 'error',
      error: 'token_exchange_failed',
      error_description: error instanceof Error ? error.message : String(error),
      app: state.app,
      surface: state.surface,
    }));
  }
});

// POST /v1/webhooks/:triggerId
// Public fire endpoint. Triggers stay cloud-side; the sandbox only receives
// the resulting session branch, prompt, and runtime env.
projectWebhooksApp.post('/:triggerId', async (c) => {
  const triggerId = c.req.param('triggerId');
  if (!UUID_V4_REGEX.test(triggerId)) return c.json({ error: 'Invalid trigger id' }, 400);

  const [trigger] = await db
    .select()
    .from(projectTriggers)
    .where(eq(projectTriggers.triggerId, triggerId))
    .limit(1);

  if (!trigger || trigger.type !== 'webhook' || !trigger.enabled) {
    return c.json({ error: 'Not found' }, 404);
  }

  const rawBody = await c.req.text();
  const secret = triggerWebhookSecret(trigger);
  if (!secret) return c.json({ error: 'Webhook secret is not configured' }, 409);

  const signatureHeader = c.req.header('x-kortix-signature') || c.req.header('x-hub-signature-256') || null;
  if (!verifyWebhookSignature(rawBody, secret, signatureHeader)) {
    return c.json({ error: 'Invalid webhook signature' }, 401);
  }

  const [project] = await db
    .select()
    .from(projects)
    .where(and(
      eq(projects.projectId, trigger.projectId),
      eq(projects.accountId, trigger.accountId),
      eq(projects.status, 'active'),
    ))
    .limit(1);
  if (!project) return c.json({ error: 'Project not found' }, 404);

  (c as any).set('accountId', trigger.accountId);

  const payload = webhookPayload(c, rawBody);
  const renderedPrompt = renderPromptTemplate(trigger.promptTemplate, payload);
  const result = await fireProjectTrigger({
    trigger,
    project,
    payload,
    renderedPrompt,
    request: requestAuditContext(c),
  });

  if (result.status === 'queued') {
    const backpressure = result.backpressure!;
    return c.json({
      status: 'queued',
      reason: result.reason,
      event: serializeProjectTriggerEvent(result.event),
      backpressure: {
        provisioning_sessions: backpressure.provisioning,
        project_provisioning_limit: backpressure.projectProvisioningLimit,
        active_sessions: backpressure.active,
        account_active_limit: backpressure.accountActiveLimit,
        tier: backpressure.tier ?? 'free',
      },
    }, 202);
  }

  if (result.status === 'failed') {
    return c.json({
      error: result.error ?? 'Failed to create trigger session',
      event: serializeProjectTriggerEvent(result.event),
    }, (result.httpStatus ?? 500) as any);
  }

  return c.json({
    status: 'fired',
    event: serializeProjectTriggerEvent(result.event),
    session: serializeSession(result.session!),
  }, 202);
});

// POST /v1/channels/:platform/:channelId/events
// Public chat-app event endpoint. The channel row is cloud-owned; the sandbox
// only sees the resulting project session and connector router env.
projectChannelsApp.post('/:platform/:channelId/events', async (c) => {
  const platform = parseProjectChannelPlatform(c.req.param('platform'));
  const channelId = c.req.param('channelId');
  if (!platform) return c.json({ error: 'Invalid channel platform' }, 400);
  if (!UUID_V4_REGEX.test(channelId)) return c.json({ error: 'Invalid channel id' }, 400);

  const [channel] = await db
    .select()
    .from(projectChannels)
    .where(and(
      eq(projectChannels.channelId, channelId),
      eq(projectChannels.platform, platform),
      eq(projectChannels.enabled, true),
      eq(projectChannels.status, 'active'),
    ))
    .limit(1);

  if (!channel) return c.json({ error: 'Not found' }, 404);

  const rawBody = await c.req.text();
  const signature = verifyChannelSignature(channel, rawBody, c);
  if (!signature.ok) return c.json({ error: signature.reason }, 401);

  const parsedBody = normalizeJsonObject(parseWebhookJsonBody(rawBody));
  if (platform === 'slack' && parsedBody.type === 'url_verification' && typeof parsedBody.challenge === 'string') {
    return c.json({ challenge: parsedBody.challenge });
  }

  const [project] = await db
    .select()
    .from(projects)
    .where(and(
      eq(projects.projectId, channel.projectId),
      eq(projects.accountId, channel.accountId),
      eq(projects.status, 'active'),
    ))
    .limit(1);
  if (!project) return c.json({ error: 'Project not found' }, 404);

  (c as any).set('accountId', channel.accountId);

  const payload = channelPayload(channel, c, rawBody);
  const renderedPrompt = renderPromptTemplate(channel.promptTemplate, payload);
  const result = await fireProjectChannel({
    channel,
    project,
    payload,
    renderedPrompt,
    request: requestAuditContext(c),
  });

  if (result.status === 'queued') {
    const backpressure = result.backpressure!;
    return c.json({
      status: 'queued',
      reason: result.reason,
      event: serializeProjectChannelEvent(result.event),
      backpressure: {
        provisioning_sessions: backpressure.provisioning,
        project_provisioning_limit: backpressure.projectProvisioningLimit,
        active_sessions: backpressure.active,
        account_active_limit: backpressure.accountActiveLimit,
        tier: backpressure.tier ?? 'free',
      },
    }, 202);
  }

  if (result.status === 'failed') {
    return c.json({
      error: result.error ?? 'Failed to create channel session',
      event: serializeProjectChannelEvent(result.event),
    }, (result.httpStatus ?? 500) as any);
  }

  return c.json({
    status: 'fired',
    event: serializeProjectChannelEvent(result.event),
    session: serializeSession(result.session!),
  }, 202);
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
    const rows = await db
      .select()
      .from(projectTriggers)
      .where(and(
        eq(projectTriggers.type, 'cron'),
        eq(projectTriggers.enabled, true),
      ))
      .limit(100);

    result.scanned = rows.length;
    for (const trigger of rows) {
      let due = false;
      try {
        due = isCronTriggerDue(trigger, now);
      } catch (error) {
        result.failed += 1;
        console.error(`[project-triggers] Invalid cron schedule for trigger ${trigger.triggerId}:`, error);
        await db
          .insert(projectTriggerEvents)
          .values({
            triggerId: trigger.triggerId,
            accountId: trigger.accountId,
            projectId: trigger.projectId,
            status: 'failed',
            payload: { cron: { error: 'invalid schedule', checked_at: now.toISOString() } },
            renderedPrompt: null,
            error: (error as Error).message || 'Invalid cron schedule',
            updatedAt: now,
          });
        continue;
      }

      if (!due) {
        result.skipped += 1;
        continue;
      }

      const [project] = await db
        .select()
        .from(projects)
        .where(and(
          eq(projects.projectId, trigger.projectId),
          eq(projects.accountId, trigger.accountId),
          eq(projects.status, 'active'),
        ))
        .limit(1);

      if (!project) {
        result.failed += 1;
        await db
          .insert(projectTriggerEvents)
          .values({
            triggerId: trigger.triggerId,
            accountId: trigger.accountId,
            projectId: trigger.projectId,
            status: 'failed',
            payload: { cron: { error: 'project not found', checked_at: now.toISOString() } },
            renderedPrompt: null,
            error: 'Project not found',
            updatedAt: now,
          });
        continue;
      }

      const payload = {
        cron: {
          schedule: cronTriggerSchedule(trigger),
          timezone: cronTriggerTimezone(trigger) ?? null,
          fired_at: now.toISOString(),
          last_fired_at: trigger.lastFiredAt?.toISOString() ?? null,
        },
      };
      const renderedPrompt = renderPromptTemplate(trigger.promptTemplate, payload);
      const fired = await fireProjectTrigger({
        trigger,
        project,
        payload,
        renderedPrompt,
        markAcceptedAt: now,
      });

      if (fired.status === 'fired') result.fired += 1;
      else if (fired.status === 'queued') result.queued += 1;
      else result.failed += 1;
    }
    return result;
  } finally {
    triggerSweepRunning = false;
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

  // Commit the generic OpenCode starter (kortix.toml + .opencode/{agents,
  // commands,skills} + README + CONTEXT.md + .gitignore) into the fresh
  // repo so users land with a working project shape on first session boot.
  // GitHub's Contents API updates the branch tip on every write, so these
  // must be sequential. A partial starter is not a usable project.
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

  return c.json(serializeProject(row, { projectRole: 'manager', effectiveRole: 'manager' }), 201);
});

// GET /v1/projects/:projectId/secrets
// List names and scopes only. Plaintext values never leave the write path.
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

  return c.json(rows.map(serializeProjectSecret));
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

// GET /v1/projects/:projectId/triggers
projectsApp.get('/:projectId/triggers', async (c) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const rows = await db
    .select()
    .from(projectTriggers)
    .where(and(
      eq(projectTriggers.projectId, projectId),
      eq(projectTriggers.accountId, loaded.row.accountId),
    ))
    .orderBy(desc(projectTriggers.updatedAt));

  return c.json(rows.map(serializeProjectTrigger));
});

// POST /v1/projects/:projectId/triggers
projectsApp.post('/:projectId/triggers', async (c) => {
  const projectId = c.req.param('projectId');
  const body = await readBody(c);
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const type = parseProjectTriggerType(body.type);
  if (!type) return c.json({ error: 'type must be one of cron|webhook' }, 400);

  const promptTemplate = normalizeString(body.prompt_template ?? body.promptTemplate);
  if (!promptTemplate) return c.json({ error: 'prompt_template is required' }, 400);

  const triggerConfig = normalizeJsonObject(body.config);
  if (type === 'webhook' && !normalizeString(triggerConfig.secret)) {
    return c.json({ error: 'config.secret is required for webhook triggers' }, 400);
  }
  if (type === 'cron' && !normalizeString(triggerConfig.cron ?? triggerConfig.schedule)) {
    return c.json({ error: 'config.cron is required for cron triggers' }, 400);
  }

  const agentName = normalizeString(body.agent_name ?? body.agentName) ?? 'default';
  const enabled = normalizeBoolean(body.enabled) ?? true;
  const metadata = normalizeJsonObject(body.metadata);
  const now = new Date();

  const [row] = await db
    .insert(projectTriggers)
    .values({
      accountId: loaded.row.accountId,
      projectId,
      type,
      config: triggerConfig,
      agentName,
      promptTemplate,
      enabled,
      createdBy: loaded.userId,
      metadata,
      updatedAt: now,
    })
    .returning();

  return c.json(serializeProjectTrigger(row), 201);
});

// GET /v1/projects/:projectId/triggers/:triggerId
projectsApp.get('/:projectId/triggers/:triggerId', async (c) => {
  const projectId = c.req.param('projectId');
  const triggerId = c.req.param('triggerId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const [row] = await db
    .select()
    .from(projectTriggers)
    .where(and(
      eq(projectTriggers.triggerId, triggerId),
      eq(projectTriggers.projectId, projectId),
      eq(projectTriggers.accountId, loaded.row.accountId),
    ))
    .limit(1);

  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json(serializeProjectTrigger(row));
});

// PATCH /v1/projects/:projectId/triggers/:triggerId
projectsApp.patch('/:projectId/triggers/:triggerId', async (c) => {
  const projectId = c.req.param('projectId');
  const triggerId = c.req.param('triggerId');
  const body = await readBody(c);
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const [existing] = await db
    .select()
    .from(projectTriggers)
    .where(and(
      eq(projectTriggers.triggerId, triggerId),
      eq(projectTriggers.projectId, projectId),
      eq(projectTriggers.accountId, loaded.row.accountId),
    ))
    .limit(1);
  if (!existing) return c.json({ error: 'Not found' }, 404);

  const updates: Partial<typeof projectTriggers.$inferInsert> = { updatedAt: new Date() };
  const nextType = hasOwn(body, 'type') ? parseProjectTriggerType(body.type) : existing.type;
  if (!nextType) return c.json({ error: 'type must be one of cron|webhook' }, 400);
  if (hasOwn(body, 'type')) updates.type = nextType;

  const nextConfig = hasOwn(body, 'config') ? normalizeJsonObject(body.config) : normalizeJsonObject(existing.config);
  if (hasOwn(body, 'config')) updates.config = nextConfig;
  if (nextType === 'webhook' && !normalizeString(nextConfig.secret)) {
    return c.json({ error: 'config.secret is required for webhook triggers' }, 400);
  }
  if (nextType === 'cron' && !normalizeString(nextConfig.cron ?? nextConfig.schedule)) {
    return c.json({ error: 'config.cron is required for cron triggers' }, 400);
  }

  const promptTemplate = normalizeString(body.prompt_template ?? body.promptTemplate);
  if (promptTemplate) updates.promptTemplate = promptTemplate;
  if (hasOwn(body, 'prompt_template') || hasOwn(body, 'promptTemplate')) {
    if (!promptTemplate) return c.json({ error: 'prompt_template cannot be empty' }, 400);
  }

  const agentName = normalizeString(body.agent_name ?? body.agentName);
  if (agentName) updates.agentName = agentName;
  if (hasOwn(body, 'agent_name') || hasOwn(body, 'agentName')) {
    if (!agentName) return c.json({ error: 'agent_name cannot be empty' }, 400);
  }

  if (hasOwn(body, 'enabled')) {
    const enabled = normalizeBoolean(body.enabled);
    if (enabled === null) return c.json({ error: 'enabled must be a boolean' }, 400);
    updates.enabled = enabled;
  }
  if (hasOwn(body, 'metadata')) updates.metadata = normalizeJsonObject(body.metadata);

  const [row] = await db
    .update(projectTriggers)
    .set(updates)
    .where(and(
      eq(projectTriggers.triggerId, triggerId),
      eq(projectTriggers.projectId, projectId),
      eq(projectTriggers.accountId, loaded.row.accountId),
    ))
    .returning();

  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json(serializeProjectTrigger(row));
});

// DELETE /v1/projects/:projectId/triggers/:triggerId
projectsApp.delete('/:projectId/triggers/:triggerId', async (c) => {
  const projectId = c.req.param('projectId');
  const triggerId = c.req.param('triggerId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  await db
    .delete(projectTriggers)
    .where(and(
      eq(projectTriggers.triggerId, triggerId),
      eq(projectTriggers.projectId, projectId),
      eq(projectTriggers.accountId, loaded.row.accountId),
    ));

  return c.json({ ok: true });
});

// GET /v1/projects/:projectId/channels
projectsApp.get('/:projectId/channels', async (c) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const rows = await db
    .select()
    .from(projectChannels)
    .where(and(
      eq(projectChannels.projectId, projectId),
      eq(projectChannels.accountId, loaded.row.accountId),
    ))
    .orderBy(desc(projectChannels.updatedAt));

  return c.json(rows.map(serializeProjectChannel));
});

// POST /v1/projects/:projectId/channels/oauth/start
projectsApp.post('/:projectId/channels/oauth/start', async (c) => {
  return startDirectOAuthForProject(c, 'channel');
});

// POST /v1/projects/:projectId/channels/connect-token
// Reuses the connector provider OAuth flow for chat apps. The returned provider
// account can then be bound to a concrete channel via POST /channels.
projectsApp.post('/:projectId/channels/connect-token', async (c) => {
  const projectId = c.req.param('projectId');
  const body = await readBody(c);
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  if (!isAccountManager(loaded.accountRole)) {
    return c.json({ error: 'Owner or admin role required' }, 403);
  }

  const platform = parseProjectChannelPlatform(body.platform);
  if (!platform) return c.json({ error: 'platform must be one of slack|telegram|msteams|discord' }, 400);

  const app = normalizeString(body.app) ?? platform;
  const successRedirectUri = normalizeString(body.success_redirect_uri ?? body.successRedirectUri)
    ?? `${config.FRONTEND_URL}/projects/${projectId}/settings?section=channels&connected=true`;
  const errorRedirectUri = normalizeString(body.error_redirect_uri ?? body.errorRedirectUri)
    ?? `${config.FRONTEND_URL}/projects/${projectId}/settings?section=channels&connected=false`;

  try {
    const provider = await getProviderFromRequest(c, loaded.row.accountId);
    return c.json(await provider.createConnectToken(loaded.row.accountId, app, {
      successRedirectUri,
      errorRedirectUri,
    }));
  } catch (error) {
    return c.json({ error: `Failed to create channel connect link: ${error}` }, 502);
  }
});

// POST /v1/projects/:projectId/channels
projectsApp.post('/:projectId/channels', async (c) => {
  const projectId = c.req.param('projectId');
  const body = await readBody(c);
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  if (!isAccountManager(loaded.accountRole)) {
    return c.json({ error: 'Owner or admin role required' }, 403);
  }

  const platform = parseProjectChannelPlatform(body.platform);
  if (!platform) return c.json({ error: 'platform must be one of slack|telegram|msteams|discord' }, 400);

  const externalChannelId = normalizeString(body.external_channel_id ?? body.externalChannelId);
  if (!externalChannelId) return c.json({ error: 'external_channel_id is required' }, 400);

  const promptTemplate = normalizeString(body.prompt_template ?? body.promptTemplate) ?? '{{ message.text }}';
  const agentName = normalizeString(body.agent_name ?? body.agentName) ?? 'default';
  const enabled = normalizeBoolean(body.enabled) ?? true;
  const configBody = normalizeJsonObject(body.config);
  const metadata = normalizeJsonObject(body.metadata);
  const now = new Date();

  const [row] = await db
    .insert(projectChannels)
    .values({
      accountId: loaded.row.accountId,
      projectId,
      platform,
      externalChannelId,
      externalTeamId: normalizeString(body.external_team_id ?? body.externalTeamId),
      name: normalizeString(body.name),
      config: configBody,
      agentName,
      promptTemplate,
      enabled,
      status: 'active',
      createdBy: loaded.userId,
      metadata,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [projectChannels.projectId, projectChannels.platform, projectChannels.externalChannelId],
      set: {
        externalTeamId: normalizeString(body.external_team_id ?? body.externalTeamId),
        name: normalizeString(body.name),
        config: configBody,
        agentName,
        promptTemplate,
        enabled,
        status: 'active',
        metadata,
        updatedAt: now,
      },
    })
    .returning();

  return c.json(serializeProjectChannel(row), 201);
});

// GET /v1/projects/:projectId/channels/:channelId/events
projectsApp.get('/:projectId/channels/:channelId/events', async (c) => {
  const projectId = c.req.param('projectId');
  const channelId = c.req.param('channelId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const [channel] = await db
    .select()
    .from(projectChannels)
    .where(and(
      eq(projectChannels.channelId, channelId),
      eq(projectChannels.projectId, projectId),
      eq(projectChannels.accountId, loaded.row.accountId),
    ))
    .limit(1);
  if (!channel) return c.json({ error: 'Not found' }, 404);

  const rows = await db
    .select()
    .from(projectChannelEvents)
    .where(and(
      eq(projectChannelEvents.channelId, channelId),
      eq(projectChannelEvents.projectId, projectId),
      eq(projectChannelEvents.accountId, loaded.row.accountId),
    ))
    .orderBy(desc(projectChannelEvents.createdAt));

  return c.json(rows.map(serializeProjectChannelEvent));
});

// GET /v1/projects/:projectId/channels/:channelId
projectsApp.get('/:projectId/channels/:channelId', async (c) => {
  const projectId = c.req.param('projectId');
  const channelId = c.req.param('channelId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const [row] = await db
    .select()
    .from(projectChannels)
    .where(and(
      eq(projectChannels.channelId, channelId),
      eq(projectChannels.projectId, projectId),
      eq(projectChannels.accountId, loaded.row.accountId),
    ))
    .limit(1);

  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json(serializeProjectChannel(row));
});

// PATCH /v1/projects/:projectId/channels/:channelId
projectsApp.patch('/:projectId/channels/:channelId', async (c) => {
  const projectId = c.req.param('projectId');
  const channelId = c.req.param('channelId');
  const body = await readBody(c);
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  if (!isAccountManager(loaded.accountRole)) {
    return c.json({ error: 'Owner or admin role required' }, 403);
  }

  const updates: Partial<typeof projectChannels.$inferInsert> = { updatedAt: new Date() };
  if (hasOwn(body, 'name')) updates.name = normalizeString(body.name);
  if (hasOwn(body, 'external_team_id') || hasOwn(body, 'externalTeamId')) {
    updates.externalTeamId = normalizeString(body.external_team_id ?? body.externalTeamId);
  }
  if (hasOwn(body, 'config')) updates.config = normalizeJsonObject(body.config);
  if (hasOwn(body, 'metadata')) updates.metadata = normalizeJsonObject(body.metadata);

  if (hasOwn(body, 'prompt_template') || hasOwn(body, 'promptTemplate')) {
    const promptTemplate = normalizeString(body.prompt_template ?? body.promptTemplate);
    if (!promptTemplate) return c.json({ error: 'prompt_template cannot be empty' }, 400);
    updates.promptTemplate = promptTemplate;
  }
  if (hasOwn(body, 'agent_name') || hasOwn(body, 'agentName')) {
    const agentName = normalizeString(body.agent_name ?? body.agentName);
    if (!agentName) return c.json({ error: 'agent_name cannot be empty' }, 400);
    updates.agentName = agentName;
  }
  if (hasOwn(body, 'enabled')) {
    const enabled = normalizeBoolean(body.enabled);
    if (enabled === null) return c.json({ error: 'enabled must be a boolean' }, 400);
    updates.enabled = enabled;
  }
  if (hasOwn(body, 'status')) {
    const status = parseIntegrationStatus(body.status);
    if (!status) return c.json({ error: 'status must be one of active|revoked|expired|error' }, 400);
    updates.status = status;
  }

  const [row] = await db
    .update(projectChannels)
    .set(updates)
    .where(and(
      eq(projectChannels.channelId, channelId),
      eq(projectChannels.projectId, projectId),
      eq(projectChannels.accountId, loaded.row.accountId),
    ))
    .returning();

  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json(serializeProjectChannel(row));
});

// DELETE /v1/projects/:projectId/channels/:channelId
projectsApp.delete('/:projectId/channels/:channelId', async (c) => {
  const projectId = c.req.param('projectId');
  const channelId = c.req.param('channelId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  if (!isAccountManager(loaded.accountRole)) {
    return c.json({ error: 'Owner or admin role required' }, 403);
  }

  await db
    .delete(projectChannels)
    .where(and(
      eq(projectChannels.channelId, channelId),
      eq(projectChannels.projectId, projectId),
      eq(projectChannels.accountId, loaded.row.accountId),
    ));

  return c.json({ ok: true });
});

// GET /v1/projects/:projectId/connectors
projectsApp.get('/:projectId/connectors', async (c) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const rows = await listProjectConnectors(loaded.row.accountId, projectId);
  return c.json(rows.map((row) => serializeProjectConnector(row, { includeProviderAccountId: true })));
});

// POST /v1/projects/:projectId/connectors/oauth/start
projectsApp.post('/:projectId/connectors/oauth/start', async (c) => {
  return startDirectOAuthForProject(c, 'connector');
});

// GET /v1/projects/:projectId/connectors/apps
projectsApp.get('/:projectId/connectors/apps', async (c) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  try {
    const provider = await getProviderFromRequest(c, loaded.row.accountId);
    const result = await provider.listApps(c.req.query('q'), parseInt(c.req.query('limit') || '48', 10), c.req.query('cursor'));
    return c.json(result);
  } catch (error) {
    return c.json({ error: `Failed to list connector apps: ${error}` }, 502);
  }
});

// POST /v1/projects/:projectId/connectors/connect-token
// Creates a provider connect link. The project connector row is created by
// POST /connectors or POST /connectors/sync after the provider account exists.
projectsApp.post('/:projectId/connectors/connect-token', async (c) => {
  const projectId = c.req.param('projectId');
  const body = await readBody(c);
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  if (!isAccountManager(loaded.accountRole)) {
    return c.json({ error: 'Owner or admin role required' }, 403);
  }

  const app = normalizeString(body.app) ?? undefined;
  const successRedirectUri = normalizeString(body.success_redirect_uri ?? body.successRedirectUri)
    ?? `${config.FRONTEND_URL}/projects/${projectId}/settings?connected=true`;
  const errorRedirectUri = normalizeString(body.error_redirect_uri ?? body.errorRedirectUri)
    ?? `${config.FRONTEND_URL}/projects/${projectId}/settings?connected=false`;

  try {
    const provider = await getProviderFromRequest(c, loaded.row.accountId);
    return c.json(await provider.createConnectToken(loaded.row.accountId, app, {
      successRedirectUri,
      errorRedirectUri,
    }));
  } catch (error) {
    return c.json({ error: `Failed to create connector link: ${error}` }, 502);
  }
});

// POST /v1/projects/:projectId/connectors/sync
// Imports provider accounts into this project after OAuth has completed.
projectsApp.post('/:projectId/connectors/sync', async (c) => {
  const projectId = c.req.param('projectId');
  const body = await readBody(c);
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  if (!isAccountManager(loaded.accountRole)) {
    return c.json({ error: 'Owner or admin role required' }, 403);
  }

  const appFilter = normalizeString(body.app);
  try {
    const provider = await getProviderFromRequest(c, loaded.row.accountId);
    const accounts = await provider.listAccounts(loaded.row.accountId);
    const synced = [];
    for (const account of accounts) {
      if (appFilter && account.app !== appFilter) continue;
      const row = await upsertProjectConnector({
        accountId: loaded.row.accountId,
        projectId,
        providerName: provider.name,
        app: account.app,
        appName: account.appName,
        providerAccountId: account.id,
        createdBy: loaded.userId,
        metadata: {
          external_user_id: account.externalUserId,
          provider_created_at: account.createdAt,
        },
      });
      synced.push(row);
    }

    return c.json({
      connectors: synced.map((row) => serializeProjectConnector(row, { includeProviderAccountId: true })),
      synced: synced.length,
    });
  } catch (error) {
    return c.json({ error: `Failed to sync project connectors: ${error}` }, 502);
  }
});

// POST /v1/projects/:projectId/connectors
// Binds an existing provider account to the project.
projectsApp.post('/:projectId/connectors', async (c) => {
  const projectId = c.req.param('projectId');
  const body = await readBody(c);
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  if (!isAccountManager(loaded.accountRole)) {
    return c.json({ error: 'Owner or admin role required' }, 403);
  }

  const app = normalizeString(body.app);
  const providerAccountId = normalizeString(body.provider_account_id ?? body.providerAccountId);
  if (!app) return c.json({ error: 'app is required' }, 400);
  if (!providerAccountId) return c.json({ error: 'provider_account_id is required' }, 400);

  const scopes = Array.isArray(body.scopes)
    ? body.scopes.filter((scope): scope is string => typeof scope === 'string')
    : [];
  const metadata = normalizeJsonObject(body.metadata);

  try {
    const provider = await getProviderFromRequest(c, loaded.row.accountId);
    const providerAccount = await provider.getAccount(loaded.row.accountId, providerAccountId);
    if (!providerAccount || providerAccount.app !== app) {
      return c.json({ error: 'Provider account was not found for this account/app' }, 400);
    }

    const row = await upsertProjectConnector({
      accountId: loaded.row.accountId,
      projectId,
      providerName: provider.name,
      app,
      appName: normalizeString(body.app_name ?? body.appName) ?? providerAccount.appName,
      providerAccountId,
      label: normalizeString(body.label),
      scopes,
      metadata: {
        external_user_id: providerAccount.externalUserId,
        provider_created_at: providerAccount.createdAt,
        ...metadata,
      },
      createdBy: loaded.userId,
    });

    return c.json(serializeProjectConnector(row, { includeProviderAccountId: true }), 201);
  } catch (error) {
    return c.json({ error: `Failed to create project connector: ${error}` }, 502);
  }
});

// GET /v1/projects/:projectId/connectors/:connectorId
projectsApp.get('/:projectId/connectors/:connectorId', async (c) => {
  const projectId = c.req.param('projectId');
  const connectorId = c.req.param('connectorId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const [row] = await db
    .select()
    .from(projectConnectors)
    .where(and(
      eq(projectConnectors.connectorId, connectorId),
      eq(projectConnectors.accountId, loaded.row.accountId),
      eq(projectConnectors.projectId, projectId),
    ))
    .limit(1);

  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json(serializeProjectConnector(row, { includeProviderAccountId: true }));
});

// PATCH /v1/projects/:projectId/connectors/:connectorId
projectsApp.patch('/:projectId/connectors/:connectorId', async (c) => {
  const projectId = c.req.param('projectId');
  const connectorId = c.req.param('connectorId');
  const body = await readBody(c);
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  if (!isAccountManager(loaded.accountRole)) {
    return c.json({ error: 'Owner or admin role required' }, 403);
  }

  const updates: Partial<typeof projectConnectors.$inferInsert> = { updatedAt: new Date() };
  if (hasOwn(body, 'label')) updates.label = normalizeString(body.label);
  if (hasOwn(body, 'metadata')) updates.metadata = normalizeJsonObject(body.metadata);
  if (hasOwn(body, 'scopes')) {
    updates.scopes = Array.isArray(body.scopes)
      ? body.scopes.filter((scope): scope is string => typeof scope === 'string')
      : [];
  }
  if (hasOwn(body, 'status')) {
    const status = parseProjectConnectorStatus(body.status);
    if (!status) return c.json({ error: 'status must be one of active|revoked|expired|error' }, 400);
    updates.status = status;
  }

  const [row] = await db
    .update(projectConnectors)
    .set(updates)
    .where(and(
      eq(projectConnectors.connectorId, connectorId),
      eq(projectConnectors.accountId, loaded.row.accountId),
      eq(projectConnectors.projectId, projectId),
    ))
    .returning();

  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json(serializeProjectConnector(row, { includeProviderAccountId: true }));
});

// DELETE /v1/projects/:projectId/connectors/:connectorId
projectsApp.delete('/:projectId/connectors/:connectorId', async (c) => {
  const projectId = c.req.param('projectId');
  const connectorId = c.req.param('connectorId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  if (!isAccountManager(loaded.accountRole)) {
    return c.json({ error: 'Owner or admin role required' }, 403);
  }

  await db
    .delete(projectConnectors)
    .where(and(
      eq(projectConnectors.connectorId, connectorId),
      eq(projectConnectors.accountId, loaded.row.accountId),
      eq(projectConnectors.projectId, projectId),
    ));

  return c.json({ ok: true });
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
