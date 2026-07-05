import { logger } from '../lib/logger';
import {
  EMAIL_CHANNEL_CONNECTOR_SLUG,
  SLACK_CHANNEL_CONNECTOR_SLUG,
  channelCatalog,
} from './channels';
import {
  type ExecResult,
  type ExecutorAuth,
  type FetchImpl,
  executeCall,
  paramHintsFromSchema,
} from './execute';
/**
 * Executor gateway — the chokepoint every tool call goes through. Resolves the
 * connector + action, checks the acting user can use it (project-secret
 * sharing), resolves the credential SERVER-SIDE, runs the call, audits it.
 * The sandbox never holds an app secret.
 *
 * Policy enforcement is layered (docs/specs/executor.md §8):
 *   1. project-level [[policies]] (fully-qualified patterns) — admin guardrails
 *   2. connector-level [[connectors.policies]] (relative patterns) — connector-author rules
 *   3. risk-derived default (when `default_mode = risk`) or always_run (`allow_all`)
 *
 * Written against an injectable `GatewayDeps` so the full decision+execution
 * path is unit-tested with fakes (incl. a mocked third party). The HTTP router
 * (router.ts) wires real DB/secret deps. `enforcePolicies` exists for back-compat
 * with the original allow-all engine; production sets it true.
 */
import { type DefaultMode, type Policy, resolveEffectiveAction } from './policy';
import {
  type SecretGrant,
  type ShareScope,
  type ShareSubject,
  connectorDeniedForAgent,
  isSecretUsableBy,
} from './share';
import type { ActionBinding, Risk } from './types';

export interface GatewayConnector {
  connectorId: string;
  slug: string;
  provider: 'pipedream' | 'mcp' | 'openapi' | 'graphql' | 'http' | 'channel' | 'computer';
  platform?: string | null;
  /** server / base_url / endpoint / url, per provider (null for some). */
  baseUrl: string | null;
  auth: ExecutorAuth;
  /** Whether this connector needs a credential at all (false = public/no-auth). */
  hasAuth: boolean;
  /** Who can use it. */
  shareScope: ShareScope;
  grants: SecretGrant[];
  /** Always `shared` (one project credential) — `per_user` (each member's
   *  own) was removed 2026-07-05. Kept as a field for shape stability. */
  credentialMode: 'shared';
  enabled: boolean;
  /** Marked sensitive (email/files/secrets-bearing): reads gate too — every
   *  action defaults to require_approval unless an explicit policy opens it.
   *  Optional (absent = not sensitive) so fixtures/callers needn't set it. */
  sensitive?: boolean;
  /** Which agents may call this connector (the connector-side agent gate,
   *  mirror of secret agent_scope). Absent/empty = ALL agents; a list of agent
   *  NAMES restricts it to those agents' sessions. Enforced in connectorUsable
   *  against the session's running agent. Optional so fixtures needn't set it. */
  agentScope?: string[];
}

export interface GatewayAction {
  /** Full namespaced path (`slug.rel`). */
  path: string;
  /** Connector-relative path (what policies match). */
  relPath: string;
  inputSchema: Record<string, unknown> | null;
  risk: Risk;
  binding: ActionBinding;
}

export interface ExecutionRecord {
  accountId: string;
  projectId: string;
  connectorId: string | null;
  actionPath: string;
  actingUserId: string;
  sessionId: string | null;
  status: 'ok' | 'error' | 'denied' | 'pending_approval';
  risk: Risk | null;
  resultSummary: Record<string, unknown> | null;
}

export interface EmailSessionContext {
  inboxId: string;
  threadId?: string | null;
  messageId?: string | null;
}

export interface EmailConnectorContext {
  inboxId: string;
}

