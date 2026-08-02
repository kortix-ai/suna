import { logger } from '../lib/logger';
import { buildArgsPreview, summarizeArgsPreview } from './args-preview';
import type { ExecutorAttachmentStore } from './attachments';
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
 * connector + action, resolves the credential SERVER-SIDE, runs the call,
 * audits it. The sandbox never holds an app secret. Connectors are
 * project-wide visible (no per-connector member/agent scoping) — the only
 * access gate is the agent-side `[[agents]].connectors` grant, enforced at the
 * router before this is ever reached.
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
import type { ShareSubject } from './share';
import type { ActionBinding, Risk } from './types';

export interface GatewayConnector {
  connectorId: string;
  /** Non-secret concrete identity selected for this session. */
  profileId?: string | null;
  profileIsDefault?: boolean;
  profileMetadata?: Record<string, unknown>;
  slug: string;
  provider:
    | 'pipedream'
    | 'mcp'
    | 'openapi'
    | 'postman'
    | 'graphql'
    | 'http'
    | 'channel'
    | 'computer';
  platform?: string | null;
  /** server / base_url / endpoint / url, per provider (null for some). */
  baseUrl: string | null;
  auth: ExecutorAuth;
  /** Static request headers declared on the connector (kortix.yaml `headers:`),
   *  sent on every call. Never secrets, and never able to override the auth
   *  header — executeCall merges them BEFORE the credential is attached.
   *  Optional (absent = none) so fixtures/callers needn't set it. */
  headers?: Record<string, string> | null;
  /** Whether this connector needs a credential at all (false = public/no-auth). */
  hasAuth: boolean;
  /** Always `shared` (one project credential) — `per_user` (each member's
   *  own) was removed 2026-07-05. Kept as a field for shape stability. */
  credentialMode: 'shared';
  enabled: boolean;
  /** Marked sensitive (email/files/secrets-bearing): reads gate too — every
   *  action defaults to require_approval unless an explicit policy opens it.
   *  Optional (absent = not sensitive) so fixtures/callers needn't set it. */
  sensitive?: boolean;
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
  profileId: string | null;
  actionPath: string;
  actingUserId: string;
  sessionId: string | null;
  status: 'ok' | 'error' | 'denied' | 'pending_approval';
  risk: Risk | null;
  resultSummary: Record<string, unknown> | null;
}

export interface EmailSessionContext {
  inboxId?: string | null;
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
  /** Private attachment staging/claim lifecycle for native email actions. */
  attachmentStore?: ExecutorAttachmentStore;
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
    expect?: { sessionId: string | null; connectorId: string; actionPath: string },
  ): Promise<'approved' | 'denied' | 'timeout' | 'mismatch'>;
  /** @deprecated NO LONGER CONSULTED for a decision — session-wide grants were
   *  removed (see the "SESSION-WIDE GRANTS" note in handleCall for why). Kept on
   *  interface so historical grant rows remain readable for display/audit. */
  isSessionToolApproved?(
    sessionId: string,
    connectorId: string,
    actionPath: string,
  ): Promise<boolean>;
  /** Approval carry-over: atomically claim a RECENT human approve of this
   *  (session, connector, action) whose gated call nobody is waiting on
   *  anymore — the holder timed out / the sandbox client has no poll loop —
   *  so the NEXT attempt runs instead of re-asking. Returns true when a grant
   *  was claimed (each approve is consumable exactly once). */
  consumeApprovedExecution?(input: {
    sessionId: string;
    connectorId: string;
    actionPath: string;
  }): Promise<boolean>;
  /** Mark an approve as consumed by the in-flight held/poll request that just
   *  resumed on it, so the same grant can't ALSO be carried over by a later
   *  fresh call (best-effort — a failure only risks one extra silent run). */
  markApprovalConsumed?(executionId: string): Promise<void>;
  /**
   * Mint the standalone page URL where a human signs in and decides. Injected
   * (rather than imported) so the gateway stays unit-testable without config or
   * project-key material. Returns null when the deployment can't mint one.
   */
  mintApprovalLink?(input: {
    projectId: string;
    executionId: string;
    sessionId: string | null;
  }): string | null;
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
    projectId: string;
    sessionId: string | null;
    actorUserId: string;
    selector: string | null;
    method: string;
    args: Record<string, unknown>;
  }): Promise<ComputerCallOutcome>;
  /**
   * Voice (LiveKit) channel execution — required for the `kortix_voice`
   * channel connector's `{ kind: 'voice' }`-bound actions. `op` is the
   * action's connector-relative path (`spawn_room` / `join_gmeet` /
   * `join_zoom`); only `spawn_room` is implemented, the rest resolve to a
   * `not_implemented` outcome the gateway maps onto a clear, actionable error.
   */
  executeVoiceCall?(input: {
    projectId: string;
    accountId: string;
    sessionId: string | null;
    op: string;
    args: Record<string, unknown>;
  }): Promise<VoiceCallOutcome>;
  /** OFF disables ALL policy checks (legacy allow-all). Default ON. */
  enforcePolicies?: boolean;
}

