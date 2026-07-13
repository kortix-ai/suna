import { randomUUID } from 'node:crypto';
import {
  projectSessionConnectorBindings,
  projectSessionRuntimeContexts,
  projectSessions,
} from '@kortix/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { checkBillingActive } from '../../billing/services/billing-gate';
import { type SandboxProviderName, config } from '../../config';
import { agentMayUseConnector } from '../../iam/agent-scope';
import { projectLlmGatewayEnabled } from '../../llm-gateway/enablement';
import { nativeProviderEnvNames } from '../../llm-gateway/sandbox-credentials';
import { auth, json } from '../../openapi';
import { sandboxFrontendBaseUrl } from '../../platform/sandbox-frontend-url';
import { selectProvider } from '../../platform/services/provider-balancer';
import { ProvisionTimeline } from '../../platform/services/provision-timeline';
import { provisionSessionSandbox } from '../../platform/services/session-sandbox';
import { resolveAccountSessionLimit } from '../../shared/account-limits';
import { recordAuditEvent } from '../../shared/audit';
import { db } from '../../shared/db';
import { notifySessionProvisioningFailed } from '../../shared/session-failure-notifier';
import { DEFAULT_SANDBOX_SLUG, resolveTemplate } from '../../snapshots/builder';
import {
  grantFromLoadedAgents,
  loadProjectAgents,
  projectRequiresDeclaredAgents,
  resolveGovernedAgentGrant,
} from '../agents';
import { createRemoteSessionBranch, resolveCommitSha } from '../git';
import { AmbiguousSecretGrantError, listProjectSecretsSnapshotForUser } from '../secrets';
import { resolveCompiledRuntimeConfigForSession, type CompiledRuntimeConfig } from './compile-runtime-config';
import {
  resolveProjectComposerState,
  type HarnessAuthKind,
} from './composer-capabilities';
import { resolveProjectGitAuth, withProjectGitAuth } from './git';
import { resolveSessionProvider } from './provider-precedence';
import { RESERVED_SANDBOX_ENV_NAMES, isReservedSandboxEnvName } from './sandbox-env-names';
import {
  ACTIVE_SESSION_STATUSES,
  PROVISIONING_SESSION_STATUSES,
  type ProjectRow,
  type ProjectSessionRow,
  type RequestAuditContext,
  UUID_V4_REGEX,
  deriveKortixApiRoot,
  normalizeJsonObject,
  normalizeString,
} from './serializers';
import {
  parseSessionConnectorBindings,
  validateSessionConnectorBindings,
} from './session-connector-bindings';
import { allocateSessionRuntime } from './session-runtime-allocator';
import {
  buildSessionRuntimeContextEnv,
  mergeSessionSandboxEnv,
  parseSessionRuntimeContext,
} from './session-runtime-context';
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
    .where(
      and(
      eq(projectSessions.accountId, accountId),
      inArray(projectSessions.status, [...ACTIVE_SESSION_STATUSES]),
      ),
    )
    .limit(1);

  return Number(row?.activeCount ?? 0);
}

export async function countProvisioningProjectSessions(projectId: string): Promise<number> {
  const [row] = await db
    .select({ provisioningCount: sql<number>`count(*)::int` })
    .from(projectSessions)
    .where(
      and(
      eq(projectSessions.projectId, projectId),
      inArray(projectSessions.status, [...PROVISIONING_SESSION_STATUSES]),
      ),
    )
    .limit(1);

  return Number(row?.provisioningCount ?? 0);
}

export async function enforceConcurrentSessionCap(
  accountId: string,
  userId: string,
  request?: RequestAuditContext,
): Promise<SessionCreateError | null> {
  const { tier, limit, source } = await resolveAccountSessionLimit(accountId);
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
      limit_source: source,
      active_sessions: activeSessions,
    },
  }).catch((error) => {
    console.error('[projects] Failed to record session cap audit event:', error);
  });

  const message = `You've reached your plan's concurrent-session limit (${limit}). Upgrade your plan for a higher limit, or contact the Kortix team to raise it for your account.`;
  return {
    status: 429,
    headers: {
      'X-RateLimit-Limit': String(limit),
      'X-RateLimit-Remaining': '0',
    },
    body: {
      error: message,
      message,
      code: 'concurrent_session_limit',
      limit,
      active_sessions: activeSessions,
    },
  };
}