export interface GatewayDeps {
  loadConnectorBySlug(projectId: string, slug: string): Promise<GatewayConnector | null>;
  loadAction(connectorId: string, relPath: string): Promise<GatewayAction | null>;
  /**
   * Resolve the credential value/binding for a connector. `userId=null` = shared;
   * set = that member's own. Receives the loaded connector so the resolver can
   * pick the credential source by provider (e.g. a channel connector's platform
   * install token) without re-querying.
   */
  resolveCredential(connector: GatewayConnector, userId: string | null): Promise<string | null>;
  /** Email-originated sessions pin native Email channel calls to the inbound inbox/thread. */
  loadEmailSessionContext?(
    projectId: string,
    sessionId: string,
  ): Promise<EmailSessionContext | null>;
  /** Email connector profiles represent one installed AgentMail inbox. */
  loadEmailConnectorContext?(
    projectId: string,
    connectorSlug: string,
  ): Promise<EmailConnectorContext | null>;
  /** Resolve the AgentMail credential for the install that owns this inbox. */
  resolveEmailCredentialForInbox?(projectId: string, inboxId: string): Promise<string | null>;
  /**
   * Meet (Recall.ai) join augmentation — the realtime webhook endpoint + bot
   * `metadata` (owning session + an HMAC token) injected server-side so Recall
   * streams transcript/chat back to us. Null when no public URL is configured or
   * the call isn't session-scoped. The sandbox never builds this callback.
   */
  resolveMeetJoinContext?(
    projectId: string,
    sessionId: string | null,
  ): Promise<{
    metadata: Record<string, unknown>;
    realtimeEndpoints: unknown[];
    automaticAudioOutput: unknown;
    botName: string;
  } | null>;
  /**
   * Inheritance pyramid (assign human → agent): the connector slugs the subject
   * inherits because they're assigned to an agent that declares them. Consulted
   * ONLY when a connector fails the direct share check — a cold, rare path
   * ('project'-scoped connectors short-circuit as usable). Optional: absent = no
   * inheritance. Implementations should memoize per (project, subject).
   */
  inheritedConnectorSlugs?(projectId: string, subject: ShareSubject): Promise<ReadonlySet<string>>;
  /** The running agent's NAME for a session (projectSessions.agent_name) — the
   *  SAME source the secret gate uses, so the connector agent-scope check agrees
   *  on identity. Consulted ONLY for a connector that is actually agent-scoped
   *  (no lookup on the common all-agents path). Absent = never scope-gate. */
  sessionAgentName?(sessionId: string): Promise<string | null>;
  /** Connector-scoped policies (relative patterns over the connector's tool paths). */
  loadPolicies(connectorId: string): Promise<Policy[]>;
  /** Project-scoped policies (fully-qualified patterns over <slug>.<path>). */
  loadProjectPolicies?(projectId: string): Promise<Policy[]>;
  /** Project's policy.default_mode setting (risk | allow_all). Defaults to allow_all. */
  loadDefaultMode?(projectId: string): Promise<DefaultMode>;
  /** Records the audit row; returns the new execution id (or null on failure)
   *  so the caller can wait on a human decision for a gated call. */
  recordExecution(rec: ExecutionRecord): Promise<string | null>;
  /** Block until a `pending_approval` execution is resolved, or `timeoutMs`
   *  elapses. Lets the gateway HOLD a require_approval call so the agent's turn
   *  pauses in-session (instead of erroring + retrying) and resumes on approve. */
  waitForApprovalDecision?(
    executionId: string,
    timeoutMs: number,
  ): Promise<'approved' | 'denied' | 'timeout'>;
  /** "Allow for this session" check: has this session already approved THIS
   *  connector + action for the rest of the session? A hit turns a
   *  `require_approval` into a silent run (no hold, no re-prompt). Only ever
   *  widens ask→run; never consulted for a policy `block`. */
  isSessionToolApproved?(
    sessionId: string,
    connectorId: string,
    actionPath: string,
  ): Promise<boolean>;
  fetchImpl: FetchImpl;
  /** Pipedream execution (Connect actions/run) — required for pipedream connectors. */
  executePipedream?(input: {
    projectId: string;
    connectorSlug: string;
    app: string;
    actionKey: string;
    args: Record<string, unknown>;
    accountId: string;
    /** Effective user for the Pipedream external_user_id (null = shared). */
    userId: string | null;
  }): Promise<ExecResult>;
  /** Pipedream Connect-Proxy execution (the generic `request` tool). */
  executePipedreamProxy?(input: {
    projectId: string;
    connectorSlug: string;
    app: string;
    /** { method, url, body?, headers? }. */
    args: Record<string, unknown>;
    accountId: string;
    userId: string | null;
  }): Promise<ExecResult>;
  /**
   * Computer (Agent Computer Tunnel) execution — required for `computer`
   * connectors. Resolves the `selector` (machine name/id, or null = sole online)
   * to a machine scoped to `accountId`, then relays `method` through the tunnel
   * permission/relay/audit core. `list_computers` is handled inside (no relay).
   */
  executeComputerCall?(input: {
    accountId: string;
    selector: string | null;
    method: string;
    args: Record<string, unknown>;
  }): Promise<ComputerCallOutcome>;
  /** OFF disables ALL policy checks (legacy allow-all). Default ON. */
  enforcePolicies?: boolean;
}