/** Result of a `computer` connector call (gateway maps it onto a CallResult). */
export type ComputerCallOutcome =
  | { ok: true; data: unknown }
  | { ok: false; kind: 'permission_required'; requestId: string; message: string }
  | { ok: false; kind: 'no_machine'; message: string }
  | { ok: false; kind: 'error'; message: string };

/**
 * Result of a voice channel action (`spawn_room` / `join_gmeet` / `join_zoom`).
 * `not_implemented` is its own outcome (not folded into `error`) so a caller
 * can tell "this mechanism doesn't exist yet" apart from a real failure —
 * `message` is expected to say what to do instead, e.g. "use spawn_room".
 */
export type VoiceCallOutcome =
  | { ok: true; data: unknown }
  | { ok: false; kind: 'not_implemented'; message: string }
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
      /**
       * Standalone page where a human signs in and decides. Handed to the agent
       * so it can relay the decision request wherever the human actually is
       * (chat, email) instead of assuming someone is watching the session.
       * Null when the deployment can't mint one.
       */
      approvalUrl?: string | null;
      /** One-line redacted "what is this?" — safe to paste alongside the link. */
      approvalSummary?: string | null;
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

/**
 * Is this connector usable for this call? Access is public-by-default —
 * connectors are project-wide visible; the ONLY gate is the agent-side
 * `[[agents]].connectors` grant (enforced earlier, at the router, via
 * `agentMayUseConnector`). This function is left with just the credential
 * check (by mode).
 */
