import { randomUUID } from 'node:crypto';
import { SessionCreateInputSchema } from '@kortix/api-contract';
import { projectSessionConnectorBindings, projectSessionGrants, projectSessionRuntimeContexts, projectSessions, sessionLifecycleCommands, sessionProviderSecretPools } from '@kortix/db';
import { and, eq, isNull } from 'drizzle-orm';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { isMetaAgentName, META_AGENT_NAME, META_SANDBOX_SLUG, PI_WORKER_SANDBOX_SLUG } from '@kortix/shared';
import { checkBillingAdmission } from '../../billing/services/billing-gate';
import { accountMayUseManagedModels } from '../../billing/services/entitlements';
import { type SandboxProviderName, config } from '../../config';


import { agentMayUseConnector, agentMayUseEnv } from '../../iam/agent-scope';
import { usableProviderKeys } from '../../secrets/provider-key-selection';
import { decideSessionOnBehalfOf } from './on-behalf-of';
import {
  loadSessionGrants,
  resolveInheritedSessionSharing,
  type SecretGrant,
  type SessionVisibility,
} from '../../connectors/share';
import { setContextField } from '../../lib/request-context';
import { projectLlmGatewayEnabled } from '../../llm-gateway/enablement';
import { platformDefaultModelId } from '../../llm-gateway/models/served-managed-models';
import {
  isModelServableForAccount,
  resolveEffectiveModel,
} from '../../llm-gateway/resolution/default-model';
import {
  type ModelSource,
  toOpencodeModelRef,
} from '../../llm-gateway/resolution/effective';

import { sandboxFrontendBaseUrl } from '../../platform/sandbox-frontend-url';
import { selectProvider } from '../../platform/services/provider-balancer';
import { ProvisionTimeline } from '../../platform/services/provision-timeline';
import { provisionSessionSandbox } from '../../platform/services/session-sandbox';
import { resolveSessionSandboxRegion } from '../../platform/services/sandbox-region';
import { WARM_SESSION_LOCATION_KEY, WARM_SESSION_METADATA_KEY } from './warm-sessions';


import { db } from '../../shared/db';
import { notifySessionProvisioningFailed } from '../../shared/session-failure-notifier';
import { DEFAULT_SANDBOX_SLUG, resolveTemplate } from '../../snapshots/builder';
import {
  grantFromLoadedAgents,
  loadProjectAgents,
  projectRequiresDeclaredAgents,
  resolveGovernedAgentGrant,
  sandboxFromLoadedAgents,
  repositoryAccessFromLoadedAgents,
  legacyReadWorkspaceFromLoadedAgents,
} from '../agents';
import { createRemoteSessionBranch , resolveCommitSha } from '../git';
import { convertPendingPromptToInboxRow } from '../session-lifecycle/pending-prompt';

import { validateNativeOpencodeModelRef } from './session-model-change';
import { listResolvedProjectSecrets, parseSessionSecretsAllowlist, secretKeyCollisionInAllowlist } from '../secrets';


import { resolveManifestRuntime } from './compile-agent-config';
import { withProjectGitAuth } from './git';
import { repositoryGeneration } from './repository-generation';
import { resolveFastBootGitHintWithCache } from './fast-boot-git-hint';
import { resolveSessionProvider, sessionProviderIsLocked } from './provider-precedence';

import { type ProjectRow, type ProjectSessionRow, type RequestAuditContext, normalizeString } from './serializers';
import { normalizeJsonObject } from '../../shared/json';
import { isUuid } from '../../shared/validate';
import {
  canonicalConnectorAlias,
  parseSessionConnectorBindings,
  sessionConnectorBindingsRequirePrivateVisibility,
  validateSessionConnectorBindings,
} from './session-connector-bindings';

import {
  TITLE_SOURCE_MAX_CHARS,
  generateSessionTitleFromFirstPrompt,
  titleSourceForCreate,
} from '../session-title-generate';
import { prepareInitialSandboxTurn } from '../session-turn-ledger';
import { canOverride, inheritParentOrigin, resolveSessionOrigin } from './session-origin';
import { resolveRootSessionInitiator, type SessionInitiator } from './session-initiator';
import { sessionCreatedAuditAttribution } from './session-audit';
import {
  projectImageAllowedForSession,
  resolveSessionSandboxSlug,
} from './session-sandbox-metadata';
import { projectSessionMetadataMerge } from './session-metadata-merge';
import { transitionSession } from '../session-lifecycle/status-transitions';
import { mergeSessionSandboxEnv, parseSessionRuntimeContext } from './session-runtime-context';
import { resolveFeatureFlag } from '../../feature-flags/registry';
import { buildPiWorkerSessionEnvVars } from './session-runtime-env';
import { resolvePlatformMetaSandbox } from './platform-meta-agent';
import { prebuildCompiledBootArtifacts } from '../../git-proxy/compiled-prebuild';

import {
  resolveProjectSnapshotMode,
  resolveProjectSnapshotPinForSession,
} from '../../git-proxy/project-snapshot';