/** Result of a `computer` connector call (gateway maps it onto a CallResult). */
export type ComputerCallOutcome =
  | { ok: true; data: unknown }
  | { ok: false; kind: 'permission_required'; requestId: string; message: string }
  | { ok: false; kind: 'no_machine'; message: string }
  | { ok: false; kind: 'error'; message: string };

export interface CallInput {
  projectId: string;
  accountId: string;
  subject: ShareSubject;
  sessionId?: string | null;
  connectorSlug: string;
  /** Connector-relative action path (e.g. `charges.create`). */
  actionPath: string;
  args?: Record<string, unknown>;
  /** Set on a retry of a call already awaiting approval: wait on THIS execution
   *  rather than recording a new pending row. Powers the sandbox's poll loop
   *  that pauses the run indefinitely (short holds, re-issued) until a decision. */
  approvalExecutionId?: string | null;
}

export type CallResult =
  | { status: 'ok'; data: unknown; risk: Risk }
  | { status: 'denied'; reason: string }
  | {
      status: 'pending_approval';
      reason: string;
      /** The execution awaiting a decision — the caller re-issues the call with
       *  this id to keep waiting (poll loop). */
      executionId?: string | null;
      /** true = still unresolved after the hold; poll again to keep pausing. */
      retryable?: boolean;
    }
  | { status: 'error'; reason: string };

const SLACK_CHANNEL_ACTIONS = new Set(channelCatalog('slack').map((a) => a.path));
const EMAIL_CHANNEL_ACTIONS = new Set(channelCatalog('email').map((a) => a.path));

// How long the gateway holds a require_approval call waiting for a human
// decision before giving up (leaving it pending for the async inbox). Kept
// safely under the sandbox executor client's 60s request timeout, with headroom
// for the actual connector call to run once approved.
const APPROVAL_WAIT_MS = 45_000;

async function resolveConnectorForCall(
  deps: GatewayDeps,
  input: CallInput,
): Promise<{ slug: string; connector: GatewayConnector | null }> {
  // Back-compat for sandboxes baked before the reserved channel slug existed:
  // old `slack` CLI shims call connector="slack" with the fixed channel action
  // names. A project may also have a user-defined Pipedream connector named
  // `slack`; prefer the platform-owned channel connector for those native Slack
  // CLI actions so the user connector cannot shadow thread/history/search reads.
  if (input.connectorSlug === 'slack' && SLACK_CHANNEL_ACTIONS.has(input.actionPath)) {
    const channelConnector = await deps.loadConnectorBySlug(
      input.projectId,
      SLACK_CHANNEL_CONNECTOR_SLUG,
    );
    if (channelConnector?.enabled && channelConnector.provider === 'channel') {
      return { slug: SLACK_CHANNEL_CONNECTOR_SLUG, connector: channelConnector };
    }
  }

  if (input.connectorSlug === 'email' && EMAIL_CHANNEL_ACTIONS.has(input.actionPath)) {
    const channelConnector = await deps.loadConnectorBySlug(
      input.projectId,
      EMAIL_CHANNEL_CONNECTOR_SLUG,
    );
    if (channelConnector?.enabled && channelConnector.provider === 'channel') {
      return { slug: EMAIL_CHANNEL_CONNECTOR_SLUG, connector: channelConnector };
    }
  }

  return {
    slug: input.connectorSlug,
    connector: await deps.loadConnectorBySlug(input.projectId, input.connectorSlug),
  };
}

