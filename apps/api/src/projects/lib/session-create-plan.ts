import { randomUUID } from 'node:crypto';
import { type SandboxProviderName, config } from '../../config';
import { isMetaAgentName, META_AGENT_NAME, META_SANDBOX_SLUG } from '@kortix/shared';
import { checkBillingAdmission } from '../../billing/services/billing-gate';
import { accountMayUseManagedModels } from '../../billing/services/entitlements';
import { agentMayUseConnector, agentMayUseEnv } from '../../iam/agent-scope';
import {
  isModelServableForAccount,
  resolveEffectiveModel,
} from '../../llm-gateway/resolution/default-model';
import {
  type ModelSource,
  toOpencodeModelRef,
} from '../../llm-gateway/resolution/effective';
import { projectLlmGatewayEnabled } from '../../llm-gateway/enablement';
import { selectProvider } from '../../platform/services/provider-balancer';
import { resolveSessionSandboxRegion } from '../../platform/services/sandbox-region';
import { WARM_SESSION_LOCATION_KEY, WARM_SESSION_METADATA_KEY } from './warm-sessions';
import {
  grantFromLoadedAgents,
  loadProjectAgents,
  projectRequiresDeclaredAgents,
  resolveGovernedAgentGrant,
  sandboxFromLoadedAgents,
  repositoryAccessFromLoadedAgents,
  legacyReadWorkspaceFromLoadedAgents,
} from '../agents';
import { convertPendingPromptToInboxRow } from '../session-lifecycle/pending-prompt';
import { validateNativeOpencodeModelRef } from './session-model-change';
import {
  canonicalConnectorAlias,
  parseSessionConnectorBindings,
  sessionConnectorBindingsRequirePrivateVisibility,
  validateSessionConnectorBindings,
} from './session-connector-bindings';
import { TITLE_SOURCE_MAX_CHARS } from '../session-title-generate';
import { prepareInitialSandboxTurn } from '../session-turn-ledger';
import { canOverride, inheritParentOrigin, resolveSessionOrigin, type SessionOrigin } from './session-origin';
import { resolveRootSessionInitiator, type SessionInitiator } from './session-initiator';
import { sessionCreatedAuditAttribution } from './session-audit';
import { resolveSessionSandboxSlug } from './session-sandbox-metadata';
import { repositoryGeneration } from './repository-generation';
import { parseSessionRuntimeContext } from './session-runtime-context';
import { resolveFeatureFlag } from '../../feature-flags/registry';
import { resolvePlatformMetaSandbox } from './platform-meta-agent';
import { sandboxCallbackUnreachableReason, sandboxCallbackDeadTunnelReason } from './session-callback-probe';
import { decideSessionOnBehalfOf } from './on-behalf-of';
import { usableProviderKeys } from '../../secrets/provider-key-selection';
import { resolveSessionProvider, sessionProviderIsLocked } from './provider-precedence';
import { DEFAULT_SANDBOX_SLUG, resolveTemplate } from '../../snapshots/builder';
import {
  loadSessionGrants,
  resolveInheritedSessionSharing,
  type SecretGrant,
  type SessionVisibility,
} from '../../connectors/share';
import {
  listResolvedProjectSecrets,
  parseSessionSecretsAllowlist,
  secretKeyCollisionInAllowlist,
} from '../secrets';
import {
  type ProjectRow,
  type ProjectSessionRow,
  type RequestAuditContext,
  normalizeString,
} from './serializers';
import { normalizeJsonObject } from '../../shared/json';
import { isUuid } from '../../shared/validate';
import { db } from '../../shared/db';
import { projectSessions } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import type { SessionCreateError } from './session-create';
import type { ValidatedSessionConnectorBinding } from './connector-binding-shared';
import type { SessionConnectorBindings, SessionRuntimeContext } from '@kortix/api-contract';
import type { LoadedAgents } from '../agents';

/**
 * The session-create resolution phases. `createProjectSession` held all of
 * them inline as ~1,100 lines with two nested closures; each phase is now a
 * module-scope function that takes the caller's input and the phase results
 * it depends on, and returns its own slice of the create plan. The bodies
 * moved verbatim — same statements, same order, same early returns — so the
 * create path can be read and tested one concern at a time.
 */

/** The caller's create request, verbatim from the route. */
export type SessionCreateInput = {
  attachmentSourceCommandId?: string;
  /** The `create_session` command to link the new session to, atomically. */
  createCommandId?: string;
  project: ProjectRow;
  userId: string;
  requestingPrincipalType: 'human' | 'service_account';
  body: Record<string, unknown>;
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
};
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

export type SessionCreateInheritance = {
  parentSession: {
    sessionId: string;
    visibility: SessionVisibility;
    origin: string;
    initiator: SessionInitiator | null;
  } | null;
  visibility: SessionVisibility;
  inheritedGrants: SecretGrant[];
  parsedRuntimeContext: { ok: true; context: SessionRuntimeContext | undefined };
  parsedConnectorBindings: { ok: true; bindings: SessionConnectorBindings | undefined };
  inheritUnbound: boolean;
  connectorBindingsConfigured: boolean;
  origin: SessionOrigin;
  secretsAllowlist: string[] | null;
};


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

