import { checkBillingActive } from '../../billing/services/billing-gate';
import { config, type SandboxProviderName } from '../../config';
import { resolveShareSubject } from '../../executor/share';
import { auth, json } from '../../openapi';
import { maxConcurrentSessionsForTier, resolveAccountTier } from '../../shared/account-limits';
import { recordAuditEvent } from '../../shared/audit';
import { db } from '../../shared/db';
import { DEFAULT_SANDBOX_SLUG, resolveTemplate } from '../../snapshots/builder';
import { listProjectSecretsSnapshotForUser } from '../secrets';
import { projectSessions } from '@kortix/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Context } from 'hono';
import { randomUUID } from 'node:crypto';
import { resolveProjectGitAuth } from './git';
import { isReservedSandboxEnvName, RESERVED_SANDBOX_ENV_NAMES } from './sandbox-env-names';
import { selectProvider } from '../../platform/services/provider-balancer';
import { ACTIVE_SESSION_STATUSES, PROVISIONING_SESSION_STATUSES, ProjectRow, ProjectSessionRow, RequestAuditContext, UUID_V4_REGEX, deriveKortixApiRoot, normalizeJsonObject, normalizeString } from './serializers';
import { allocateSessionRuntime } from './session-runtime-allocator';
import { buildSessionRuntimeEnv } from './session-runtime-env';

export type SessionCreateError = {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
};


export function sendSessionCreateError(c: Context, error: SessionCreateError) {
  for (const [key, value] of Object.entries(error.headers ?? {})) {
    c.header(key, value);
  }
  return c.json(error.body, error.status as any);
}