/** Is this connector usable for this call? Human access (sharing) + AGENT access
 *  (connector agent_scope) + credential (by mode). */
async function connectorUsable(
  deps: GatewayDeps,
  connector: GatewayConnector,
  input: CallInput,
  credentialOverride?: string | null,
): Promise<{ ok: true; secret: string | null } | { ok: false; reason: string }> {
  const { projectId, subject } = input;
  // 1. HUMAN access — who can use this connector. Direct share (project-wide or a
  // member/department grant), OR inherited via the "assign human → agent"
  // pyramid: being assigned to an agent that declares this connector grants it.
  // Inheritance is only consulted on the cold path (a restricted connector the
  // subject isn't directly granted) — project-scoped connectors short-circuit.
  if (!isSecretUsableBy(connector.shareScope, connector.grants, subject)) {
    const inherited = await deps.inheritedConnectorSlugs?.(projectId, subject);
    if (!inherited?.has(connector.slug)) {
      return { ok: false, reason: 'not_shared' };
    }
  }
  // 1b. AGENT access — which AGENTS may call this connector (the connector-side
  // agent_scope, mirror of the secret agent_scope; a DIFFERENT axis from the
  // agent-side [[agents]].connectors self-narrowing enforced at the router).
  // Resolved from the SESSION's agent name (the same source the secret gate
  // uses) so a connector scoped to [pr-bot] denies the fully-privileged
  // `default` agent exactly as secrets do. Pays the session lookup ONLY when the
  // connector is actually scoped; fail-closed if the agent can't be identified.
  if (connector.agentScope && connector.agentScope.length > 0) {
    const agentName = input.sessionId
      ? (await deps.sessionAgentName?.(input.sessionId)) ?? null
      : null;
    if (connectorDeniedForAgent(connector.agentScope, agentName)) {
      return { ok: false, reason: 'agent_not_scoped' };
    }
  }
  // 2. Credential — none needed (public), or the one shared project credential.
  // (`per_user` — each member's own — was removed 2026-07-05; every connector
  // now resolves the shared, userId-null credential.)
  if (!connector.hasAuth) return { ok: true, secret: null };
  if (credentialOverride != null) return { ok: true, secret: credentialOverride };
  const secret = await deps.resolveCredential(connector, null);
  if (secret == null) return { ok: false, reason: 'needs_auth' };
  return { ok: true, secret };
}

async function resolveEmailExecutionContext(
  deps: GatewayDeps,
  input: CallInput,
  connector: GatewayConnector,
  connectorSlug: string,
): Promise<{ args: Record<string, unknown>; secretOverride: string | null }> {
  const args = { ...(input.args ?? {}) };
  if (
    connector.provider !== 'channel' ||
    connector.platform !== 'email' ||
    !EMAIL_CHANNEL_ACTIONS.has(input.actionPath)
  ) {
    return { args, secretOverride: null };
  }

  const sessionContext =
    input.sessionId && deps.loadEmailSessionContext
      ? await deps.loadEmailSessionContext(input.projectId, input.sessionId)
      : null;
  const connectorContext =
    !sessionContext?.inboxId && deps.loadEmailConnectorContext
      ? await deps.loadEmailConnectorContext(input.projectId, connectorSlug)
      : null;
  const context = sessionContext?.inboxId ? sessionContext : connectorContext;
  if (!context?.inboxId) return { args, secretOverride: null };

  args.inbox_id = context.inboxId;
  if ('threadId' in context && input.actionPath === 'get_thread' && context.threadId) {
    args.thread_id = context.threadId;
  }
  if (
    (input.actionPath === 'reply_message' ||
      input.actionPath === 'reply_all_message' ||
      input.actionPath === 'get_message') &&
    'messageId' in context &&
    context.messageId
  ) {
    args.message_id = context.messageId;
  }

  const secretOverride =
    sessionContext?.inboxId && deps.resolveEmailCredentialForInbox
      ? await deps.resolveEmailCredentialForInbox(input.projectId, context.inboxId)
      : null;
  return { args, secretOverride };
}