/** Sharing inheritance, request parsing and the origin-gated secrets gate. */
export async function resolveSessionCreateInheritance(
  input: SessionCreateInput,
): Promise<{ ok: true; value: SessionCreateInheritance } | { ok: false; error: SessionCreateError }> {
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
      ok: false,
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
      ok: false,
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
      ok: false,
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
      ok: false,
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
        ok: false,
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
        ok: false,
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
  return {
    ok: true,
    value: {
      parentSession,
      visibility,
      inheritedGrants,
      parsedRuntimeContext,
      parsedConnectorBindings,
      inheritUnbound,
      connectorBindingsConfigured,
      origin,
      secretsAllowlist,
    },
  };
}

export type SessionCreateAgentPlan = {
  baseRef: string;
  agentName: string;
  platformMetaAgent: boolean;
  repositoryAccess: boolean;
  loadedAgents: LoadedAgents;
  projectDefaultAgent: string | null;
};

/** Agent identity: the manifest's agents, the meta coordinator and the
 *  workspace mode. */
export async function resolveSessionCreateAgent(
  input: SessionCreateInput,
): Promise<{ ok: true; value: SessionCreateAgentPlan } | { ok: false; error: SessionCreateError }> {
  const { project, body } = input;
  const projectId = project.projectId;
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
      ok: false,
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
      ok: false,
      error: {
        status: 409,
        body: {
          error: 'workspace mode "read" requires restricted workspace artifacts',
          code: 'WORKSPACE_MODE_UNAVAILABLE',
        },
      },
    };
  }
  return {
    ok: true,
    value: { baseRef, agentName, platformMetaAgent, repositoryAccess, loadedAgents, projectDefaultAgent },
  };
}

export type SessionCreateModelPlan = {
  llmGatewayEnabled: boolean;
  providerSecretPools: Record<string, string[]> | undefined;
  opencodeModel: string | null;
  opencodeModelSource: ModelSource | null;
};

/** The session's model: normalize, validate against the servability resolver
 *  (gateway ON) or the native shape (gateway OFF), and resolve the default. */
export async function resolveSessionCreateModel(
  input: SessionCreateInput,
  inheritance: SessionCreateInheritance,
  agent: SessionCreateAgentPlan,
): Promise<{ ok: true; value: SessionCreateModelPlan } | { ok: false; error: SessionCreateError }> {
  const { project, userId, body } = input;
  const projectId = project.projectId;
  const accountId = project.accountId;
  const { visibility, origin } = inheritance;
  const { agentName, loadedAgents } = agent;
  const freeModelsOnly = !(await accountMayUseManagedModels(accountId));
  const llmGatewayEnabled = projectLlmGatewayEnabled(project.metadata);
  const pooledProviderSecrets = resolveFeatureFlag(project.metadata, 'pooled_provider_secrets');
  if (body.provider_secret_pools !== undefined && (!pooledProviderSecrets || !llmGatewayEnabled)) {
    return { ok: false, error: { status: 403, body: { error: 'Provider secret pools are unavailable' } } };
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
        ok: false,
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
          ok: false,
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
          ok: false,
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
        ok: false,
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
  return {
    ok: true,
    value: { llmGatewayEnabled, providerSecretPools, opencodeModel, opencodeModelSource },
  };
}

export type SessionCreateConnectorPlan = {
  validatedConnectorBindings: { ok: true; bindings: ValidatedSessionConnectorBinding[] };
};

/** Connector bindings: the agent's grant check and the reachability and
 *  ownership validation of every bound connection. */
export async function resolveSessionCreateConnectors(
  input: SessionCreateInput,
  inheritance: SessionCreateInheritance,
  agent: SessionCreateAgentPlan,
): Promise<{ ok: true; value: SessionCreateConnectorPlan } | { ok: false; error: SessionCreateError }> {
  const { project, userId } = input;
  const accountId = project.accountId;
  const projectId = project.projectId;
  const { visibility, parsedConnectorBindings } = inheritance;
  const { agentName, loadedAgents } = agent;
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
          ok: false,
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
      ok: false,
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
      ok: false,
      error: {
        status: 409,
        body: {
          error: 'Sessions using a personal connection must remain private',
          code: 'PERSONAL_CONNECTOR_CONNECTION_REQUIRES_PRIVATE_SESSION',
        },
      },
    };
  }
  return { ok: true, value: { validatedConnectorBindings } };
}

/** MANDATORY DECLARED AGENTS enforcement — the undeclared-agent 400 fires
 *  here, before any row is inserted or sandbox provisioned. */