export async function countActiveProjectSessions(accountId: string): Promise<number> {
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


export async function countProvisioningProjectSessions(projectId: string): Promise<number> {
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


export async function enforceConcurrentSessionCap(accountId: string, userId: string, request?: RequestAuditContext): Promise<SessionCreateError | null> {
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


export async function checkConcurrentSessionCap(accountId: string, userId: string, request?: RequestAuditContext): Promise<{
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


export { RESERVED_SANDBOX_ENV_NAMES, isReservedSandboxEnvName };


/**
 * Re-derive a session's chat-channel env (SLACK_*) from its persisted binding so
 * any (re)provision restores it. Best-effort: a non-channel session (no
 * metadata.slack) returns {}, and a read failure never blocks provisioning.
 */
async function buildSessionChannelEnv(sessionId: string): Promise<Record<string, string>> {
  try {
    const [row] = await db
      .select({ metadata: projectSessions.metadata })
      .from(projectSessions)
      .where(eq(projectSessions.sessionId, sessionId))
      .limit(1);
    const slack = (row?.metadata as { slack?: Record<string, unknown> } | null)?.slack;
    if (!slack) return {};
    const env: Record<string, string> = {};
    if (typeof slack.team_id === 'string') env.SLACK_TEAM_ID = slack.team_id;
    if (typeof slack.channel === 'string') env.SLACK_CHANNEL_ID = slack.channel;
    if (typeof slack.thread_ts === 'string') env.SLACK_THREAD_TS = slack.thread_ts;
    if (typeof slack.user === 'string') env.SLACK_USER_ID = slack.user;
    return env;
  } catch (err) {
    console.warn('[session-env] failed to restore channel binding', { sessionId, err: (err as Error).message });
    return {};
  }
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
  // Restore the session's channel binding on EVERY (re)provision. A session
  // created from a chat channel (e.g. Slack) persists its binding in
  // metadata.slack; the in-box relay gates turn-end/answer on SLACK_THREAD_TS /
  // SLACK_CHANNEL_ID, so a box rebuilt from scratch (archived → cold-reprovision)
  // must get these back or the resurrected agent can't talk to its thread. The
  // session is the durable source of truth; the first boot got these via
  // extraEnvVars, every later rebuild gets them here.
  const channelEnv = await buildSessionChannelEnv(input.sessionId);
  return {
    ...runtimeSecrets.env,
    ...channelEnv,
    KORTIX_PROJECT_SECRET_NAMES: runtimeSecrets.names.join(','),
    KORTIX_PROJECT_SECRETS_REVISION: runtimeSecrets.revision,
    KORTIX_PROJECT_AUTO_CLONE: '1',
    // Force a FULL clone (no blobless partial clone). The blobless default
    // (KORTIX_CLONE_FILTER=blob:none) fetches file blobs lazily during checkout
    // through the Kortix git proxy; when the proxy's partial-clone capability
    // isn't advertised consistently, git intermittently stalls on an on-demand
    // blob fetch and the clone never finishes (repo_ready stuck false → the
    // session never reaches runtimeReady). A full clone transfers one pack with
    // no on-demand fetches — reliable. Starter/project repos are small so the
    // size cost is negligible. Empty string = full clone (see daemon config.ts).
    KORTIX_CLONE_FILTER: '',
    ...buildSessionRuntimeEnv({
      projectId: input.projectId,
      sessionId: input.sessionId,
      // Universal proxy origin: when enabled, the sandbox clones via the Kortix
      // git proxy with its own KORTIX_TOKEN — a real host credential never lands
      // in the sandbox. The daemon's credential helper returns KORTIX_TOKEN for
      // the proxy host. OFF → direct clone of the real repo (legacy token flow).
      repoUrl: config.KORTIX_GIT_PROXY ? proxyGitUrl(input.projectId) : input.repoUrl,
      baseRef: input.baseRef,
      agentName: input.agentName,
      apiUrl: deriveKortixApiBase(),
      initialPrompt: input.initialPrompt,
      // Per-session model override (e.g. Slack turns pin a specific model).
      // The sandbox agent reads this and sets it on every opencode prompt call.
      opencodeModel: input.opencodeModel,
    }),
  };
}

/** Derive the API v1 base URL sandboxes call as `$KORTIX_API_URL`. */

export function deriveKortixApiBase(): string {
  return `${deriveKortixApiRoot(config.KORTIX_URL)}/v1`;
}

/**
 * The Kortix git-proxy origin for a project — the UNIVERSAL client-facing git
 * URL. Clients clone/push this with a Kortix token; the API resolves the real
 * upstream + mints the host credential server-side.
 */

export function proxyGitUrl(projectId: string): string {
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

export function sandboxCallbackUnreachableReason(): string | null {
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
  /**
   * Sessions default to private (owner-only). Automation callers (triggers,
   * Slack/Telegram channels) pass 'project' — those sessions belong to the
   * project, not to the stand-in owner they're attributed to, and would
   * otherwise be invisible to everyone but the account's first owner.
   */
  visibility?: 'private' | 'project';
}): Promise<{ row?: ProjectSessionRow; error?: SessionCreateError; headers?: Record<string, string> }> {
  const { project, userId, body } = input;
  const visibility = input.visibility ?? 'private';
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
  let providerName: SandboxProviderName = await selectProvider();
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

  // The concurrency cap and the billing gate are independent read-only checks —
  // run them concurrently so a warmed create pays a single DB round-trip instead
  // of two serial ones. Error precedence is preserved exactly: the cap (429) is
  // still evaluated/returned before billing (402).
  const [capResult, billingCheck] = await Promise.all([
    input.enforceAccountCap !== false
      ? checkConcurrentSessionCap(accountId, userId, input.request)
      : Promise.resolve(null),
    checkBillingActive(accountId),
  ]);
  if (capResult) {
    responseHeaders = capResult.headers;
    if (capResult.error) return { error: capResult.error };
  }
  if (!billingCheck.ok) {
    return {
      error: {
        status: 402,
        body: {
          error: billingCheck.message,
          message: billingCheck.message,
          code: billingCheck.reason,
          balance: billingCheck.balance,
          // The account that actually needs the upgrade — the project's owning
          // (team) account, NOT the caller's primary account. The upgrade dialog
          // scopes itself to this so a non-billing member sees the *team's*
          // billing state (and a gated CTA), not their own personal account.
          account_id: accountId,
        },
      },
    };
  }

  const requestedSessionId = normalizeString(body.session_id ?? body.sessionId);
  if (requestedSessionId && !UUID_V4_REGEX.test(requestedSessionId)) {
    return { error: { status: 400, body: { error: 'Invalid session id' } } };
  }
  const sessionId = requestedSessionId ?? randomUUID();

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
        visibility,
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

  // NOTE: the session branch is NOT pushed to origin here. The sandbox creates
  // it locally from the base checkout at boot, and publishes it lazily on first
  // push / change-request creation. Session creation owns durable identity; the
  // runtime allocator only attaches compute for this exact id.
  allocateSessionRuntime({
    sessionId,
    accountId,
    projectId,
    userId,
    project,
    providerName,
    baseRef,
    agentName,
    sandboxSlug,
    sessionMetadata: metadata,
    runtimeMetadata: input.metadata,
    extraEnvVars: input.extraEnvVars,
    buildEnvVars: () => buildSessionSandboxEnvVars({
      accountId,
      projectId,
      sessionId,
      userId,
      repoUrl: project.repoUrl,
      baseRef,
      agentName,
      initialPrompt,
      opencodeModel,
    }),
    resolveGitAuthToken: async () => (await resolveProjectGitAuth(project)).auth?.token ?? null,
  });

  return { row: sessionRow, headers: responseHeaders };
}