/** Run one executor call through the full gateway path. */
export async function handleCall(deps: GatewayDeps, input: CallInput): Promise<CallResult> {
  const resolved = await resolveConnectorForCall(deps, input);
  const fullPath = `${resolved.slug}.${input.actionPath}`;

  const connector = resolved.connector;
  if (!connector || !connector.enabled) {
    await audit(deps, input, null, 'denied', null, { reason: 'connector_not_found' });
    return { status: 'denied', reason: 'connector_not_found' };
  }

  const action = await deps.loadAction(connector.connectorId, input.actionPath);
  if (!action) {
    await audit(deps, input, connector.connectorId, 'denied', null, { reason: 'action_not_found' });
    return { status: 'denied', reason: 'action_not_found' };
  }

  const emailExecution = await resolveEmailExecutionContext(deps, input, connector, resolved.slug);
  const usable = await connectorUsable(deps, connector, input, emailExecution.secretOverride);
  if (!usable.ok) {
    await audit(deps, input, connector.connectorId, 'denied', action.risk, {
      reason: usable.reason,
    });
    return { status: 'denied', reason: usable.reason };
  }

  let executionArgs = emailExecution.args;
  const executionSecret = usable.secret;

  // Meet (Recall.ai) live relay: on join, inject the realtime webhook + bot
  // metadata server-side so Recall streams transcript/chat back to us, tagged
  // with this session. Merges with the recording_config the caller already set.
  if (
    connector.provider === 'channel' &&
    connector.platform === 'meet' &&
    input.actionPath === 'join_meeting' &&
    deps.resolveMeetJoinContext
  ) {
    const ctx = await deps.resolveMeetJoinContext(input.projectId, input.sessionId ?? null);
    if (ctx) {
      const rc = { ...((executionArgs.recording_config as Record<string, unknown>) ?? {}) };
      const existing = Array.isArray(rc.realtime_endpoints) ? rc.realtime_endpoints : [];
      rc.realtime_endpoints = [...existing, ...ctx.realtimeEndpoints];
      executionArgs = {
        ...executionArgs,
        recording_config: rc,
        metadata: {
          ...((executionArgs.metadata as Record<string, unknown>) ?? {}),
          ...ctx.metadata,
        },
        // Enable the bot to speak (output_audio) unless the caller set its own.
        automatic_audio_output: executionArgs.automatic_audio_output ?? ctx.automaticAudioOutput,
        // The project's configured bot display name, unless the caller passed one.
        bot_name: executionArgs.bot_name ?? ctx.botName,
      };
    }
  }

  // Layered policy enforcement: project policies first → connector → risk default.
  if (deps.enforcePolicies !== false) {
    const [connectorPolicies, projectPolicies, defaultMode] = await Promise.all([
      deps.loadPolicies(connector.connectorId),
      deps.loadProjectPolicies?.(input.projectId) ?? Promise.resolve([] as Policy[]),
      deps.loadDefaultMode?.(input.projectId) ?? Promise.resolve('allow_all' as DefaultMode),
    ]);
    const decision = resolveEffectiveAction({
      fullPath,
      relPath: input.actionPath,
      projectPolicies,
      connectorPolicies,
      risk: action.risk,
      defaultMode,
      sensitive: connector.sensitive,
    });
    if (decision.action === 'block') {
      await audit(deps, input, connector.connectorId, 'denied', action.risk, {
        reason: 'policy_block',
        policy_source: decision.source,
      });
      return { status: 'denied', reason: 'policy_block' };
    }
    if (decision.action === 'require_approval') {
      // "Allow for this session": if a human already said allow-for-the-session
      // for THIS connector + action, skip the gate — run it silently, no hold,
      // no re-prompt. Audited as `ok` (reason session_allow) so the timeline
      // still shows the call happened + why it wasn't asked.
      const sessionAllowed =
        input.sessionId && deps.isSessionToolApproved
          ? await deps.isSessionToolApproved(
              input.sessionId,
              connector.connectorId,
              input.actionPath,
            )
          : false;
      if (sessionAllowed) {
        await audit(deps, input, connector.connectorId, 'ok', action.risk, {
          reason: 'session_allow',
          policy_source: decision.source,
        });
      } else {
        // A retry from the sandbox's poll loop passes the existing execution id —
        // wait on THAT row instead of stacking a new pending one each poll. First
        // call records a fresh pending row.
        const executionId =
          input.approvalExecutionId ??
          (await audit(deps, input, connector.connectorId, 'pending_approval', action.risk, {
            reason: 'policy_require_approval',
            policy_source: decision.source,
          }));
        // HOLD the call so the agent's turn pauses in-session — the sandbox's
        // synchronous executor.call blocks on this request instead of erroring.
        // Bounded under the client's 60s timeout: on approve we fall through and
        // run the action; on deny we return a clean refusal the agent continues
        // past; on TIMEOUT we return `retryable` + the execution id so the sandbox
        // re-issues the call and keeps pausing INDEFINITELY (like a question).
        // Unattended (no session) never waits.
        if (executionId && input.sessionId && deps.waitForApprovalDecision) {
          const outcome = await deps.waitForApprovalDecision(executionId, APPROVAL_WAIT_MS);
          if (outcome === 'denied') {
            return { status: 'denied', reason: 'denied_by_user' };
          }
          if (outcome === 'timeout') {
            return {
              status: 'pending_approval',
              reason: 'policy_require_approval',
              executionId,
              retryable: true,
            };
          }
          // approved → fall through to execute the call below.
        } else {
          return {
            status: 'pending_approval',
            reason: 'policy_require_approval',
            executionId,
            retryable: false,
          };
        }
      }
    }
  }

  try {
    // Computer (Agent Computer Tunnel): relay through the shared tunnel RPC core
    // instead of an HTTP call. The machine selector rides in `args.computer`.
    if (connector.provider === 'computer') {
      if (action.binding.kind !== 'tunnel') {
        throw new Error(`computer connector has unexpected binding kind "${action.binding.kind}"`);
      }
      if (!deps.executeComputerCall) throw new Error('computer runner not wired');
      const { computer: selectorRaw, ...rest } = executionArgs;
      const selector =
        typeof selectorRaw === 'string' && selectorRaw.trim() ? selectorRaw.trim() : null;
      const outcome = await deps.executeComputerCall({
        accountId: input.accountId,
        selector,
        method: action.binding.method,
        args: rest,
      });
      if (outcome.ok) {
        await audit(deps, input, connector.connectorId, 'ok', action.risk, {
          method: action.binding.method,
        });
        return { status: 'ok', data: outcome.data, risk: action.risk };
      }
      if (outcome.kind === 'permission_required') {
        await audit(deps, input, connector.connectorId, 'pending_approval', action.risk, {
          reason: 'tunnel_permission_required',
          request_id: outcome.requestId,
        });
        return {
          status: 'pending_approval',
          reason: `computer_permission_required: approve in Computers (request ${outcome.requestId})`,
        };
      }
      await audit(deps, input, connector.connectorId, 'error', action.risk, {
        reason: outcome.message.slice(0, 500),
      });
      logger.warn(`[executor] ${fullPath} computer call failed: ${outcome.message.slice(0, 500)}`);
      return { status: 'error', reason: outcome.message };
    }

    let result: ExecResult;
    if (connector.provider === 'pipedream') {
      const b = action.binding;
      if (!usable.secret) {
        throw new Error(
          'pipedream connector has no connected account (run `kortix connectors connect`)',
        );
      }
      // Always the shared (project-wide) Pipedream external-user binding —
      // `per_user` (each member's own) was removed 2026-07-05.
      const userId = null;
      if (b.kind === 'pipedream') {
        if (!deps.executePipedream) throw new Error('pipedream action runner not wired');
        result = await deps.executePipedream({
          projectId: input.projectId,
          connectorSlug: input.connectorSlug,
          app: b.app,
          actionKey: b.actionKey,
          args: executionArgs,
          accountId: usable.secret, // the resolved binding = Pipedream account id
          userId,
        });
      } else if (b.kind === 'pipedream_proxy') {
        if (!deps.executePipedreamProxy) throw new Error('pipedream proxy runner not wired');
        result = await deps.executePipedreamProxy({
          projectId: input.projectId,
          connectorSlug: input.connectorSlug,
          app: b.app,
          args: executionArgs,
          accountId: usable.secret,
          userId,
        });
      } else {
        throw new Error(`pipedream connector has unexpected binding kind "${b.kind}"`);
      }
    } else {
      result = await executeCall({
        binding: action.binding,
        baseUrl: connector.baseUrl,
        auth: connector.auth,
        secret: executionSecret,
        args: executionArgs,
        paramHints: paramHintsFromSchema(action.inputSchema),
        fetchImpl: deps.fetchImpl,
      });
      // Channel platforms (Slack) reply HTTP 200 with an `{ ok:false, error }`
      // envelope on failure. Surface that as a real error so the agent gets the
      // cause (matching the in-sandbox CLI, which throws on `!ok`).
      if (connector.provider === 'channel') result = mapChannelEnvelope(result);
    }
    if (result.ok) {
      await audit(deps, input, connector.connectorId, 'ok', action.risk, {
        http_status: result.status,
      });
      return { status: 'ok', data: result.data, risk: action.risk };
    }
    const reason = upstreamReason(result) + fallbackHint(connector, action.binding);
    await audit(deps, input, connector.connectorId, 'error', action.risk, {
      http_status: result.status,
      reason: reason.slice(0, 500),
    });
    logger.warn(
      `[executor] ${fullPath} failed (upstream ${result.status}): ${reason.slice(0, 500)}`,
    );
    return { status: 'error', reason };
  } catch (e) {
    const reason = (e as Error).message + fallbackHint(connector, action.binding);
    await audit(deps, input, connector.connectorId, 'error', action.risk, {
      reason: reason.slice(0, 500),
    });
    logger.warn(`[executor] ${fullPath} threw: ${reason.slice(0, 500)}`);
    return { status: 'error', reason };
  }
}

