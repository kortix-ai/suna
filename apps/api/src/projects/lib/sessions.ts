import { checkBillingActive } from '../../billing/services/billing-gate';
import { config, type SandboxProviderName } from '../../config';
import { resolveShareSubject } from '../../executor/share';
import { auth, json } from '../../openapi';
import { ProvisionTimeline } from '../../platform/services/provision-timeline';
import { provisionSessionSandbox } from '../../platform/services/session-sandbox';
import { claimWarmSandbox, refillProjectPool, syncClaimedBoxToBase, warmPoolEnabled } from '../../platform/services/warm-pool';
import { maxConcurrentSessionsForTier, resolveAccountTier } from '../../shared/account-limits';
import { recordAuditEvent } from '../../shared/audit';
import { db } from '../../shared/db';
import { DEFAULT_SANDBOX_SLUG, resolveTemplate } from '../../snapshots/builder';
import { createRemoteSessionBranch } from '../git';
import { listProjectSecretsSnapshotForUser } from '../secrets';
import { projectSessions, sessionSandboxes } from '@kortix/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Context } from 'hono';
import { randomUUID } from 'node:crypto';
import { resolveProjectGitAuth } from './git';
import { selectProvider } from '../../platform/services/provider-balancer';
import { ACTIVE_SESSION_STATUSES, PROVISIONING_SESSION_STATUSES, ProjectRow, ProjectSessionRow, RequestAuditContext, UUID_V4_REGEX, deriveKortixApiRoot, normalizeJsonObject, normalizeString } from './serializers';

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
    // Force a FULL clone (no blobless partial clone). The blobless default
    // (KORTIX_CLONE_FILTER=blob:none) fetches file blobs lazily during checkout
    // through the Kortix git proxy; when the proxy's partial-clone capability
    // isn't advertised consistently, git intermittently stalls on an on-demand
    // blob fetch and the clone never finishes (repo_ready stuck false → the
    // session never reaches runtimeReady). A full clone transfers one pack with
    // no on-demand fetches — reliable. Starter/project repos are small so the
    // size cost is negligible. Empty string = full clone (see daemon config.ts).
    KORTIX_CLONE_FILTER: '',
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
            status: claimed.ready ? 'running' : 'provisioning',
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
      const sessionStartTimeline = tl.log();
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