import { checkConcurrentSessionCap } from './session-caps';
import { buildSessionSandboxEnvVars, deriveKortixApiBase, proxyGitUrl } from './session-sandbox-env-build';
import { sandboxCallbackUnreachableReason, sandboxCallbackDeadTunnelReason } from './session-callback-probe';
export type SessionCreateError = {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
};

export function sendSessionCreateError(c: Context, error: SessionCreateError) {
  for (const [key, value] of Object.entries(error.headers ?? {})) c.header(key, value);
  return c.json(error.body, error.status as any);
}

/** The fields postgres.js attaches to a `Failed query:` error (pg error codes). */
type PostgresErrorFields = {
  code?: string;
  constraint?: string;
  detail?: string;
  table?: string;
  column?: string;
  message?: string;
};

/**
 * Map a failure of the session-insert transaction to an HTTP error body.
 *
 * A postgres.js error's `message` embeds the FULL SQL statement and EVERY bound
 * parameter value (attachment filenames, model config, opaque ids). Returning
 * that message to the client leaked customer data into the caller's error
 * tracker as an opaque `ApiError` (Better Stack pattern `9aecd4f8…`) and hid the
 * cause, which the old `catch` never logged. Log the real cause server-side
 * here, and return a stable, non-leaking body the caller can branch on.
 *
 * A `23505` unique violation on the session PK means the caller retried a
 * create with a `session_id` that already exists; that is an idempotent race,
 * not a defect, so it maps to a typed 409.
 */