async function connectorUsable(
  deps: GatewayDeps,
  connector: GatewayConnector,
  _input: CallInput,
  credentialOverride?: string | null,
): Promise<{ ok: true; secret: string | null } | { ok: false; reason: string }> {
  // Credential — none needed (public), or the one shared project credential.
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

  // Session metadata is user-writable and is never an authorization source.
  // A selected profile may carry a server-owned inbox id; legacy/default
  // connectors otherwise resolve their existing install context.
  const profileInboxId =
    typeof connector.profileMetadata?.inbox_id === 'string'
      ? connector.profileMetadata.inbox_id
      : null;
  const metadataContext =
    input.sessionId && deps.loadEmailSessionContext
      ? await deps.loadEmailSessionContext(input.projectId, input.sessionId)
      : null;
  const sessionContext = profileInboxId
    ? {
        inboxId: profileInboxId,
        threadId: metadataContext?.threadId ?? null,
        messageId: metadataContext?.messageId ?? null,
      }
    : null;
  const connectorContext =
    !sessionContext?.inboxId && deps.loadEmailConnectorContext
      ? await deps.loadEmailConnectorContext(input.projectId, connectorSlug)
      : null;
  const authorizedInboxContext = sessionContext?.inboxId ? sessionContext : connectorContext;
  const context = authorizedInboxContext
    ? {
        ...authorizedInboxContext,
        threadId: metadataContext?.threadId ?? null,
        messageId: metadataContext?.messageId ?? null,
      }
    : null;
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
    await audit(deps, input, connector, 'denied', null, { reason: 'action_not_found' });
    return { status: 'denied', reason: 'action_not_found' };
  }

  const emailExecution = await resolveEmailExecutionContext(deps, input, connector, resolved.slug);
  let usable: Awaited<ReturnType<typeof connectorUsable>>;
  let attachmentClaim: Awaited<ReturnType<ExecutorAttachmentStore['claimForEmail']>> | null = null;
  try {
    usable = await connectorUsable(deps, connector, input, emailExecution.secretOverride);
  } catch (error) {
    const reason = (error as Error).message || 'credential_resolution_failed';
    await audit(deps, input, connector, 'error', action.risk, {
      reason: reason.slice(0, 500),
    });
    return { status: 'error', reason };
  }
  if (!usable.ok) {
    await audit(deps, input, connector, 'denied', action.risk, {
      reason: usable.reason,
    });
    return { status: 'denied', reason: usable.reason };
  }

  const executionArgs = emailExecution.args;
  const executionSecret = usable.secret;

  // Layered enforcement: project → connector profile → risk default.
  if (deps.enforcePolicies !== false) {
    const [connectorPolicies, projectPolicies, defaultMode] = await Promise.all([
      deps.loadPolicies(connector.connectorId),
      deps.loadProjectPolicies?.(input.projectId) ?? Promise.resolve([] as Policy[]),
      deps.loadDefaultMode?.(input.projectId) ?? Promise.resolve('allow_all' as DefaultMode),
    ]);
    // Built once per gated call: the redacted preview goes in the audit row and
    // the one-liner rides alongside the link, so an out-of-band relay ("approve
    // this: <url>") is still specific about what is being approved.
    const argsPreview = buildArgsPreview(executionArgs);
    // Keys are OMITTED when empty rather than set to null: the pending_approval
    // result is a wire shape other code compares against, and a key that carries
    // no information shouldn't change it.
    const approvalExtras = (executionId: string | null | undefined) => {
      const url =
        executionId && deps.mintApprovalLink
          ? deps.mintApprovalLink({
              projectId: input.projectId,
              executionId,
              sessionId: input.sessionId ?? null,
            })
          : null;
      const summary = summarizeArgsPreview(argsPreview);
      return {
        ...(url ? { approvalUrl: url } : {}),
        ...(summary ? { approvalSummary: summary } : {}),
      };
    };

    const decision = resolveEffectiveAction({
      fullPath,
      relPath: input.actionPath,
      projectPolicies,
      connectorPolicies,
      risk: action.risk,
      defaultMode,
      sensitive: connector.sensitive,
      // Rules may also condition on the ARGUMENTS ("only to these addresses"),
      // so the engine needs the real payload. This is the post-context-injection
      // form — the same args the call will actually execute with — so a rule
      // can't be dodged by a field the gateway fills in later.
      args: executionArgs,
      argsAvailable: true,
    });
    if (decision.action === 'block') {
      await audit(deps, input, connector, 'denied', action.risk, {
        reason: 'policy_block',
        policy_source: decision.source,
        // A block is only auditable if you can see WHAT was blocked — otherwise
        // "denied gmail.send_email" can't be told apart from a false positive.
        args_preview: argsPreview,
      });
      return { status: 'denied', reason: 'policy_block' };
    }
    if (decision.action === 'require_approval') {
      // SESSION-WIDE GRANTS ARE NO LONGER HONOURED.
      //
      // "Allow for this session" / "Allow everything" used to let one click
      // pre-authorise every later call of a tool, whatever its arguments — so a
      // mail send approved for one recipient silently covered a send to any
      // other. The gate has to see each call, because the ARGUMENTS are what
      // make a call safe or not, and they change per call.
      //
      // Deliberately dropped at the ENFORCEMENT point, not just in the UI: rows
      // written before this change still exist in session_tool_approvals, and
      // reading them would keep those old grants silently bypassing the gate.
      // `isSessionToolApproved` is left on GatewayDeps (still used to display
      // history) but is no longer consulted for a decision.
      //
      // What REMAINS below is approval carry-over, which is a different thing:
      // it claims a human's approval of THIS very call when the gated request
      // that asked is no longer waiting (the 45s hold expired). It authorises
      // one already-approved call, not future ones.
      // Approval carry-over: the human approved this exact (session, connector,
      // action) recently, but the gated call that asked is no longer waiting —
      // the 45s hold expired and the client never re-polled (e.g. an older
      // sandbox CLI without the pause loop), so the approve stamped a row nobody
      // consumed. Claim that grant now: this fresh attempt IS the approved call,
      // run it instead of stacking a second ask for the same thing.
      const carriedOver =
        input.sessionId &&
        !input.approvalExecutionId &&
        deps.consumeApprovedExecution
          ? await deps.consumeApprovedExecution({
              sessionId: input.sessionId,
              connectorId: connector.connectorId,
              // The audit-row form (see audit() below), NOT the relative form.
              actionPath: `${input.connectorSlug}.${input.actionPath}`,
            })
          : false;
      if (carriedOver) {
        await audit(deps, input, connector, 'ok', action.risk, {
          reason: 'approval_carryover',
          policy_source: decision.source,
        });
      } else {
        // A retry from the sandbox's poll loop passes the existing execution id —
        // wait on THAT row instead of stacking a new pending one each poll. First
        // call records a fresh pending row.
        const executionId =
          input.approvalExecutionId ??
          (await audit(deps, input, connector, 'pending_approval', action.risk, {
            reason: 'policy_require_approval',
            policy_source: decision.source,
            // WITHOUT THIS the approval prompt can name the tool but not its
            // target — a human was being asked to authorise `gmail.send_email`
            // with no way to see who it emails. Redacted (see args-preview.ts):
            // credential-shaped fields never reach the audit trail.
            args_preview: argsPreview,
          }));
        // HOLD the call so the agent's turn pauses in-session — the sandbox's
        // synchronous executor.call blocks on this request instead of erroring.
        // Bounded under the client's 60s timeout: on approve we fall through and
        // run the action; on deny we return a clean refusal the agent continues
        // past; on TIMEOUT we return `retryable` + the execution id so the sandbox
        // re-issues the call and keeps pausing INDEFINITELY (like a question).
        // Unattended (no session) never waits.
        if (executionId && input.sessionId && deps.waitForApprovalDecision) {
          const outcome = await deps.waitForApprovalDecision(executionId, APPROVAL_WAIT_MS, {
            sessionId: input.sessionId,
            connectorId: connector.connectorId,
            actionPath: `${input.connectorSlug}.${input.actionPath}`,
          });
          if (outcome === 'mismatch') {
            // The supplied approvalExecutionId does not belong to THIS
            // (session, connector, action). Never honor another row's approval —
            // open a fresh pending gate that a human must actually resolve.
            const freshId = await audit(deps, input, connector, 'pending_approval', action.risk, {
              reason: 'policy_require_approval',
              policy_source: decision.source,
              args_preview: argsPreview,
            });
            return {
              status: 'pending_approval',
              reason: 'policy_require_approval',
              executionId: freshId ?? undefined,
              retryable: true,
              ...approvalExtras(freshId),
            };
          }
          if (outcome === 'denied') {
            // Mark the decision as consumed by this live waiter — the resolve
            // endpoint's server-side resume uses that marker to know the turn
            // already got the answer in-band (no follow-up prompt needed).
            if (deps.markApprovalConsumed) {
              await deps.markApprovalConsumed(executionId).catch(() => {});
            }
            return { status: 'denied', reason: 'denied_by_user' };
          }
          if (outcome === 'timeout') {
            return {
              status: 'pending_approval',
              reason: 'policy_require_approval',
              executionId,
              retryable: true,
              ...approvalExtras(executionId),
            };
          }
          // approved → fall through to execute the call below. Mark the grant
          // consumed so a LATER fresh call can't also carry it over.
          if (deps.markApprovalConsumed) {
            await deps.markApprovalConsumed(executionId).catch(() => {});
          }
        } else {
          return {
            status: 'pending_approval',
            reason: 'policy_require_approval',
            executionId,
            retryable: false,
            ...approvalExtras(executionId),
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
        projectId: input.projectId,
        sessionId: input.sessionId ?? null,
        actorUserId: input.subject.userId,
        selector,
        method: action.binding.method,
        args: rest,
      });
      if (outcome.ok) {
        await audit(deps, input, connector, 'ok', action.risk, {
          method: action.binding.method,
        });
        return { status: 'ok', data: outcome.data, risk: action.risk };
      }
      if (outcome.kind === 'permission_required') {
        await audit(deps, input, connector, 'pending_approval', action.risk, {
          reason: 'tunnel_permission_required',
          request_id: outcome.requestId,
        });
        return {
          status: 'pending_approval',
          reason: `computer_permission_required: approve in Computers (request ${outcome.requestId})`,
        };
      }
      await audit(deps, input, connector, 'error', action.risk, {
        reason: outcome.message.slice(0, 500),
      });
      logger.warn(`[executor] ${fullPath} computer call failed: ${outcome.message.slice(0, 500)}`);
      return { status: 'error', reason: outcome.message };
    }

    // Voice channel: server-side room creation, not an outbound HTTP call —
    // route through GatewayDeps.executeVoiceCall instead of executeCall, same
    // shape as the computer branch above.
    if (connector.provider === 'channel' && connector.platform === 'voice') {
      if (action.binding.kind !== 'voice') {
        throw new Error(`voice connector has unexpected binding kind "${action.binding.kind}"`);
      }
      if (!deps.executeVoiceCall) throw new Error('voice runner not wired');
      const outcome = await deps.executeVoiceCall({
        projectId: input.projectId,
        accountId: input.accountId,
        sessionId: input.sessionId ?? null,
        op: action.binding.op,
        args: executionArgs,
      });
      if (outcome.ok) {
        await audit(deps, input, connector, 'ok', action.risk, { op: action.binding.op });
        return { status: 'ok', data: outcome.data, risk: action.risk };
      }
      await audit(deps, input, connector, 'error', action.risk, {
        reason: outcome.message.slice(0, 500),
        kind: outcome.kind,
      });
      if (outcome.kind !== 'not_implemented') {
        logger.warn(`[executor] ${fullPath} voice call failed: ${outcome.message.slice(0, 500)}`);
      }
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
      // A session-selected profile gets its own stable Pipedream external-user
      // identity. The legacy/default profile preserves the existing shared
      // `${projectId}:${slug}` identity for backwards compatibility.
      const userId =
        connector.profileId && !connector.profileIsDefault ? connector.profileId : null;
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
      let providerArgs = executionArgs;
      if (connector.provider === 'channel' && connector.platform === 'email') {
        if (!deps.attachmentStore && hasAttachmentHandles(executionArgs)) {
          throw new Error('executor_attachment_transport_unavailable');
        }
        if (deps.attachmentStore) {
          attachmentClaim = await deps.attachmentStore.claimForEmail(
            {
              accountId: input.accountId,
              projectId: input.projectId,
              sessionId: input.sessionId ?? null,
              userId: input.subject.userId,
            },
            executionArgs,
          );
          providerArgs = attachmentClaim.args;
        }
      }
      result = await executeCall({
        binding: action.binding,
        baseUrl: connector.baseUrl,
        auth: connector.auth,
        headers: connector.headers,
        secret: executionSecret,
        args: providerArgs,
        paramHints: paramHintsFromSchema(action.inputSchema),
        fetchImpl: deps.fetchImpl,
      });
      // Channel platforms (Slack) reply HTTP 200 with an `{ ok:false, error }`
      // envelope on failure. Surface that as a real error so the agent gets the
      // cause (matching the in-sandbox CLI, which throws on `!ok`).
      if (connector.provider === 'channel') result = mapChannelEnvelope(result);
    }
    if (result.ok) {
      if (attachmentClaim?.claimToken) {
        await deps.attachmentStore
          ?.completeClaim(attachmentClaim.claimToken, attachmentClaim.attachmentIds)
          .catch((error) => {
            logger.error('[executor] attachment completion failed after provider success', {
              error: error instanceof Error ? error.message : String(error),
              attachment_count: attachmentClaim?.attachmentIds.length ?? 0,
            });
          });
      }
      await audit(deps, input, connector, 'ok', action.risk, {
        http_status: result.status,
      });
      return { status: 'ok', data: result.data, risk: action.risk };
    }
    if (attachmentClaim?.claimToken) {
      await deps.attachmentStore
        ?.releaseClaim(attachmentClaim.claimToken, attachmentClaim.attachmentIds)
        .catch(() => {});
    }
    const reason = upstreamReason(result) + fallbackHint(connector, action.binding);
    await audit(deps, input, connector, 'error', action.risk, {
      http_status: result.status,
      reason: reason.slice(0, 500),
    });
    logger.warn(
      `[executor] ${fullPath} failed (upstream ${result.status}): ${reason.slice(0, 500)}`,
    );
    return { status: 'error', reason };
  } catch (e) {
    if (attachmentClaim?.claimToken) {
      await deps.attachmentStore
        ?.releaseClaim(attachmentClaim.claimToken, attachmentClaim.attachmentIds)
        .catch(() => {});
    }
    const reason = (e as Error).message + fallbackHint(connector, action.binding);
    await audit(deps, input, connector, 'error', action.risk, {
      reason: reason.slice(0, 500),
    });
    logger.warn(`[executor] ${fullPath} threw: ${reason.slice(0, 500)}`);
    return { status: 'error', reason };
  }
}

function hasAttachmentHandles(args: Record<string, unknown>): boolean {
  if (!Array.isArray(args.attachments)) return false;
  return args.attachments.some(
    (value) =>
      value != null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof (value as Record<string, unknown>).attachment_id === 'string',
  );
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
  connector: GatewayConnector | null,
  status: ExecutionRecord['status'],
  risk: Risk | null,
  summary: Record<string, unknown> | null,
): Promise<string | null> {
  try {
    return await deps.recordExecution({
      accountId: input.accountId,
      projectId: input.projectId,
      connectorId: connector?.connectorId ?? null,
      profileId: connector?.profileId ?? null,
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