export async function checkConcurrentSessionCap(
  accountId: string,
  userId: string,
  request?: RequestAuditContext,
): Promise<{
  error?: SessionCreateError;
  headers: Record<string, string>;
}> {
  const { limit } = await resolveAccountSessionLimit(accountId);
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
    console.warn('[session-env] failed to restore channel binding', {
      sessionId,
      err: (err as Error).message,
    });
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
  runtimeModel?: string | null;
  /** Explicit server-resolved auth route. The daemon must not infer precedence
   * from whichever credential-looking environment variable happens to exist. */
  runtimeAuthKind?: HarnessAuthKind | null;
  /** Resolved per-project `llm_gateway` experimental flag. Gateway ON →
   *  opencode is locked to the gateway and native provider keys are withheld;
   *  OFF (default) → native BYOK providers must reach opencode, so the deny
   *  list is empty. Mirrors the conditional KORTIX_LLM_* injection at provision. */
  llmGatewayEnabled: boolean;
  /** New session (brand-new branch == base, no remote commits). Lets the
   *  daemon create the session branch LOCALLY instead of a redundant network
   *  fetch of a branch that's identical to base — that fetch cost up to ~10s
   *  through the dev tunnel (2026-06-13). Restart/resume omit it (their branch
   *  may carry the agent's pushed commits → real fetch needed). */
  freshSession?: boolean;
  /** The project's base-branch tip SHA, resolved server-side (no tunnel). When
   *  it equals the image-baked scaffold's root SHA — true for a fresh project
   *  seeded from the starter with no per-project commit — the daemon skips the
   *  in-guest `git fetch` ENTIRELY (the baked scaffold already IS base), turning
   *  repo materialization into a pure-local op. That fetch is a zero-object
   *  negotiation round-trip that still hung for 34s through the flaky dev tunnel
   *  (2026-06-13). Omitted → daemon delta-fetches as before. */
  baseSha?: string;
  /** Project git context, so the running agent's `secrets` grant in `agents:`
   *  can be resolved and applied by IDENTIFIER — secrets the agent isn't
   *  granted are dropped from the injected env (a prompt-injected agent then
   *  can't read another scope's keys out of $ENV). Optional: when absent, the
   *  grant defaults to 'all' (back-compat, no narrowing). */
  defaultBranch?: string;
  manifestPath?: string;
}): Promise<Record<string, string>> {
  // Only user runtime secrets belong here. The sandbox-scoped KORTIX_TOKEN is
  // minted by provisionSessionSandbox() and injected at the provider boundary,
  // then reused by the daemon for both API calls and proxy HMAC validation.
  // Resolved AS the launching user so their own CODEX_AUTH_JSON override (if
  // any) wins; every OTHER secret is project-wide (secret sharing was retired —
  // authorization is centralized on the running agent's `secrets` grant, applied
  // below by identifier).
  let agentGrantEnv: string[] | 'all' | undefined;

  // One compiler entrypoint: v2 returns the sealed OpenCode compatibility
  // config; v3 returns the ACP launch plan. V1/no manifest remains null.
  let compiledRuntimeConfig: CompiledRuntimeConfig | null = null;
  if (input.defaultBranch) {
    compiledRuntimeConfig = await resolveCompiledRuntimeConfigForSession({
      projectId: input.projectId,
      repoUrl: input.repoUrl,
      defaultBranch: input.defaultBranch,
      manifestPath: input.manifestPath ?? 'kortix.yaml',
      gitAuthToken: null,
    }).catch(() => null);

    // Per-agent secret scoping: an agent declared in `agents:` with a `secrets`
    // allowlist receives ONLY those IDENTIFIERS — so a narrowly-scoped agent
    // can't read another scope's API keys/payment creds straight out of $ENV.
    // No-op (undefined → 'all') for back-compat grants and projects without
    // an `agents:` map or git context. This is the ONLY gate on agent secret
    // access — there is no resource-side allow-list on the secret itself.
    const loadedAgents = await loadProjectAgents({
      projectId: input.projectId,
      repoUrl: input.repoUrl,
      defaultBranch: input.defaultBranch,
      manifestPath: input.manifestPath ?? 'kortix.yaml',
      gitAuthToken: null,
    }).catch(() => null);
    const grant = loadedAgents ? grantFromLoadedAgents(input.agentName, loadedAgents) : null;
    agentGrantEnv = grant?.env;
  }

  let runtimeSecrets: { env: Record<string, string>; names: string[]; revision: string };
  try {
    runtimeSecrets = await listProjectSecretsSnapshotForUser(
      input.projectId,
      input.userId,
      agentGrantEnv,
    );
  } catch (err) {
    if (err instanceof AmbiguousSecretGrantError) {
      console.error(
        `[session ${input.sessionId}] agent '${input.agentName}' secrets grant is ambiguous: ${err.message}`,
      );
    }
    throw err;
  }
  if (Array.isArray(agentGrantEnv) && agentGrantEnv.length > 0) {
    console.log(
      `[session ${input.sessionId}] agent '${input.agentName}' env-scoped to ${agentGrantEnv.length} granted identifier(s)`,
    );
  }
  // The Slack signing secret only verifies inbound webhooks (an apps/api job).
  // The in-sandbox agent never needs it — keep it out of the sandbox env.
  delete runtimeSecrets.env.SLACK_SIGNING_SECRET;
  // The Slack BOT TOKEN no longer belongs in the sandbox either: the `slack`
  // shim now runs every Web API call through the Executor (server-side token)
  // and its file ops through the server-side file proxy. Keeping it out means a
  // compromised/prompt-injected agent can't exfiltrate the raw bot token — only
  // make scoped, audited, policy-gated channel calls. (KORTIX-206 Phase C2.)
  delete runtimeSecrets.env.SLACK_BOT_TOKEN;
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
  const sessionContextEnv = await buildSessionRuntimeContextEnv(input.sessionId);
  return {
    ...runtimeSecrets.env,
    ...channelEnv,
    ...sessionContextEnv,
    KORTIX_PROJECT_SECRET_NAMES: runtimeSecrets.names.join(','),
    KORTIX_PROJECT_SECRETS_REVISION: runtimeSecrets.revision,
    ...(input.runtimeAuthKind ? { KORTIX_RUNTIME_AUTH_KIND: input.runtimeAuthKind } : {}),
    // Provider API keys reach the sandbox (the agent's own code may use them),
    // but opencode must NOT — a provider key in opencode's env makes it connect
    // a NATIVE provider and bypass the gateway. The daemon withholds exactly
    // these names from the opencode process (Codex/OpenCode auth is excluded —
    // that one is an intentional native provider).
    KORTIX_OPENCODE_DENY_ENV: input.llmGatewayEnabled ? nativeProviderEnvNames().join(',') : '',
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
      frontendUrl: sandboxFrontendBaseUrl(),
      initialPrompt: input.initialPrompt,
      // Per-session model override (e.g. Slack turns pin a specific model).
      // The sandbox agent reads this and sets it on every opencode prompt call.
      runtimeModel: input.runtimeModel,
      compiledRuntimeConfig,
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
  visibility?: 'private' | 'project' | 'restricted';
}): Promise<{
  row?: ProjectSessionRow;
  error?: SessionCreateError;
  headers?: Record<string, string>;
}> {
  const { project, userId, body } = input;
  const visibility = input.visibility ?? 'private';
  const projectId = project.projectId;
  const accountId = project.accountId;
  const parsedRuntimeContext = parseSessionRuntimeContext(body.runtime_context);
  if (!parsedRuntimeContext.ok) {
    return {
      error: {
        status: 400,
        body: {
          error: parsedRuntimeContext.error,
          code: 'INVALID_SESSION_RUNTIME_CONTEXT',
        },
      },
    };
  }
  const parsedConnectorBindings = parseSessionConnectorBindings(body.connector_bindings);
  if (!parsedConnectorBindings.ok) {
    return {
      error: {
        status: 400,
        body: {
          error: parsedConnectorBindings.error,
          code: 'INVALID_SESSION_CONNECTOR_BINDINGS',
        },
      },
    };
  }

  const baseRef = normalizeString(body.base_ref ?? body.baseRef) ?? project.defaultBranch;
  // Explicit request wins; otherwise fall back to the project's default agent
  // (a v2 kortix.yaml's top-level `default_agent`, or a legacy v1 kortix.toml's
  // `[opencode] default_agent` — synced to project metadata, or a UI/Slack
  // override), so EVERY session — UI, triggers, channels — inherits the
  // project's chosen agent without each caller passing one. Unset → 'default'.
  const projectDefaultAgent = normalizeString(
    (project.metadata as Record<string, unknown> | null | undefined)?.default_agent,
  );
  const requestedAgent = normalizeString(body.agent_name ?? body.agentName);
  // V3's manifest is the source of truth. Newly provisioned projects may not
  // have mirrored default_agent into project metadata yet, so resolve it from
  // kortix.yaml before falling back to the legacy "default" sentinel.
  let loadedAgentsForDefault: Awaited<ReturnType<typeof loadProjectAgents>> | null = null;
  if (!requestedAgent && !projectDefaultAgent) {
    loadedAgentsForDefault = await loadProjectAgents(project);
  }
  const agentName =
    requestedAgent ?? projectDefaultAgent ?? loadedAgentsForDefault?.defaultAgent ?? 'default';
  let loadedAgentGrant: ReturnType<typeof grantFromLoadedAgents> | undefined;
  if (parsedConnectorBindings.bindings) {
    loadedAgentGrant = grantFromLoadedAgents(agentName, await loadProjectAgents(project));
    for (const alias of Object.keys(parsedConnectorBindings.bindings)) {
      if (!agentMayUseConnector(loadedAgentGrant, alias)) {
        return {
          error: {
            status: 403,
            body: {
              error: `Agent "${agentName}" is not granted connector "${alias}"`,
              code: 'CONNECTOR_NOT_ASSIGNED',
            },
          },
        };
      }
    }
  }
  const validatedConnectorBindings = await validateSessionConnectorBindings({
    accountId,
    projectId,
    bindings: parsedConnectorBindings.bindings,
  });
  if (!validatedConnectorBindings.ok) {
    return {
      error: {
        status: validatedConnectorBindings.code === 'CONNECTOR_PROFILE_NOT_FOUND' ? 404 : 409,
        body: {
          error: validatedConnectorBindings.error,
          code: validatedConnectorBindings.code,
        },
      },
    };
  }
  // MANDATORY DECLARED AGENTS (flagged — docs/specs/2026-07-05-agent-first-config-
  // unification.md §2.1/§3 Phase 2). Only projects "subject" to enforcement (the
  // platform-wide flag, or a project stamped `metadata.require_declared_agents`
  // at creation) pay for this: an extra manifest read, done synchronously here so
  // an undeclared agent is REJECTED with an explicit 400 before any row is
  // inserted or sandbox provisioned — never left to resolve to the permissive
  // null grant `resolveAgentGrant` falls back to on a later hiccup (see the
  // `.catch` in session-sandbox.ts `mintExecutorToken`, which must stay
  // fail-safe for NON-subject projects). Non-subject projects take the exact
  // same path as before this flag existed (zero added I/O, zero behavior change).
  if (projectRequiresDeclaredAgents(project.metadata, config.KORTIX_REQUIRE_DECLARED_AGENTS)) {
    const loadedAgents = loadedAgentsForDefault ?? await loadProjectAgents(project);
    const governed = resolveGovernedAgentGrant(agentName, loadedAgents, {
      subject: true,
      projectDefaultAgent,
    });
    if (!governed.ok) {
      return { error: { status: 400, body: { error: governed.error, code: governed.code } } };
    }
  }

  const requestedConnection = normalizeString(body.connection_id ?? body.connectionId) as HarnessAuthKind | null;
  const rawModelSelection = body.model_selection ?? body.modelSelection;
  const modelSelection = rawModelSelection && typeof rawModelSelection === 'object' && !Array.isArray(rawModelSelection)
    ? rawModelSelection as Record<string, unknown>
    : null;
  const selectionKind = normalizeString(modelSelection?.kind);
  if (selectionKind && !['default', 'preset', 'custom'].includes(selectionKind)) {
    return { error: { status: 400, body: { error: 'model_selection.kind must be default, preset, or custom', code: 'INVALID_MODEL_SELECTION' } } };
  }
  const selectionModel = normalizeString(modelSelection?.model_id ?? modelSelection?.modelId);
  if ((selectionKind === 'preset' || selectionKind === 'custom') && !selectionModel) {
    return { error: { status: 400, body: { error: `${selectionKind} model selection requires model_id`, code: 'INVALID_MODEL_SELECTION' } } };
  }
  const selectionConnection = normalizeString(modelSelection?.connection_id ?? modelSelection?.connectionId) as HarnessAuthKind | null;
  if (requestedConnection && selectionConnection && requestedConnection !== selectionConnection) {
    return { error: { status: 400, body: { error: 'connection_id conflicts with model_selection.connection_id', code: 'INVALID_MODEL_SELECTION' } } };
  }
  let composerCapability;
  try {
    const state = await resolveProjectComposerState({
      project: await withProjectGitAuth(project),
      userId,
      metadata: project.metadata,
    });
    composerCapability = await state.capabilities(agentName, requestedConnection ?? selectionConnection);
  } catch (error) {
    return {
      error: {
        status: 400,
        body: {
          error: error instanceof Error ? error.message : String(error),
          code: 'INVALID_AGENT_RUNTIME',
        },
      },
    };
  }
  if (!composerCapability.can_start) {
    return {
      error: {
        status: 409,
        body: {
          error: composerCapability.blocking_reason ?? 'The selected agent is not ready to start.',
          code: 'COMPOSER_CAPABILITY_BLOCKED',
          capabilities: composerCapability,
        },
      },
    };
  }
  if (selectionKind === 'preset' && !composerCapability.model.presets.some((preset) => preset.id === selectionModel)) {
    return { error: { status: 400, body: { error: `Model preset "${selectionModel}" is not available for the selected connection`, code: 'INVALID_MODEL_SELECTION' } } };
  }
  if (selectionKind === 'custom' && !composerCapability.model.custom_allowed) {
    return { error: { status: 400, body: { error: 'Custom model ids are not supported by the selected harness', code: 'INVALID_MODEL_SELECTION' } } };
  }
  // Explicit request wins; otherwise fall back to the project's default sandbox
  // template (`sandbox.default` in kortix.yaml — `[sandbox] default` in a
  // legacy v1 kortix.toml — synced to project metadata), so EVERY session — UI,
  // triggers, channels — inherits the project's chosen box without each
  // caller passing `sandbox_slug`. Unset → platform default.
  const projectDefaultSandboxSlug = normalizeString(
    (project.metadata as Record<string, unknown> | null | undefined)?.default_sandbox_slug,
  );
  const sandboxSlug =
    normalizeString(body.sandbox_slug ?? body.sandboxSlug) ??
    projectDefaultSandboxSlug ??
    undefined;
  // Sandbox provider: explicit request › per-project pin (Customize → Settings) ›
  // weighted balancer. The pin lets you put ONE project on e.g. platinum regardless
  // of the global distribution weights — see resolveSessionProvider.
  const picked = resolveSessionProvider({
    requested: normalizeString(body.provider) ?? null,
    projectPin:
      normalizeString(
        (project.metadata as Record<string, unknown> | null | undefined)?.default_sandbox_provider,
      ) ?? null,
    allowed: config.ALLOWED_SANDBOX_PROVIDERS,
    isEnabled: (p) => config.isProviderEnabled(p as SandboxProviderName),
  });
  if ('badRequest' in picked) {
    return {
      error: {
        status: 400,
        body: { error: `Unknown or disabled sandbox provider: ${picked.badRequest}` },
      },
    };
  }
  const providerName: SandboxProviderName =
    'provider' in picked ? (picked.provider as SandboxProviderName) : await selectProvider();

  const callbackUnreachable = sandboxCallbackUnreachableReason();
  if (callbackUnreachable) {
    return {
      error: { status: 503, body: { error: callbackUnreachable, code: 'KORTIX_URL_UNREACHABLE' } },
    };
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
  if ('opencode_model' in body || 'opencodeModel' in body) {
    return {
      error: {
        status: 400,
        body: { error: 'Use model or runtime_model for session model overrides', code: 'invalid_body' },
      },
    };
  }
  const sessionId = requestedSessionId ?? randomUUID();

  const initialPrompt = normalizeString(body.initial_prompt ?? body.initialPrompt);
  const runtimeModel = selectionKind === 'default'
    ? null
    : selectionModel ?? normalizeString(body.model ?? body.runtime_model);
  const sessionName = normalizeString(body.name);
  const requestMetadata = normalizeJsonObject(body.metadata);
  const metadata = {
    ...requestMetadata,
    ...(sessionName ? { name: sessionName } : {}),
    ...(initialPrompt ? { initial_prompt: initialPrompt } : {}),
    ...(runtimeModel ? { model: runtimeModel } : {}),
    auth_connection: composerCapability.auth.active,
    model_selection: {
      harness: composerCapability.agent.harness,
      connection_id: composerCapability.auth.active,
      kind: selectionKind ?? (runtimeModel ? 'custom' : 'default'),
      model_id: runtimeModel,
    },
    ...(input.metadata ?? {}),
  };

  let sessionRow: ProjectSessionRow | null = null;
  try {
    sessionRow = await db.transaction(async (tx) => {
      const [row] = await tx
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
    if (!row) throw new Error('Session insert returned no row');
    if (parsedRuntimeContext.context !== undefined) {
        await tx
          .insert(projectSessionRuntimeContexts)
          .values({
            sessionId,
            context: parsedRuntimeContext.context,
            byteSize: new TextEncoder().encode(JSON.stringify(parsedRuntimeContext.context))
              .byteLength,
          })
          .returning({ sessionId: projectSessionRuntimeContexts.sessionId });
    }
      if (validatedConnectorBindings.bindings.length > 0) {
        await tx
          .insert(projectSessionConnectorBindings)
          .values(
            validatedConnectorBindings.bindings.map((binding) => ({
              sessionId,
              accountId,
              projectId,
              connectorAlias: binding.alias,
              connectorId: binding.connectorId,
              profileId: binding.profileId,
              source: 'request' as const,
              createdBy: userId,
            })),
          )
          .returning({ sessionId: projectSessionConnectorBindings.sessionId });
      }
      return row;
    });
  } catch (error) {
    // Besides a randomUUID() collision on the PK / (project_id, branch_name)
    // unique index, `sandbox_provider` is an ENUM: a provider this env enables
    // but the target DB's type is missing fails here with 22P02, not upstream —
    // resolveSessionProvider validates against config, never against the DB.
    // (That is how prod, whose faked baseline skipped 'platinum', 500'd every
    // create on a project pinned to it.) verify-live-schema.ts now gates that drift.
    // Session, context and profile bindings are one transaction. Nothing is
    // visible and provisioning never starts when any child insert fails.
    const message = (error as Error).message || 'Insert failed';
    return { error: { status: 500, body: { error: message, retry: true } } };
  }

  if (sessionRow === null) {
    return {
      error: {
        status: 500,
        body: { error: 'Session insert returned no row', retry: true },
      },
    };
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
      // Resolve the base-branch tip SHA server-side (no tunnel) so the daemon
      // can skip the in-guest fetch when the baked scaffold already IS base.
      // Best-effort + timeout-guarded (never block create): on failure/timeout
      // the hint is omitted → daemon delta-fetches as before. Runs CONCURRENTLY
      // with gitAuth (folded into the env-build chain, not awaited inline).
      const baseShaPromise = Promise.race([
        resolveCommitSha(project, baseRef).catch(() => undefined),
        new Promise<undefined>((r) => setTimeout(() => r(undefined), 2000)),
      ]);
      const envPromise = baseShaPromise
        .then((baseSha) =>
        buildSessionSandboxEnvVars({
          accountId,
          projectId,
          sessionId,
          userId,
          repoUrl: project.repoUrl,
          baseRef,
          agentName,
          initialPrompt,
          runtimeModel,
          runtimeAuthKind: composerCapability.auth.active,
          llmGatewayEnabled: projectLlmGatewayEnabled(project.metadata),
          freshSession: true,
          baseSha,
          defaultBranch: project.defaultBranch,
          manifestPath: project.manifestPath,
        }),
        )
        .then((envVars) => {
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
      const branchAlreadyCreated =
        body.branch_already_created === true || body.branchAlreadyCreated === true;
      const branchPromise: Promise<void> = branchAlreadyCreated
        ? Promise.resolve()
        : projectWithGitAuthPromise
            .then((projectWithGitAuth) =>
            createRemoteSessionBranch(projectWithGitAuth, sessionId, baseRef),
            )
            .then(() => {
            tl.mark('branch-pushed');
            void mergeSessionMetadata({
                remote_branch: {
                  status: 'ready',
                  branch: sessionId,
                  updated_at: new Date().toISOString(),
                },
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

      const extraEnvVars = mergeSessionSandboxEnv(await envPromise, input.extraEnvVars);

      const provisionPromise = provisionSessionSandbox({
        sandboxId: sessionId,
        accountId,
        projectId,
        userId,
        provider: providerName,
        metadata: { session_id: sessionId, project_id: projectId, ...(input.metadata ?? {}) },
        extraEnvVars,
        projectMetadata: project.metadata,
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
      // Surface the failure to the originating channel (Slack) so the thread
      // doesn't sit on a ⏳ until the 30-min GC. No-op for non-channel sessions.
      notifySessionProvisioningFailed(sessionId, message);
    }
  })();

  return { row: sessionRow, headers: responseHeaders };
}
