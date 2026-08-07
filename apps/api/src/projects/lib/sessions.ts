import { randomUUID } from 'node:crypto';
import {
  projectSessionConnectorBindings,
  projectSessionRuntimeContexts,
  projectSessions,
} from '@kortix/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { isMetaAgentName, META_AGENT_NAME, META_SANDBOX_SLUG } from '@kortix/shared';
import { checkBillingActive } from '../../billing/services/billing-gate';
import { accountMayUseManagedModels } from '../../billing/services/entitlements';
import { type SandboxProviderName, config } from '../../config';
import { agentMayUseConnector } from '../../iam/agent-scope';
import { setContextField } from '../../lib/request-context';
import { projectLlmGatewayEnabled } from '../../llm-gateway/enablement';
import {
  isModelServableForAccount,
  resolveEffectiveModel,
} from '../../llm-gateway/resolution/default-model';
import {
  type ModelSource,
  toOpencodeModelRef,
} from '../../llm-gateway/resolution/effective';
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
  requiredConnectorsForAgent,
  resolveGovernedAgentGrant,
  sandboxFromLoadedAgents,
  workspaceFromLoadedAgents,
} from '../agents';
import { createRemoteSessionBranch, resolveCommitSha } from '../git';
import { resolveSessionSecretGrant } from './secret-grant';
import {
  AmbiguousSecretGrantError,
  intersectSecretGrants,
  listProjectSecretsSnapshotForUser,
  listResolvedProjectSecrets,
  parseSessionSecretsAllowlist,
  secretKeyCollisionInAllowlist,
} from '../secrets';
import { SECRET_CAPABILITIES_ENV_NAME } from '../secret-capabilities';
import {
  resolveCompiledAgentConfigForSession,
  resolveSelectedAgentConfigForSession,
} from './compile-agent-config';
import type { WorkspaceModeV2 } from '@kortix/manifest-schema';
import { withProjectGitAuth } from './git';
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
  canonicalConnectorAlias,
  parseSessionConnectorBindings,
  resolveRequiredConnectorConnections,
  sessionConnectorBindingsRequirePrivateVisibility,
  validateSessionConnectorBindings,
} from './session-connector-bindings';
import { sessionChannelEnvFromMetadata } from './session-channel-env';
import {
  TITLE_SOURCE_MAX_CHARS,
  generateSessionTitleFromFirstPrompt,
  titleSourceForCreate,
} from '../session-title-generate';
import { canOverride, resolveSessionOrigin } from './session-origin';
import { sessionCreatedAuditEvent } from './session-audit';
import {
  resolveSessionSandboxSlug,
  workspaceModeAllowsFullRepository,
} from './session-sandbox-metadata';
import { projectSessionMetadataMerge } from './session-metadata-merge';
import {
  buildSessionRuntimeContextEnv,
  mergeSessionSandboxEnv,
  parseSessionRuntimeContext,
} from './session-runtime-context';
import { buildSessionRuntimeEnv } from './session-runtime-env';
import {
  buildPlatformMetaOpenCodeConfig,
  projectMetaAgentEnabled,
  resolvePlatformMetaSandbox,
} from './platform-meta-agent';

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

/**
 * Resolve the concrete agent stored on a new session.
 *
 * A v2 manifest is durable project truth. `project.metadata.default_agent` is
 * only a read mirror and can lag an external git push, so it must never
 * override the manifest value. The mirror remains the legacy fallback for v1
 * projects, whose manifests do not declare a top-level default.
 */