export function resolveSessionInsertFailure(error: unknown): SessionCreateError {
  const pg = (error ?? {}) as PostgresErrorFields;
  // postgres.js appends the bound parameter values after "\nparams:" in the
  // message. Keep the statement (column names only) and drop the values, so the
  // server log identifies the failing insert without duplicating customer data.
  const message = (pg.message ?? String(error)).split('\nparams:')[0];
  console.error('[projects] session insert failed', {
    pgCode: pg.code ?? null,
    constraint: pg.constraint ?? null,
    table: pg.table ?? null,
    column: pg.column ?? null,
    detail: pg.detail ?? null,
    message,
  });
  if (pg.code === '23505') {
    return {
      status: 409,
      body: { error: 'A session with this id already exists', code: 'session_already_exists' },
    };
  }
  return {
    status: 500,
    body: { error: 'Failed to create session', code: 'SESSION_CREATE_FAILED', retry: true },
  };
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

/**
 * Read the SPAWNING session, scoped to the same account and project as the
 * session being created. A stale or cross-project caller id (should not happen;
 * defense in depth) returns null: the new session is then a root, and takes
 * the caller's normal defaults instead of inheriting anything.
 */
async function loadParentSession(
  callerSessionId: string,
  accountId: string,
  projectId: string,
): Promise<{
  sessionId: string;
  visibility: SessionVisibility;
  origin: string;
  initiator: SessionInitiator | null;
} | null> {
  const [parent] = await db
    .select({
      visibility: projectSessions.visibility,
      projectId: projectSessions.projectId,
      origin: projectSessions.origin,
      initiatorType: projectSessions.initiatorType,
      initiatorId: projectSessions.initiatorId,
    })
    .from(projectSessions)
    .where(and(eq(projectSessions.sessionId, callerSessionId), eq(projectSessions.accountId, accountId)))
    .limit(1);
  if (!parent || parent.projectId !== projectId) return null;
  return {
    sessionId: callerSessionId,
    visibility: parent.visibility as SessionVisibility,
    origin: parent.origin,
    initiator: parent.initiatorType ? { type: parent.initiatorType, id: parent.initiatorId } : null,
  };
}

async function loadParentSessionGrants(
  parent: { sessionId: string; visibility: SessionVisibility },
): Promise<{ visibility: SessionVisibility; grants: SecretGrant[] }> {
  if (parent.visibility !== 'restricted') return { visibility: parent.visibility, grants: [] };
  const grants = (await loadSessionGrants([parent.sessionId])).get(parent.sessionId) ?? [];
  return { visibility: parent.visibility, grants };
}

export async function createProjectSession(input: {
  attachmentSourceCommandId?: string;
  /** The `create_session` command to link the new session to, atomically. */
  createCommandId?: string;
  project: ProjectRow;
  userId: string;
  requestingPrincipalType: 'human' | 'service_account';
  body: Record<string, unknown>;
  enforceAccountCap?: boolean;
  /**
   * Concurrent-session slots this create must LEAVE FREE. Defaults to 0 — an
   * ordinary create may take the last slot. Speculative creation passes 1; see
   * `enforceConcurrentSessionCap`.
   */
  reserveConcurrentSlots?: number;
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
  pendingPromptIdempotencyKey?: string | null;
}> {
  const { project, userId, body } = input;
  const projectId = project.projectId;
  const accountId = project.accountId;
  // A session spawned by ANOTHER running session (a sub-agent/coordinator
  // worker, via that session's own bound token) inherits the SPAWNING
  // session's sharing instead of defaulting to private — see
  // resolveInheritedSessionSharing. Automation callers (triggers, channels)
  // always pass `visibility` explicitly, so the lookup is skipped for them.
  const parentSession = input.callerSessionId
    ? await loadParentSession(input.callerSessionId, accountId, projectId)
    : null;
  const parentSharing =
    input.visibility === undefined && parentSession ? await loadParentSessionGrants(parentSession) : null;
  const { visibility, grants: inheritedGrants } = resolveInheritedSessionSharing(
    input.visibility,
    parentSharing,
  );
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
  // signal). Defaulting absent→true matches the re-scope path (routes/session-scope.ts), which
  // deliberately never flips this flag on a scope save. Before this, a caller
  // sending `connector_bindings: {...}` without `inherit_unbound` left it
  // `false`, hiding EVERY unbound connector from `kortix connectors ls`
  // / `kortix connectors call` — the whole catalog went empty.
  let inheritUnbound = body.inherit_unbound !== false;
  const connectorBindingsConfigured = body.connector_bindings !== undefined;

  // Origin is a POLICY CLASS derived from the caller's token kind (authType)
  // + invocation source (metadata.source), NEVER the body. It gates which
  // override fields the caller may set.
  const origin = inheritParentOrigin(
    resolveSessionOrigin({
      authType: input.authType,
      apiKeyType: input.apiKeyType,
      inSession: input.inSession,
      source: (input.metadata as Record<string, unknown> | undefined)?.source as string | undefined,
    }),
    parentSession?.origin,
  );
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
    // The creator's own audience: a value shared only with them is a valid
    // allowlist entry. Delivery re-applies the session's audience at boot.
    const resolvedProjectSecrets = await listResolvedProjectSecrets(projectId, userId, {
      personId: userId,
      agentId: null,
    });
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
    // The same freshness the per-prompt grant read asks for (`MirrorRefresh`):
    // no `ls-remote` when the branch tip was proven inside the interval.
    forceRefresh: 'tip-proof',
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
  const metaAgentEnabled = resolveFeatureFlag(project.metadata, 'meta_agent');
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
  const repositoryAccess = repositoryAccessFromLoadedAgents(agentName, loadedAgents);
  if (legacyReadWorkspaceFromLoadedAgents(agentName, loadedAgents)) {
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
  const pooledProviderSecrets = resolveFeatureFlag(project.metadata, 'pooled_provider_secrets');
  if (body.provider_secret_pools !== undefined && (!pooledProviderSecrets || !llmGatewayEnabled)) {
    return { error: { status: 403, body: { error: 'Provider secret pools are unavailable' } } };
  }
  // The key selection this session starts with: the caller's, or the one
  // chosen below for a model that runs only on pooled keys.
  let providerSecretPools = body.provider_secret_pools as Record<string, string[]> | undefined;

  // Model: normalize + fail-fast at create. Two paths, forked on the project's
  // `llm_gateway` flag:
  //
  //  • gateway ON — validate against the same servability resolver the gateway
  //    uses and store the OPENCODE ref form (`kortix/<wire>`). An unservable /
  //    retired / typo'd pin previously only failed at prompt time (a dead
  //    turn); a bare managed id (`claude-opus-4-8`) silently dropped to the
  //    daemon's default because opencode addresses managed models as
  //    `kortix/<id>`.
  //  • gateway OFF (native OpenCode) — the gateway resolver has no say.
  //    OpenCode owns the catalog and connects providers from the keys in the
  //    box, so the pin is stored VERBATIM in OpenCode's native
  //    `provider/model` form. Only the shape is checked here: the daemon's
  //    resolveOpencodeModel drops a slash-less ref silently, and a `kortix/…`
  //    ref names a provider that does not exist off-gateway — both would be a
  //    dead pin, so both fail fast instead.
  //
  // Runs BEFORE the billing hold so a bad model never costs a credit
  // reservation. Mirrors the channel-model gate (routes/channel-bindings.ts).
  const requestedModel = normalizeString(body.model ?? body.opencode_model ?? body.opencodeModel);
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
    if (!llmGatewayEnabled) {
      const nativeShapeError = validateNativeOpencodeModelRef(requestedModel);
      if (nativeShapeError) {
        return {
          error: {
            status: 400,
            body: { error: nativeShapeError.message, code: nativeShapeError.code },
          },
        };
      }
      opencodeModel = requestedModel;
      opencodeModelSource = 'explicit';
    } else {
      let servable = await isModelServableForAccount({
        userId,
        accountId,
        projectId,
        freeModelsOnly,
        model: requestedModel,
        providerSecretPools,
      });
      // A model reached only through pooled keys needs a key selection, and a
      // caller that names only the model (the CLI, the SDK, a chat channel)
      // names none: it was refused here. Select every key the caller may use
      // for its provider, so they rotate — the same keys the web offers.
      // Personal keys only in a session private to them that acts on their
      // behalf (spec 2026-09-22 §2.3); a child session's human is its
      // parent's, unknown here, so it gets shared keys only.
      if (!servable && providerSecretPools === undefined && pooledProviderSecrets) {
        const personal =
          visibility === 'private' && !input.callerSessionId
            ? decideSessionOnBehalfOf({
                userId,
                origin,
                // The metadata the session will carry: the request's, then the caller's.
                metadata: { ...normalizeJsonObject(body.metadata), ...normalizeJsonObject(input.metadata) },
                isAccountMember: true,
                slackRequiresUserIdentity: config.SLACK_REQUIRE_USER_IDENTITY !== false,
                teamsRequiresUserIdentity: config.TEAMS_REQUIRE_USER_IDENTITY !== false,
              })
            : null;
        const selection = await usableProviderKeys({
          accountId,
          projectId,
          userId,
          grantUserId: personal,
          model: requestedModel,
        }).catch(() => null);
        if (selection && agentMayUseEnv(grantFromLoadedAgents(agentName, loadedAgents), selection.envVar)) {
          const selected = { [selection.providerId]: selection.secretIds };
          servable = await isModelServableForAccount({
            userId,
            accountId,
            projectId,
            freeModelsOnly,
            model: requestedModel,
            providerSecretPools: selected,
          });
          if (servable) providerSecretPools = selected;
        }
      }
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
    }
  } else if (llmGatewayEnabled) {
    try {
      const resolved = await resolveEffectiveModel({
        userId,
        accountId,
        projectId,
        agentName,
        explicit: null,
        freeModelsOnly,
        providerSecretPools,
      });
      const concreteModel = resolved.model ?? platformDefaultModelId();
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

  // Every connector this session binds explicitly must be granted to the
  // session's agent. Nothing is required any more: an unconnected connector no
  // longer refuses the create, it denies at the call with a connect link.
  const grantCheckAliases = new Set<string>(
    parsedConnectorBindings.bindings ? Object.keys(parsedConnectorBindings.bindings) : [],
  );
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
  // MANDATORY DECLARED AGENTS (flagged — Phase 2). Only projects "subject" to enforcement (the
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
  const providerLocked = sessionProviderIsLocked(picked);
  const providerName: SandboxProviderName = providerLocked
    ? (picked as { provider: string }).provider as SandboxProviderName
    : await selectProvider();

  const callbackUnreachable =
    sandboxCallbackUnreachableReason() ?? (await sandboxCallbackDeadTunnelReason());
  if (callbackUnreachable) {
    return {
      error: { status: 503, body: { error: callbackUnreachable, code: 'KORTIX_URL_UNREACHABLE' } },
    };
  }

  // Validate the requested sandbox template up front so the user gets a clean
  // 400 instead of an async session-failed if they typed a slug that doesn't
  // exist. The platform default is always valid.
  // Harness/worker split: with the project's pi_worker flag on AND the manifest
  // declaring `runtime: pi`, the session boots the shared pi worker image and
  // its compiled runtime artifact instead of the OpenCode stack. Both gates or
  // nothing — the flag alone only compiles artifacts, the manifest alone is
  // inert, and any resolution failure falls back to the OpenCode path.
  let piWorkerBoot = false;
  let piWorkerSha: string | null = null;
  if (!platformMetaAgent && resolveFeatureFlag(project.metadata, 'pi_worker')) {
    try {
      const authedProject = await withProjectGitAuth(project);
      const ref = (baseRef ?? '').trim() || project.defaultBranch;
      // One round trip, not two: the runtime read and the tip resolution are
      // independent, and both sit on the POST /sessions critical path. A
      // non-pi manifest wastes one ls-remote-sized read; a pi manifest saves
      // a full sequential git hop.
      const [runtime, sha] = await Promise.all([
        resolveManifestRuntime(authedProject, baseRef),
        resolveCommitSha(authedProject, ref).catch(() => null),
      ]);
      if (runtime === 'pi' && sha) {
        piWorkerSha = sha;
        piWorkerBoot = true;
        sandboxSlug = PI_WORKER_SANDBOX_SLUG;
      } else if (runtime === 'pi') {
        console.warn(
          `[sessions] pi manifest on ${projectId} but tip resolution for '${ref}' failed; booting OpenCode path`,
        );
      }
    } catch (err) {
      console.warn(
        `[sessions] pi worker resolution failed for ${projectId}; booting OpenCode path:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (
    !platformMetaAgent &&
    sandboxSlug &&
    sandboxSlug !== DEFAULT_SANDBOX_SLUG &&
    sandboxSlug !== PI_WORKER_SANDBOX_SLUG
  ) {
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

  // The concurrency cap and the billing gate are independent read-only checks
  // (`checkBillingAdmission` debits nothing; see its note on the hold leak) —
  // run them concurrently so a warmed create pays a single DB round-trip instead
  // of two serial ones. Error precedence is preserved exactly: the cap (429) is
  // still evaluated/returned before billing (402).
  const [capResult, billingCheck] = await Promise.all([
    input.enforceAccountCap !== false
      ? checkConcurrentSessionCap(
          accountId,
          userId,
          input.request,
          input.reserveConcurrentSlots ?? 0,
          projectId,
        )
      : Promise.resolve(null),
    checkBillingAdmission(accountId),
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
  if (requestedSessionId && !isUuid(requestedSessionId)) {
    return { error: { status: 400, body: { error: 'Invalid session id' } } };
  }
  const sessionId = requestedSessionId ?? randomUUID();

  const initialPrompt = normalizeString(body.initial_prompt ?? body.initialPrompt);
  const initialTurn = initialPrompt ? prepareInitialSandboxTurn() : null;
  const pendingPrompt =
    body.pending_prompt &&
    typeof body.pending_prompt === 'object' &&
    !Array.isArray(body.pending_prompt) &&
    typeof (body.pending_prompt as Record<string, unknown>).text === 'string'
      ? (body.pending_prompt as Record<string, unknown>)
      : null;
  // The first prompt becomes a durable inbox row in the SAME transaction as
  // the session row — see `convertPendingPromptToInboxRow` for the contract
  // (and why stored metadata keeps only the picks).
  const pendingPromptConversion = pendingPrompt
    ? convertPendingPromptToInboxRow({
        pendingPrompt,
        projectId,
        accountId,
        sessionId,
        actorUserId: userId,
        authorSessionId: input.callerSessionId ?? null,
      })
    : null;
  if (pendingPromptConversion?.error) {
    return {
      error: {
        status: 400,
        body: { error: `pending_prompt: ${pendingPromptConversion.error}` },
      },
    };
  }
  // A name supplied at create is an EXPLICIT, user-chosen name — the same thing
  // `PATCH /sessions/:id` writes when the user renames. It belongs in
  // `metadata.custom_name`, NOT `metadata.name`: `name` is the auto-title slot
  // the first prompt fills, and it is the WEAKEST link in the display chain
  // (`custom_name ?? runtimeTitle ?? name`). Writing it there let the runtime's
  // own auto-title (`runtimeTitle` from the OpenCode snapshot, and the client
  // mirror that copies it) displace the name the user chose, seconds after the
  // first prompt. `custom_name` is the single authoritative key every reader
  // (`serializeSession`, `getSessionDisplayTitle`, `patchKortixSessionTitleMirrors`)
  // and both title-writer gates (`needsTitle`, the `persistTitle` CAS) already
  // respect, so a session born named is never auto-titled.
  const sessionName = normalizeString(body.name);
  // An explicit `title_source` means the baked prompt is a rendered envelope
  // (Slack/Teams/Telegram turn instructions + workspace/channel ids) and these
  // are the user's actual words. Store it so a LATER fallback hook — which only
  // ever sees the envelope — titles from the same clean text the create hook
  // would have used, instead of leaking the scaffolding into a project-visible
  // title when this create-time attempt fails.
  const explicitTitleSource = normalizeString(body.title_source ?? body.titleSource);
  const invocationSource =
    typeof (input.metadata as Record<string, unknown> | undefined)?.source === 'string'
      ? ((input.metadata as Record<string, unknown>).source as string)
      : null;
  const auditAttribution = sessionCreatedAuditAttribution({
    accountId,
    projectId,
    sessionId,
    actorUserId: userId,
    requestingPrincipalType: input.requestingPrincipalType,
    inSession: input.inSession,
    origin,
    invocationSource,
    callerSessionId: input.callerSessionId,
    agentName,
    visibility,
    sandboxProvider: providerName,
    connectorBindingCount: validatedConnectorBindings.bindings.length,
    secretAllowlistCount: secretsAllowlist?.length ?? 0,
  });
  // The surface the create came through. The route stamps every HTTP create
  // `ui`; a spawn from another session's credential is an `agent`. Derived from
  // the authenticated credential, never a client header. Informational only:
  // no policy reads these values (origin keys on `trigger:`/`system:` and channels).
  const sessionSource =
    invocationSource === 'ui' && input.callerSessionId ? 'agent' : invocationSource;
  const initiator: SessionInitiator =
    parentSession?.initiator ??
    resolveRootSessionInitiator({
      source: invocationSource,
      triggerSlug: normalizeString((input.metadata as Record<string, unknown> | undefined)?.trigger_slug),
      userId,
      requestingPrincipalType: input.requestingPrincipalType,
      channelSenderIsLinked:
        invocationSource === 'slack'
          ? config.SLACK_REQUIRE_USER_IDENTITY !== false
          : invocationSource === 'teams'
            ? config.TEAMS_REQUIRE_USER_IDENTITY !== false
            : false,
    });
  const requestMetadata = normalizeJsonObject(body.metadata);
  const metadata = {
    ...requestMetadata,
    ...(sessionName ? { custom_name: sessionName } : {}),
    ...(initialPrompt ? { initial_prompt: initialPrompt } : {}),
    // Picks only — the prompt itself is a durable inbox row (see below), and a
    // pre-deploy web bundle replays `pending_prompt.text` client-side, so
    // storing the text would double-send it.
    ...(pendingPromptConversion ? { pending_prompt: pendingPromptConversion.metadataPicks } : {}),
    ...(explicitTitleSource
      ? { title_source: explicitTitleSource.slice(0, TITLE_SOURCE_MAX_CHARS) }
      : {}),
    ...(opencodeModel ? { opencode_model: opencodeModel } : {}),
    ...(opencodeModelSource ? { opencode_model_source: opencodeModelSource } : {}),
    ...(input.metadata ?? {}),
    // Server-owned creation intent, never caller metadata or actual placement.
    ...((input.metadata?.[WARM_SESSION_METADATA_KEY] ?? requestMetadata[WARM_SESSION_METADATA_KEY]) === true
      ? { [WARM_SESSION_LOCATION_KEY]: resolveSessionSandboxRegion(project.metadata) ?? 'home' }
      : {}),
    // Persist the coordinator→worker link. The sidebar badges child sessions
    // with it, and the turn-end deadline shortener stops child sandboxes on a
    // tight grace so finished workers don't idle at full compute.
    ...(input.callerSessionId ? { spawned_by_session: input.callerSessionId } : {}),
    ...(sessionSource && sessionSource !== invocationSource ? { source: sessionSource } : {}),
    repository_access: repositoryAccess,
    repository_generation: repositoryGeneration(project.metadata as Record<string, unknown>),
    // Rollback compatibility: older API replicas must also enforce this restriction.
    workspace_mode: repositoryAccess ? 'branch' : 'runtime',
    sandbox_slug: sandboxSlug,
    audit_v2: {
      actor_type: auditAttribution.actorType,
      authoritative_source: auditAttribution.authoritativeSource,
      initiator_actor_type: auditAttribution.initiatorActorType,
      initiator_actor_id: auditAttribution.initiatorActorId,
      delegation_depth: auditAttribution.delegationDepth,
    },
  };

  let sessionRow: ProjectSessionRow | null = null;
  try {
    sessionRow = await insertSessionAndBindings(parsedRuntimeContext.context, validatedConnectorBindings.bindings);
  } catch (error) {
    // Besides a randomUUID() collision on the PK / (project_id, branch_name)
    // unique index, `sandbox_provider` is an ENUM: a provider this env enables
    // but the target DB's type is missing fails here with 22P02, not upstream —
    // resolveSessionProvider validates against config, never against the DB.
    // (That is how prod, whose faked baseline skipped 'platinum', 500'd every
    // create on a project pinned to it.) verify-live-schema.ts now gates that drift.
    // Session, context and connection bindings are one transaction. Nothing is
    // visible and provisioning never starts when any child insert fails.
    if (error instanceof HTTPException && error.status < 500) {
      return { error: { status: error.status, body: await error.getResponse().json() } };
    }
    // Never return `(error as Error).message`: postgres.js embeds the whole
    // statement and its parameters in it (see `resolveSessionInsertFailure`).
    return { error: resolveSessionInsertFailure(error) };
  }

  async function insertSessionAndBindings(
    runtimeContext: Extract<typeof parsedRuntimeContext, { ok: true }>['context'],
    connectorBindings: Extract<typeof validatedConnectorBindings, { ok: true }>['bindings'],
  ): Promise<ProjectSessionRow> {
    return db.transaction(async (tx) => {
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
        parentSessionId: parentSession?.sessionId ?? null,
        initiatorType: initiator.type,
        initiatorId: initiator.id,
        secretsAllowlist,
        labels: SessionCreateInputSchema.shape.labels.parse(body.labels) ?? [],
        connectorBindingsConfigured,
        connectorBindingsInheritUnbound: inheritUnbound,
        metadata,
        updatedAt: new Date(),
      })
      .returning();
    if (!row) throw new Error('Session insert returned no row');
    if (input.createCommandId) {
      // Same transaction as the session row: a create command whose worker
      // dies after this commit is reclaimed WITH its session id, and
      // executeQueuedCreate returns this session instead of provisioning a
      // second one.
      await tx
        .update(sessionLifecycleCommands)
        .set({ sessionId, updatedAt: new Date() })
        .where(
          and(
            eq(sessionLifecycleCommands.commandId, input.createCommandId),
            eq(sessionLifecycleCommands.commandType, 'create_session'),
            isNull(sessionLifecycleCommands.sessionId),
          ),
        );
    }
    if (providerSecretPools && Object.keys(providerSecretPools).length > 0) {
      await tx.insert(sessionProviderSecretPools).values(
        Object.entries(providerSecretPools).map(([providerId, secretIds]) => ({ sessionId, providerId, secretIds })),
      );
    }
    if (runtimeContext !== undefined) {
        await tx
          .insert(projectSessionRuntimeContexts)
          .values({
            sessionId,
             context: runtimeContext,
             byteSize: new TextEncoder().encode(JSON.stringify(runtimeContext))
              .byteLength,
          })
          .returning({ sessionId: projectSessionRuntimeContexts.sessionId });
    }
      if (pendingPromptConversion?.rowValues) {
        // Same transaction as the session row: either the session exists WITH
        // its first prompt durable, or neither does. No conflict handling —
        // `sessionId` is fresh here, so the idempotency key cannot collide
        // without the projectSessions PK colliding first.
        const insertPrompt = tx
          .insert(sessionLifecycleCommands)
          .values(pendingPromptConversion.rowValues);
        // Only a handle prompt reads its payload back, for binding. A legacy
        // prompt can carry up to 12 MiB of data-URL parts it never needs again.
        if ((pendingPromptConversion.rowValues.payload.parts as Array<{ attachment_id?: string }> | undefined)?.some((part) => part.attachment_id)) {
          const [promptCommand] = await insertPrompt.returning({
            commandId: sessionLifecycleCommands.commandId,
            accountId: sessionLifecycleCommands.accountId,
            projectId: sessionLifecycleCommands.projectId,
            actorUserId: sessionLifecycleCommands.actorUserId,
            payload: sessionLifecycleCommands.payload,
          });
          if (promptCommand) {
            const { bindPromptAttachments } = await import('../prompt-attachments');
            await bindPromptAttachments(tx, promptCommand, input.attachmentSourceCommandId);
          }
        } else {
          await insertPrompt.returning({ commandId: sessionLifecycleCommands.commandId });
        }
      }
      if (connectorBindings.length > 0) {
        await tx
          .insert(projectSessionConnectorBindings)
          .values(
             connectorBindings.map((binding) => ({
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
      if (inheritedGrants.length > 0) {
        await tx.insert(projectSessionGrants).values(
          inheritedGrants.map((g) => ({
            sessionId,
            principalType: g.principalType,
            principalId: g.principalId,
          })),
        );
      }
      return row;
    });
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

  // A prompt supplied at create is claimed by the session daemon. This is the
  // earliest title source. No modelHint: the row already carries `opencode_model`.
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
  void provisionCreatedSession();

  async function provisionCreatedSession() {
    const tl = new ProvisionTimeline(sessionId, 'session-create');
    try {
      // Resolve git auth and user env concurrently. Git auth is needed for
      // background freshness checks / remote branch publishing, but a warm
      // session can boot from an existing ready snapshot without waiting for it.
      const projectWithGitAuthPromise = withProjectGitAuth(project).then((gitProject) => {
        tl.mark('git-auth');
        return gitProject;
      });
      // Resolve the base tip from the API's existing mirror and package its
      // one-commit scaffold delta. This moves the small object transfer into
      // sandbox creation and removes the slow in-guest Git negotiation.
      // Best-effort + timeout-guarded (never block create): on failure/timeout
      // the hint is omitted → daemon delta-fetches as before. Runs CONCURRENTLY
      // with gitAuth (folded into the env-build chain, not awaited inline).
      let fastBootHintTimeout: ReturnType<typeof setTimeout> | undefined;
      // Default on (KORTIX_FAST_GIT_BOOT_ENABLED): the hint is what lets the
      // daemon boot with ZERO proxied git requests (scaffold + delta) and spawn
      // OpenCode before the checkout. Bounded by the 2 s race below; a miss
      // just means the daemon's fetch fallback.
      // The worker path never clones: the scaffold/delta hint is pure waste
      // there, and the hint alone holds the env build for up to 2 s.
      const fastBootGitHintPromise =
        !piWorkerBoot && config.KORTIX_FAST_GIT_BOOT_ENABLED
        ? Promise.race([
            projectWithGitAuthPromise
              .then((projectWithGitAuth) =>
                resolveFastBootGitHintWithCache(
                  projectWithGitAuth,
                  baseRef,
                  project.metadata,
                ),
              )
              .catch(() => undefined),
            new Promise<undefined>((resolve) => {
              fastBootHintTimeout = setTimeout(() => resolve(undefined), 2_000);
            }),
          ]).finally(() => {
            if (fastBootHintTimeout) clearTimeout(fastBootHintTimeout);
          })
        : Promise.resolve(undefined);
      // OpenCode compiled-boot artifacts serve the daemon path only; a worker
      // boot fetches its own per-commit pi artifact instead.
      if (!piWorkerBoot && config.KORTIX_COMPILED_BOOT_MODE !== 'off') {
        void Promise.all([projectWithGitAuthPromise, fastBootGitHintPromise])
          .then(([projectWithGitAuth, hint]) =>
            hint?.baseSha
              ? prebuildCompiledBootArtifacts(
                  projectWithGitAuth,
                  baseRef,
                  hint.baseSha,
                  proxyGitUrl(projectId),
                )
              : null,
          )
          .then((artifacts) => {
            if (!artifacts) return;
            console.info('[compiled-boot] session artifacts ready', {
              projectId,
              sessionId,
              ref: baseRef,
              sourceSha: artifacts.runtime.sourceSha,
              checkoutCache: artifacts.checkout.cacheHit ? 'hit' : 'miss',
              runtimeCache: artifacts.runtime.cacheHit ? 'hit' : 'miss',
            });
          })
          .catch((error) => {
            console.warn('[compiled-boot] session artifact prebuild failed', {
              projectId,
              sessionId,
              ref: baseRef,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }
      // Worker boots skip the OpenCode env build entirely: the compiled
      // artifact already carries the agent map, v0 grants the worker no
      // project secrets (the gateway resolves BYOK server-side per request),
      // and nothing clones. Measured on dev 2026-08-27, the full chain
      // (hint race + compiled config + secret grant + secrets snapshot) cost
      // 1.1–2.4 s of every cold pi boot.
      const envPromise = piWorkerBoot
        ? Promise.resolve(
            buildPiWorkerSessionEnvVars({
              projectId,
              sessionId,
              agentName,
              // Only an EXPLICIT session model may override the baked agent
              // model — the platform/project fallback resolution exists for
              // the OpenCode path and must not clobber the artifact's own
              // model (KORTIX_MODEL wins over the bake inside the worker).
              // Stripped to the native ref: the worker's env path takes the
              // value verbatim, unlike the baked path which de-prefixes.
              opencodeModel:
                opencodeModelSource === 'explicit' && opencodeModel
                  ? opencodeModel.replace(/^kortix\//, '')
                  : null,
              apiUrl: deriveKortixApiBase(),
              frontendUrl: sandboxFrontendBaseUrl(),
            }),
          ).then((envVars) => {
            tl.mark('env-vars');
            return envVars;
          })
        : fastBootGitHintPromise
        .then(async (fastBootGitHint) => {
          // S3 config provider: pin a PREPARED archive for the exact base tip
          // and presign its download descriptor right here (local signing, no
          // bucket call on the create path), or record the miss and queue the
          // build for the next session. One indexed read.
          const projectSnapshotMode = resolveProjectSnapshotMode(project.metadata);
          const projectSnapshot =
            projectSnapshotMode === 'git'
              ? { pin: null, descriptor: null, cache: 'unconfigured' as const }
              : await resolveProjectSnapshotPinForSession({
                  projectId,
                  ref: baseRef,
                  commitSha: fastBootGitHint?.baseSha,
                  repoUrl: project.repoUrl,
                }).catch((err) => {
                  console.warn('[project-snapshot] pin lookup failed; session boots from git', {
                    projectId,
                    sessionId,
                    error: err instanceof Error ? err.message : String(err),
                  });
                  return { pin: null, descriptor: null, cache: 'miss' as const };
                });
          if (projectSnapshotMode !== 'git') {
            tl.mark(`project-snapshot-${projectSnapshot.cache}`);
          }
          return {
            fastBootGitHint,
            projectSnapshotMode,
            projectSnapshotPin: projectSnapshot.pin,
            projectSnapshotDescriptor: projectSnapshot.descriptor,
          };
        })
        .then(({ fastBootGitHint, projectSnapshotMode, projectSnapshotPin, projectSnapshotDescriptor }) =>
          buildSessionSandboxEnvVars({
            accountId,
            projectId,
            sessionId,
            userId,
            repoUrl: project.repoUrl,
            baseRef,
            agentName,
            opencodeModel,
            llmGatewayEnabled,
            platformMetaAgent,
            freshSession: true,
            projectSnapshotMode,
            projectSnapshotPin,
            projectSnapshotDescriptor,
            baseSha: fastBootGitHint?.baseSha,
            gitDeltaBundleBase64: fastBootGitHint?.gitDeltaBundleBase64,
            gitDeltaBundleRemote: fastBootGitHint?.gitDeltaBundleRemote,
            gitDeltaParentSha: fastBootGitHint?.gitDeltaParentSha,
            gitDeltaParentCommitBase64: fastBootGitHint?.gitDeltaParentCommitBase64,
            defaultBranch: project.defaultBranch,
            manifestPath: project.manifestPath,
            repositoryAccess,
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
      const branchPromise: Promise<void> = !repositoryAccess || branchAlreadyCreated
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

      // Not awaited here: provisioning reads it only when it builds the provider
      // input, so the env build overlaps the image check and the token mint.
      const extraEnvVars = envPromise.then((env) => {
        const merged = mergeSessionSandboxEnv(env, input.extraEnvVars);
        return piWorkerBoot && piWorkerSha
          ? {
              ...merged,
              // The worker's entrypoint composes the artifact URL from these
              // plus KORTIX_API_URL/KORTIX_PROJECT_ID/KORTIX_TOKEN it
              // already receives.
              KORTIX_PI_RUNTIME_REF: (baseRef ?? '').trim() || project.defaultBranch,
              KORTIX_PI_RUNTIME_SHA: piWorkerSha,
            }
          : merged;
      });

      const provisionPromise = provisionSessionSandbox({
        sandboxId: sessionId,
        accountId,
        projectId,
        userId,
        agentName,
        allowProjectImage: piWorkerBoot
          ? false
          : projectImageAllowedForSession(agentName, repositoryAccess),
        // v0 pins the worker to Daytona: the entrypoint override in
        // ensurePiWorkerImage is only exercised there so far. Lift once the
        // other adapters' entrypoint handling is verified.
        provider: piWorkerBoot ? 'daytona' : providerName,
        providerLocked: piWorkerBoot ? true : providerLocked,
        metadata: {
          session_id: sessionId,
          project_id: projectId,
          ...(piWorkerBoot ? { pi_worker_boot: true } : {}),
          ...(input.metadata ?? {}),
        },
        initialTurn,
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
        // Merge, never re-write the create-time snapshot: by the time
        // provisioning fails the row may already carry a generated title,
        // remote_branch or the start timeline. A session deleted meanwhile
        // keeps its tombstone.
        await transitionSession('fail', sessionId, {
          error: message,
          metadata: { provisioning_error: message },
        });
      } catch (markErr) {
        console.error(`[projects] Failed to mark session ${sessionId} failed:`, markErr);
      }
      // Surface the failure to the originating channel (Slack) so the thread
      // doesn't sit on a ⏳ until the 30-min GC. No-op for non-channel sessions.
      notifySessionProvisioningFailed(sessionId, message);
    }
  }

  return {
    row: sessionRow,
    headers: responseHeaders,
    pendingPromptIdempotencyKey:
      pendingPromptConversion?.rowValues?.idempotencyKey ?? null,
  };
}