/**
 * Slack-style envelope: the Web API returns HTTP 200 even on failure, with the
 * real outcome in `{ ok: boolean, error? }`. Map `ok:false` to a failed
 * ExecResult so the gateway's normal error path surfaces the cause.
 */
function mapChannelEnvelope(result: ExecResult): ExecResult {
  const data = result.data as { ok?: unknown } | null;
  if (result.ok && data && typeof data === 'object' && data.ok === false) {
    return { ...result, ok: false };
  }
  return result;
}

/**
 * Surface the real upstream cause to the agent: string bodies verbatim (e.g. a
 * Pipedream component error message), structured bodies as a status-prefixed
 * JSON excerpt — never a bare opaque status code.
 */
function upstreamReason(result: ExecResult): string {
  if (typeof result.data === 'string' && result.data) return result.data;
  if (result.data != null) {
    try {
      const body = JSON.stringify(result.data);
      if (body && body !== '{}' && body !== 'null' && body !== '[]') {
        return `upstream_${result.status}: ${body.slice(0, 2000)}`;
      }
    } catch {
      /* unserializable body — fall through to the bare status */
    }
  }
  return `upstream_${result.status}`;
}

/**
 * Pipedream component runs can fail inside Pipedream's runtime even when the
 * connection is healthy (e.g. components that read $auth fields Connect never
 * hydrates). Every pipedream connector also exposes the proxy-backed `request`
 * tool, which talks straight to the app's API — point the agent at it so one
 * broken component doesn't dead-end the whole connector.
 */
function fallbackHint(connector: GatewayConnector, binding: ActionBinding): string {
  if (connector.provider !== 'pipedream' || binding.kind !== 'pipedream') return '';
  return ` — fallback: the \`${connector.slug}.request\` tool calls the app's API directly and is unaffected by component failures`;
}

async function audit(
  deps: GatewayDeps,
  input: CallInput,
  connectorId: string | null,
  status: ExecutionRecord['status'],
  risk: Risk | null,
  summary: Record<string, unknown> | null,
): Promise<string | null> {
  try {
    return await deps.recordExecution({
      accountId: input.accountId,
      projectId: input.projectId,
      connectorId,
      actionPath: `${input.connectorSlug}.${input.actionPath}`,
      actingUserId: input.subject.userId,
      sessionId: input.sessionId ?? null,
      status,
      risk,
      resultSummary: summary,
    });
  } catch {
    /* auditing must never break the call path */
    return null;
  }
}