export function enforceSessionDeclaredAgents(
  input: SessionCreateInput,
  agent: SessionCreateAgentPlan,
): { ok: true } | { ok: false; error: SessionCreateError } {
  const { project } = input;
  const { platformMetaAgent, agentName, loadedAgents, projectDefaultAgent } = agent;
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
      return { ok: false, error: { status: 400, body: { error: governed.error, code: governed.code } } };
    }
  }
  return { ok: true };
}

export type SessionCreateSandboxPlan = {
  sandboxSlug: string;
  providerName: SandboxProviderName;
  providerLocked: boolean;
};

/** Where the session runs: sandbox slug, provider pick, the platform's own
 *  reachability, and the requested template. */
export async function resolveSessionCreateSandbox(
  input: SessionCreateInput,
  agent: SessionCreateAgentPlan,
): Promise<{ ok: true; value: SessionCreateSandboxPlan } | { ok: false; error: SessionCreateError }> {
  const { project, body } = input;
  const projectId = project.projectId;
  const { platformMetaAgent, agentName, loadedAgents } = agent;
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
        ok: false,
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
      ok: false,
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
      ok: false,
      error: { status: 503, body: { error: callbackUnreachable, code: 'KORTIX_URL_UNREACHABLE' } },
    };
  }

  // Validate the requested sandbox template up front so the user gets a clean
  // 400 instead of an async session-failed if they typed a slug that doesn't
  // exist. The platform default is always valid.
  if (
    !platformMetaAgent &&
    sandboxSlug &&
    sandboxSlug !== DEFAULT_SANDBOX_SLUG
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
        ok: false,
        error: {
          status: 400,
          body: { error: message, code: 'UNKNOWN_SANDBOX_TEMPLATE' },
        },
      };
    }
  }
  return { ok: true, value: { sandboxSlug, providerName, providerLocked } };
}

/** The one create gate that can cost money. */
export async function checkSessionCreateBilling(
  input: SessionCreateInput,
): Promise<{ ok: true } | { ok: false; error: SessionCreateError }> {
  const { project } = input;
  const accountId = project.accountId;
  const billingCheck = await checkBillingAdmission(accountId);
  if (!billingCheck.ok) {
    return {
      ok: false,
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
  return { ok: true };
}

export type SessionCreateIdentityPlan = {
  sessionId: string;
  initialTurn: ReturnType<typeof prepareInitialSandboxTurn> | null;
  pendingPromptConversion: ReturnType<typeof convertPendingPromptToInboxRow> | null;
  initiator: SessionInitiator;
  metadata: Record<string, unknown>;
};

/** The session's identity: id, first prompt, initiator, audit attribution and
 *  the create-time metadata record. */
export function buildSessionCreateIdentity(
  input: SessionCreateInput,
  resolved: SessionCreateInheritance &
    SessionCreateAgentPlan &
    SessionCreateModelPlan &
    SessionCreateConnectorPlan &
    SessionCreateSandboxPlan,
): { ok: true; value: SessionCreateIdentityPlan } | { ok: false; error: SessionCreateError } {
  const { project, userId, body } = input;
  const projectId = project.projectId;
  const accountId = project.accountId;
  const { agentName, repositoryAccess } = resolved;
  const { providerName, sandboxSlug } = resolved;
  const { validatedConnectorBindings } = resolved;
  const { secretsAllowlist, origin, visibility, parentSession } = resolved;
  const { opencodeModel, opencodeModelSource } = resolved;
  const requestedSessionId = normalizeString(body.session_id ?? body.sessionId);
  if (requestedSessionId && !isUuid(requestedSessionId)) {
    return { ok: false, error: { status: 400, body: { error: 'Invalid session id' } } };
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
      ok: false,
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
  return {
    ok: true,
    value: { sessionId, initialTurn, pendingPromptConversion, initiator, metadata },
  };
}

/** Everything the hoisted insert transaction and the fire-and-forget
 *  provisioning need, resolved. */
export interface SessionCreatePlan {
  accountId: string;
  projectId: string;
  sessionId: string;
  userId: string;
  baseRef: string;
  agentName: string;
  visibility: SessionVisibility;
  origin: SessionOrigin;
  parentSession: SessionCreateInheritance['parentSession'];
  initiator: SessionInitiator;
  secretsAllowlist: string[] | null;
  inheritedGrants: SecretGrant[];
  connectorBindingsConfigured: boolean;
  inheritUnbound: boolean;
  metadata: Record<string, unknown>;
  providerName: SandboxProviderName;
  providerLocked: boolean;
  sandboxSlug: string;
  opencodeModel: string | null;
  llmGatewayEnabled: boolean;
  platformMetaAgent: boolean;
  repositoryAccess: boolean;
  providerSecretPools: Record<string, string[]> | undefined;
  runtimeContext: SessionRuntimeContext | undefined;
  connectorBindings: ValidatedSessionConnectorBinding[];
  pendingPromptConversion: ReturnType<typeof convertPendingPromptToInboxRow> | null;
  initialTurn: ReturnType<typeof prepareInitialSandboxTurn> | null;
}