export function resolveSessionAgentName(input: {
  requestedAgent: string | null;
  manifestDefaultAgent: string | null;
  mirroredDefaultAgent: string | null;
}): string {
  const explicit =
    input.requestedAgent && input.requestedAgent !== 'default' ? input.requestedAgent : null;
  return explicit ?? input.manifestDefaultAgent ?? input.mirroredDefaultAgent ?? 'default';
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

/** Re-derive persisted channel env so every cold reprovision restores it. */
async function buildSessionChannelEnv(sessionId: string): Promise<Record<string, string>> {
  try {
    const [row] = await db
      .select({ metadata: projectSessions.metadata })
      .from(projectSessions)
      .where(eq(projectSessions.sessionId, sessionId))
      .limit(1);
    return sessionChannelEnvFromMetadata(row?.metadata);
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
  opencodeModel?: string | null;
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
  /** The reserved platform coordinator receives no project checkout or secrets. */
  platformMetaAgent?: boolean;
  workspaceMode?: WorkspaceModeV2 | null;
}): Promise<Record<string, string>> {
  // Only user runtime secrets belong here. The sandbox-scoped KORTIX_TOKEN is
  // minted by provisionSessionSandbox() and injected at the provider boundary,
  // then reused by the daemon for both API calls and proxy HMAC validation.
  // Resolved AS the session's OWNER (createdBy, read below). This keeps personal
  // override selection consistent for server consumers without delivering the
  // value to the sandbox. Every OTHER secret is project-wide (secret
  // sharing was retired — authorization is centralized on the running agent's
  // `secrets` grant, applied below by identifier).
  let agentGrantEnv: string[] | 'all' | undefined;

  // v2-only: compile the manifest's `agents:` map into an OpenCode-native
  // config the sandbox receives sealed (see compile-agent-config.ts). `null`
  // for a v1 project (no `kortix_version: 2`) or any read/parse failure — no
  // KORTIX_COMPILED_AGENT_CONFIG key is emitted below in that case, so a v1
  // project's sandbox env is byte-for-byte unaffected by this. Gated on the
  // same `defaultBranch` presence as the `agents:` grant resolution below
  // (both need git context; optional call sites that omit it get neither).
  let compiledAgentConfig: string | null = input.platformMetaAgent
    ? buildPlatformMetaOpenCodeConfig()
    : null;
  if (input.defaultBranch && !input.platformMetaAgent) {
    const gitProject = {
      projectId: input.projectId,
      repoUrl: input.repoUrl,
      defaultBranch: input.defaultBranch,
      manifestPath: input.manifestPath ?? 'kortix.yaml',
      gitAuthToken: null,
    };
    compiledAgentConfig =
      !workspaceModeAllowsFullRepository(input.workspaceMode)
        ? await resolveSelectedAgentConfigForSession(
            gitProject,
            input.agentName,
            input.baseRef,
          )
          : await resolveCompiledAgentConfigForSession(
              gitProject,
              input.baseRef,
            ).catch(() => null);

    // Per-agent secret scoping: an agent declared in `agents:` with a `secrets`
    // allowlist receives ONLY those IDENTIFIERS — so a narrowly-scoped agent
    // can't read another scope's API keys/payment creds straight out of $ENV.
    // No-op (undefined → 'all') for back-compat grants and projects without
    // an `agents:` map or git context. This is the ONLY gate on agent secret
    // access — there is no resource-side allow-list on the secret itself.
    //
    // FAIL CLOSED: this used to `.catch(() => null)`, which collapsed a loader
    // throw into an unrestricted grant — a transient git/parse failure silently
    // handed the session every project secret. It now throws
    // SecretGrantResolutionError and the provision fails instead. Shares one
    // resolver with the per-prompt hot push (lib/secret-grant.ts) so the two
    // paths can no longer disagree about what this agent may read.
    agentGrantEnv = await resolveSessionSecretGrant({
      projectId: input.projectId,
      repoUrl: input.repoUrl,
      defaultBranch: input.defaultBranch,
      manifestPath: input.manifestPath,
      sessionAgent: input.agentName,
    });
  }

  // Per-session secret policy, read by sessionId inside the builder so all three
  // call sites (create, restart, open/ensure) are covered — no caller can
  // forget them. `secretsAllowlist` NARROWS the agent grant to (grant) ∩ (list)
  // so a backend-vouched session only receives the secrets the wrapper named
  // (null → passthrough, byte-identical to pre-KaaB).
  const [sessionPolicyRow] = await db
    .select({
      secretsAllowlist: projectSessions.secretsAllowlist,
      createdBy: projectSessions.createdBy,
    })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, input.sessionId))
    .limit(1);
  const grantEnvForSession = input.platformMetaAgent
    ? []
    : intersectSecretGrants(agentGrantEnv, sessionPolicyRow?.secretsAllowlist ?? null);

  // The secrets principal is the session's OWNER (`createdBy`), read here by
  // sessionId — NOT `input.userId`, which is whoever is provisioning this run.
  // On create those coincide, but restart/open/ensure-runtime provision on
  // behalf of any project manager/admin, and a per-user secret override (today
  // CODEX_AUTH_JSON) resolves per principal (`listResolvedProjectSecrets`). If a
  // manager restarted another member's session we'd inject the MANAGER's personal
  // secret at boot, which the first prompt's hot-push (`resolveOwnerRawEnv`, keyed
  // on `createdBy`) would then clobber back — a cross-principal bleed + flip-flop.
  // Deriving the principal from `createdBy` here unifies all three provisioning
  // paths with hot-push and the admin provider-migrate path. Falls back to
  // `input.userId` only if the row somehow isn't found (create races its own row
  // in some callers). The agent grant — not the human — remains the authority on
  // WHICH identifiers are eligible; this only picks the per-user override owner.
  const secretsPrincipalUserId = sessionPolicyRow?.createdBy ?? input.userId;

  let runtimeSecrets: {
    env: Record<string, string>;
    names: string[];
    revision: string;
    capabilitiesJson: string;
  };
  try {
    runtimeSecrets = await listProjectSecretsSnapshotForUser(
      input.projectId,
      secretsPrincipalUserId,
      grantEnvForSession,
      // Non-`runtime` rows are delivered as a per-session handle, so the
      // chokepoint needs the session this env is being built FOR. Without it it
      // withholds them rather than falling back to plaintext.
      input.sessionId,
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
  // shim now runs every Web API call through the Connector (server-side token)
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
    [SECRET_CAPABILITIES_ENV_NAME]: runtimeSecrets.capabilitiesJson,
    // Runtime-delivered provider keys may reach the sandbox for user code.
    // OpenCode must not receive them because it would bypass the gateway.
    KORTIX_OPENCODE_DENY_ENV: input.llmGatewayEnabled ? nativeProviderEnvNames().join(',') : '',
    // No partial-clone filter. Blobless (`blob:none`) defers file blobs to
    // on-demand fetches, which stall through the Kortix git proxy when its
    // partial-clone capability isn't advertised consistently — the clone then
    // never finishes and the session never reaches runtimeReady. It is also
    // simply slower: measured on kortix-ai/company, blobless 6161ms vs a full
    // clone's 4288ms.
    //
    // Shallowness is the safe lever instead (KORTIX_CLONE_DEPTH=1, the daemon
    // default): one pack, one commit, no on-demand fetches, with history
    // restored in the background right after boot (scheduleHistoryBackfill).
    // It is worth ~1.5x on the clone, no more — the dominant cost is the
    // working tree plus the transatlantic git-proxy hop (sandbox US → API
    // eu-west-2 → GitHub US). See
    // docs/specs/2026-07-25-session-boot-latency-attribution.md, Finding 1.
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
      // Concrete session model after explicit → agent → project → account →
      // platform resolution. The sandbox uses it for the first OpenCode turn
      // and as the session's OpenCode config default.
      opencodeModel: input.opencodeModel,
      compiledAgentConfig,
      workspaceMode: input.workspaceMode,
    }),
    // The platform coordinator uses API-level delegation and never receives a
    // project checkout. Keep this override after buildSessionRuntimeEnv so the
    // agent workspace mode cannot re-enable the daemon's automatic clone.
    ...(input.platformMetaAgent
      ? { KORTIX_PROJECT_AUTO_CLONE: '0', KORTIX_META_AGENT: '1' }
      : {}),
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
 * Cloud sandboxes reach the control plane over the public internet via
 * `$KORTIX_API_URL`. A loopback/unspecified host is never reachable from
 * inside a remote sandbox, so a session booted against one is
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
  requestingPrincipalType: 'human' | 'service_account';
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
  /**
   * Caller's token kind (auth.ts `authType`), its apiKeyType (user | sandbox,
   * for authType==='apiKey'), and whether the token operates from inside a
   * running session (`inSession`: session-bound or agent-scoped). Combined with
   * the invocation source these derive the session ORIGIN — never trusted from
   * the body. A programmatic customer credential (service_account, pat, or a
   * 'user' apiKey) that is NOT in-session resolves to 'backend' and may set
   * backend-only override fields. See session-origin.ts.
   */
  authType?: string | null;
  apiKeyType?: string | null;
  inSession?: boolean | null;
  /** The caller's own session when the credential is session-bound (the
   *  connector PAT injected into a sandbox). Used only to stop meta→meta
   *  recursion — a meta coordinator must spawn project agents, not itself. */
  callerSessionId?: string | null;
  /** The request-time capability verdict for operator-managed (non-member)
   * connections. Personal connections ignore this and remain owner-only. */
  mayManageSystemConnections?: boolean;
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

  // `inherit_unbound` is a benign binding modifier: when this session binds any
  // connector, unbound aliases keep resolving to the PROJECT DEFAULT instead of
  // failing closed. It can only ever inherit the project default (never another
  // owner's connection), so unlike secrets it is NOT origin-gated.
  //
  // An ABSENT `inherit_unbound` defaults to `true`. A session that binds SOME
  // connectors keeps the project-default fallback for the rest unless the caller
  // EXPLICITLY opts into fail-closed with `inherit_unbound: false` (the
  // composer's "I picked these specific connections, turn the others off"
  // signal). Defaulting absent→true matches the re-scope path (r7.ts), which
  // deliberately never flips this flag on a scope save. Before this, a caller
  // sending `connector_bindings: {...}` without `inherit_unbound` left it
  // `false`, hiding EVERY unbound connector from `kortix connectors ls`
  // / `kortix connectors call` — the whole catalog went empty.
  let inheritUnbound = body.inherit_unbound !== false;
  const connectorBindingsConfigured = body.connector_bindings !== undefined;
  const requireConnectors: string[] = Array.isArray(body.require_connectors)
    ? body.require_connectors.filter((a): a is string => typeof a === 'string' && a.length > 0)
    : [];

  // Origin is a POLICY CLASS derived from the caller's token kind (authType)
  // + invocation source (metadata.source), NEVER the body. It gates which
  // override fields the caller may set.
  const origin = resolveSessionOrigin({
    authType: input.authType,
    apiKeyType: input.apiKeyType,
    inSession: input.inSession,
    source: (input.metadata as Record<string, unknown> | undefined)?.source as string | undefined,
  });
  // Backend-only per-session secrets allowlist. Presence-gate on the raw body
  // FIRST (a non-backend caller that even mentions the field is rejected, before
  // shape is considered), then validate shape, then existence — narrowing the
  // sandbox env to (agent grant) ∩ (this list). `[]` = inject zero secrets.
  if (body.secrets !== undefined && !canOverride(origin, 'secrets')) {
    return {
      error: {
        status: 403,
        body: {
          error:
            'secrets may only be set by a backend-origin session — authenticate with an API key / PAT or a service-account bearer',
          code: 'origin_override_forbidden',
        },
      },
    };
  }
  const parsedSecrets = parseSessionSecretsAllowlist(body.secrets);
  if (!parsedSecrets.ok) {
    return {
      error: { status: 400, body: { error: parsedSecrets.error, code: 'INVALID_SESSION_SECRETS' } },
    };
  }
  const secretsAllowlist = parsedSecrets.value ?? null;
  if (secretsAllowlist && secretsAllowlist.length > 0) {
    const resolvedProjectSecrets = await listResolvedProjectSecrets(projectId, userId);
    // Every allowlisted identifier must name an existing runtime secret in the
    // project (KORTIX_*/connector rows are already excluded by the resolver), so
    // a typo fails fast at create rather than silently injecting nothing.
    const known = new Set(resolvedProjectSecrets.map((r) => r.identifier.toUpperCase()));
    const missing = secretsAllowlist.filter((id) => !known.has(id.toUpperCase()));
    if (missing.length > 0) {
      return {
        error: {
          status: 404,
          body: {
            error: `unknown secret identifier(s): ${missing.join(', ')}`,
            code: 'SECRET_IDENTIFIER_NOT_FOUND',
          },
        },
      };
    }
    // Reject a KEY collision at create — two allowlisted identifiers resolving to
    // one env KEY throw AmbiguousSecretGrantError at boot, and the immutable
    // allowlist would leave the session permanently unbootable.
    const collision = secretKeyCollisionInAllowlist(resolvedProjectSecrets, secretsAllowlist);
    if (collision) {
      return {
        error: {
          status: 409,
          body: {
            error: `secrets allowlist names multiple identifiers for env key "${collision.key}": ${collision.identifiers.join(', ')}`,
            code: 'SECRET_IDENTIFIER_KEY_COLLISION',
          },
        },
      };
    }
  }

  const baseRef = normalizeString(body.base_ref ?? body.baseRef) ?? project.defaultBranch;
  const loadedAgents = await loadProjectAgents(project, {
    forceRefresh: true,
    rethrowReadErrors: true,
  });
  // The literal "default" is a non-binding legacy sentinel. It must not block
  // the configured project default. This rule applies to every caller,
  // including older triggers and channel adapters that still send the sentinel.
  const requestedAgent = normalizeString(body.agent_name ?? body.agentName);
  const mirroredDefaultAgent = normalizeString(
    (project.metadata as Record<string, unknown> | null | undefined)?.default_agent,
  );
  const projectDefaultAgent = normalizeString(loadedAgents.defaultAgent) ?? mirroredDefaultAgent;
  // The meta coordinator is a per-project experimental opt-in
  // (`meta_agent`). Flag off: agent resolution below is byte-for-byte the
  // pre-meta behavior, and an explicit "meta" request is an ordinary (unknown)
  // agent name.
  const metaAgentEnabled = projectMetaAgentEnabled(project.metadata);
  // Meta→meta recursion stop. Anyone — dashboard users included — may spawn
  // the meta coordinator, and an omitted agent still defaults to it. The one
  // exception is a caller that IS a meta session: its omitted agent resolves
  // to the project default (the observed failure was meta "spawning a worker"
  // and getting another coordinator), and an explicit meta request is
  // rejected.
  let callerIsMeta = false;
  if (metaAgentEnabled && input.callerSessionId) {
    const [caller] = await db
      .select({ agentName: projectSessions.agentName })
      .from(projectSessions)
      .where(
        and(
          eq(projectSessions.sessionId, input.callerSessionId),
          eq(projectSessions.projectId, projectId),
        ),
      )
      .limit(1);
    callerIsMeta = !!caller && isMetaAgentName(caller.agentName);
  }
  const agentName =
    metaAgentEnabled && !requestedAgent && !callerIsMeta
      ? META_AGENT_NAME
      : resolveSessionAgentName({
          requestedAgent,
          manifestDefaultAgent: normalizeString(loadedAgents.defaultAgent),
          mirroredDefaultAgent,
        });
  const platformMetaAgent = metaAgentEnabled && isMetaAgentName(agentName);
  if (platformMetaAgent && callerIsMeta) {
    return {
      error: {
        status: 400,
        body: {
          error:
            'The meta coordinator cannot spawn another meta coordinator — pick a project agent',
          code: 'META_AGENT_RECURSION',
        },
      },
    };
  }
  const workspaceMode = workspaceFromLoadedAgents(agentName, loadedAgents) ?? 'branch';
  if (workspaceMode === 'read') {
    return {
      error: {
        status: 409,
        body: {
          error: 'workspace mode "read" requires restricted workspace artifacts',
          code: 'WORKSPACE_MODE_UNAVAILABLE',
        },
      },
    };
  }

  const freeModelsOnly = !(await accountMayUseManagedModels(accountId));
  const llmGatewayEnabled = projectLlmGatewayEnabled(project.metadata);

  // Model: normalize + fail-fast at create. An unservable / retired / typo'd
  // model pin was previously stored verbatim and only failed at prompt time (a
  // dead turn); a bare managed id (`claude-opus-4-8`) silently dropped to the
  // daemon's default because opencode addresses managed models as `kortix/<id>`.
  // Validate against the same servability resolver the gateway uses, and store
  // the OPENCODE ref form. Runs BEFORE the billing hold so a bad model never
  // costs a credit reservation. Mirrors the channel-model gate
  // (routes/channel-bindings.ts) and the plan's §4.7 fail-fast.
  const requestedModel = normalizeString(body.opencode_model ?? body.opencodeModel);
  let opencodeModel: string | null = null;
  let opencodeModelSource: ModelSource | null = null;
  if (requestedModel) {
    if (/\s/.test(requestedModel)) {
      return {
        error: {
          status: 400,
          body: { error: `"${requestedModel}" doesn't look like a model id`, code: 'INVALID_SESSION_MODEL' },
        },
      };
    }
    const servable = await isModelServableForAccount({
      userId,
      accountId,
      projectId,
      freeModelsOnly,
      model: requestedModel,
    });
    if (!servable) {
      return {
        error: {
          status: 400,
          body: {
            error: `Model "${requestedModel}" is not available for this account`,
            code: 'INVALID_SESSION_MODEL',
          },
        },
      };
    }
    opencodeModel = toOpencodeModelRef(requestedModel);
    opencodeModelSource = 'explicit';
  } else if (llmGatewayEnabled) {
    try {
      const resolved = await resolveEffectiveModel({
        userId,
        accountId,
        projectId,
        agentName,
        explicit: null,
        freeModelsOnly,
      });
      const concreteModel =
        resolved.model ??
        (!freeModelsOnly ? config.LLM_GATEWAY_DEFAULT_MODEL : null);
      if (concreteModel) {
        opencodeModel = toOpencodeModelRef(concreteModel);
        opencodeModelSource = resolved.model ? resolved.source : 'platform';
      }
    } catch (error) {
      console.error('[projects] Failed to resolve the session default model:', error);
      return {
        error: {
          status: 503,
          body: {
            error: 'The session default model could not be resolved',
            code: 'SESSION_MODEL_RESOLUTION_FAILED',
          },
        },
      };
    }
  }

  const agentRequiredConnectors = platformMetaAgent
    ? []
    : requiredConnectorsForAgent(agentName, loadedAgents);
  const effectiveRequireConnectors = Array.from(
    new Set<string>([...requireConnectors, ...agentRequiredConnectors]),
  );

  // Every connector this session touches — whether the caller bound it explicitly
  // or the agent requires it — must be granted to the session's agent.
  const grantCheckAliases = new Set<string>([
    ...(parsedConnectorBindings.bindings ? Object.keys(parsedConnectorBindings.bindings) : []),
    ...effectiveRequireConnectors,
  ]);
  let loadedAgentGrant: ReturnType<typeof grantFromLoadedAgents> | undefined;
  if (grantCheckAliases.size > 0) {
    loadedAgentGrant = grantFromLoadedAgents(agentName, loadedAgents);
    for (const alias of grantCheckAliases) {
      if (!agentMayUseConnector(loadedAgentGrant, canonicalConnectorAlias(alias))) {
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
    actingUserId: userId,
    actingPrincipalIsServiceAccount: input.requestingPrincipalType === 'service_account',
    mayManageSystemConnections: input.mayManageSystemConnections ?? false,
    bindings: parsedConnectorBindings.bindings,
  });
  if (!validatedConnectorBindings.ok) {
    return {
      error: {
        status: validatedConnectorBindings.code === 'CONNECTOR_CONNECTION_NOT_FOUND' ? 404 : 409,
        body: {
          error: validatedConnectorBindings.error,
          code: validatedConnectorBindings.code,
        },
      },
    };
  }
  if (effectiveRequireConnectors.length > 0) {
    const required = await resolveRequiredConnectorConnections({
      accountId,
      projectId,
      actingUserId: userId,
      actingPrincipalIsServiceAccount: input.requestingPrincipalType === 'service_account',
      aliases: effectiveRequireConnectors,
      explicitBindings: validatedConnectorBindings.bindings,
    });
    if (!required.ok) {
      if (required.code === 'REQUIRED_CONNECTOR_CONNECTION_UNAVAILABLE') {
        return {
          error: {
            status: 409,
            body: {
              error: `Required ${required.aliases.length === 1 ? 'connection' : 'connections'} ${required.aliases
                .map((alias) => `"${alias}"`)
                .join(', ')} ${required.aliases.length === 1 ? 'is' : 'are'} unavailable`,
              code: required.code,
              // The prose names the aliases too, but a client that wants to list
              // them (or diff them across retries) must not have to parse it.
              connectors: required.aliases,
            },
          },
        };
      }
      return {
        error: {
          status: 409,
          body: {
            code: required.code,
            message: 'Create the required connections before starting this session.',
            connector_connections: required.connectorConnections,
          },
        },
      };
    }
    const boundAliases = new Set(validatedConnectorBindings.bindings.map((b) => b.alias));
    for (const binding of required.bindings) {
      if (!boundAliases.has(binding.alias)) validatedConnectorBindings.bindings.push(binding);
    }
    if (!connectorBindingsConfigured) inheritUnbound = true;
  }
  if (
    visibility !== 'private' &&
    sessionConnectorBindingsRequirePrivateVisibility(validatedConnectorBindings.bindings)
  ) {
    return {
      error: {
        status: 409,
        body: {
          error: 'Sessions using a personal connection must remain private',
          code: 'PERSONAL_CONNECTOR_CONNECTION_REQUIRES_PRIVATE_SESSION',
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
  // `.catch` in session-sandbox.ts `mintConnectorToken`, which must stay
  // fail-safe for NON-subject projects). Non-subject projects take the exact
  // same path as before this flag existed (zero added I/O, zero behavior change).
  if (
    !platformMetaAgent &&
    projectRequiresDeclaredAgents(project.metadata, config.KORTIX_REQUIRE_DECLARED_AGENTS)
  ) {
    const governed = resolveGovernedAgentGrant(agentName, loadedAgents, {
      subject: true,
      projectDefaultAgent,
    });
    if (!governed.ok) {
      return { error: { status: 400, body: { error: governed.error, code: governed.code } } };
    }
  }
  // Explicit request wins. The selected agent environment is next. The
  // project default and platform default remain the final fallbacks.
  const projectDefaultSandboxSlug = normalizeString(
    (project.metadata as Record<string, unknown> | null | undefined)?.default_sandbox_slug,
  );
  const requestedSandboxSlug = normalizeString(body.sandbox_slug ?? body.sandboxSlug);
  let sandboxSlug: string;
  if (platformMetaAgent) {
    // The meta coordinator is locked to its own sandbox. An explicit request for
    // any other slug is the only failure here, so scope the catch to this branch.
    try {
      sandboxSlug = resolvePlatformMetaSandbox(requestedSandboxSlug);
    } catch {
      return {
        error: {
          status: 400,
          body: {
            error: `Agent "meta" always uses sandbox "${META_SANDBOX_SLUG}"`,
            code: 'META_SANDBOX_LOCKED',
          },
        },
      };
    }
  } else {
    sandboxSlug = resolveSessionSandboxSlug({
      explicit: requestedSandboxSlug,
      agent: sandboxFromLoadedAgents(agentName, loadedAgents),
      project: projectDefaultSandboxSlug,
    });
  }
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
  if (!platformMetaAgent && sandboxSlug && sandboxSlug !== DEFAULT_SANDBOX_SLUG) {
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
          // Lets the client tell a genuinely-free/no-plan account ("subscribe")
          // from a paying Team account whose wallet ran dry ("top up") instead
          // of pitching the Free plan to a Team account. See web error-handler.
          billing_model: billingCheck.billingModel,
          has_subscription: billingCheck.hasSubscription,
          // The unambiguous state — the one field a client should branch on.
          billing_state: billingCheck.billingState,
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
  const pendingPrompt =
    body.pending_prompt &&
    typeof body.pending_prompt === 'object' &&
    !Array.isArray(body.pending_prompt) &&
    typeof (body.pending_prompt as Record<string, unknown>).text === 'string'
      ? (body.pending_prompt as Record<string, unknown>)
      : null;
  const sessionName = normalizeString(body.name);
  // An explicit `title_source` means the baked prompt is a rendered envelope
  // (Slack/Teams/Telegram turn instructions + workspace/channel ids) and these
  // are the user's actual words. Store it so a LATER fallback hook — which only
  // ever sees the envelope — titles from the same clean text the create hook
  // would have used, instead of leaking the scaffolding into a project-visible
  // title when this create-time attempt fails.
  const explicitTitleSource = normalizeString(body.title_source ?? body.titleSource);
  const requestMetadata = normalizeJsonObject(body.metadata);
  const metadata = {
    ...requestMetadata,
    ...(sessionName ? { name: sessionName } : {}),
    ...(initialPrompt ? { initial_prompt: initialPrompt } : {}),
    ...(pendingPrompt ? { pending_prompt: pendingPrompt } : {}),
    ...(explicitTitleSource
      ? { title_source: explicitTitleSource.slice(0, TITLE_SOURCE_MAX_CHARS) }
      : {}),
    ...(opencodeModel ? { opencode_model: opencodeModel } : {}),
    ...(opencodeModelSource ? { opencode_model_source: opencodeModelSource } : {}),
    ...(input.metadata ?? {}),
    // Persist the coordinator→worker link. The sidebar badges child sessions
    // with it, and the turn-end deadline shortener stops child sandboxes on a
    // tight grace so finished workers don't idle at full compute.
    ...(input.callerSessionId ? { spawned_by_session: input.callerSessionId } : {}),
    workspace_mode: workspaceMode,
    sandbox_slug: sandboxSlug,
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
        // Do not set opencodeSessionId during wrapper-session creation.
        // Runtime root discovery persists it only after OpenCode creates its root.
        agentName,
        status: 'provisioning',
        // Sessions are private to their creator by default; share via the
        // session-header control (visibility = project | restricted).
        createdBy: userId,
        visibility,
        origin,
        secretsAllowlist,
        // What the CALLER declared for this session, stored so every later check
        // can see it. It used to be read once at create and dropped, which left
        // both the warm-claim re-check and every subsequent prompt blind to it —
        // and left an unconnected connector with nowhere to be recorded at all.
        // Only the caller's own list: the agent's manifest half is re-derived per
        // prompt so a manifest change takes effect without a new session.
        requiredConnectors: requireConnectors.length > 0 ? requireConnectors : null,
        connectorBindingsConfigured,
        connectorBindingsInheritUnbound: inheritUnbound,
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
              connectionId: binding.connectionId,
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
    // Session, context and connection bindings are one transaction. Nothing is
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

  setContextField('sessionId', sessionId);

  try {
    await recordAuditEvent(
      sessionCreatedAuditEvent({
        accountId,
        projectId,
        sessionId,
        actorUserId: userId,
        requestingPrincipalType: input.requestingPrincipalType,
        inSession: input.inSession,
        origin,
        invocationSource:
          typeof (input.metadata as Record<string, unknown> | undefined)?.source === 'string'
            ? ((input.metadata as Record<string, unknown>).source as string)
            : null,
        agentName,
        visibility,
        sandboxProvider: providerName,
        connectorBindingCount: validatedConnectorBindings.bindings.length,
        secretAllowlistCount: secretsAllowlist?.length ?? 0,
      }),
    );
  } catch (error) {
    console.error('[projects] Failed to record session creation audit event:', error);
  }

  // A prompt supplied at create is baked into KORTIX_INITIAL_PROMPT and runs
  // inside the box — it never crosses the API again, so this is the only moment
  // it can be titled. No modelHint: the row already carries `opencode_model`.
  const titleSource = titleSourceForCreate(body);
  if (titleSource) {
    void generateSessionTitleFromFirstPrompt({
      sessionId,
      projectId,
      accountId,
      userId,
      firstPromptText: titleSource,
    });
  }

  // Fire-and-forget sandbox provisioning. The dashboard polls the sandbox
  // status endpoint and shows the ConnectingScreen during the long tail.
  void (async () => {
    const tl = new ProvisionTimeline(sessionId, 'session-create');
    try {
      // Resolve git auth and user env concurrently. Git auth is needed for
      // background freshness checks / remote branch publishing, but a warm
      // session can boot from an existing ready snapshot without waiting for it.
      const projectWithGitAuthPromise = withProjectGitAuth(project).then((gitProject) => {
        tl.mark('git-auth');
        return gitProject;
      });
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
          opencodeModel,
          llmGatewayEnabled,
          platformMetaAgent,
          freshSession: true,
          baseSha,
          defaultBranch: project.defaultBranch,
          manifestPath: project.manifestPath,
          workspaceMode,
        }),
        )
        .then((envVars) => {
        tl.mark('env-vars');
        return envVars;
      });

      const mergeSessionMetadata = async (extra: Record<string, unknown>) => {
        await db
          .update(projectSessions)
          .set({
            metadata: projectSessionMetadataMerge(extra),
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
        agentName,
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
        resolveGitProject: async () => projectWithGitAuthPromise,
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
            // Merge, never re-write the create-time snapshot: by the time
            // provisioning fails the row may already carry a generated title,
            // remote_branch or the start timeline.
            metadata: projectSessionMetadataMerge({ provisioning_error: message }),
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
