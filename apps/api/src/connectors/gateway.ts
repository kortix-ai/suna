import { logger } from '../lib/logger';
import { buildArgsPreviewDetails, summarizeArgsPreview } from './args-preview';
import {
  emailChannelAttachmentArgs,
  findAttachmentRefs,
  redactInlineBytes,
  resolveAttachmentRefs,
} from './attachment-inline';
import type { ConnectorAttachmentStore } from './attachments';
import type { ChannelReadGate, ChannelReadInput } from './channel-read-scope';
import type { ChannelWriteGate } from './channel-write-scope';
import { executeComposio } from './composio';
import {
  EMAIL_CHANNEL_CONNECTOR_SLUG,
  SLACK_CHANNEL_CONNECTOR_SLUG,
  channelCatalog,
  withChannelDefaults,
} from './channels';
import {
  type ExecResult,
  type ConnectorAuth,
  type FetchImpl,
  executeCall,
  paramHintsFromSchema,
} from './call';
/**
 * Connector gateway — the chokepoint every tool call goes through. Resolves the
 * connector + action, resolves the credential SERVER-SIDE, runs the call,
 * audits it. The sandbox never holds an app secret. Connectors are
 * project-wide visible (no per-connector member/agent scoping) — the only
 * access gate is the agent-side `[[agents]].connectors` grant, enforced at the
 * router before this is ever reached.
 *
 * Policy enforcement is layered:
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
import { connectorRequestDigest } from './request-digest';
import type { ShareSubject } from './share';
import type { ActionBinding, Risk } from './types';
import type { ConnectionOwnerType } from '../projects/lib/connection-access';

export interface GatewayConnector {
  connectorId: string;
  /** Legacy manifest secret name. The server resolves it through the connector boundary. */
  authSecret?: string | null;
  /** Non-secret concrete identity selected for this session. */
  connectionId?: string | null;
  connectionIsDefault?: boolean;
  connectionMetadata?: Record<string, unknown>;
  /**
   * Human-facing name + ownership of the resolved connection, carried through
   * so a successful call can echo WHICH account ran it (`CallResult.account`).
   * A transcript that never names the account cannot answer "whose mailbox
   * sent that" on read-back.
   */
  connectionLabel?: string | null;
  connectionOwnerType?: ConnectionOwnerType | null;
  slug: string;
  provider:
    | 'pipedream'
    | 'composio'
    | 'mcp'
    | 'openapi'
    | 'postman'
    | 'graphql'
    | 'http'
    | 'channel'
    | 'computer';
  platform?: string | null;
  /** Computer connectors: the paired machine of the resolved account. Null
   *  when the machine was unpaired. */
  connectionTunnelId?: string | null;
  /** server / base_url / endpoint / url, per provider (null for some). */
  baseUrl: string | null;
  auth: ConnectorAuth;
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
  connectionId: string | null;
  actionPath: string;
  actingUserId: string;
  sessionId: string | null;
  status: 'ok' | 'error' | 'denied' | 'pending_approval';
  risk: Risk | null;
  /** SHA-256 of connector + action + exact execution arguments. */
  requestDigest?: string | null;
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
  /**
   * Spec 2026-09-22 §2.5: the `X-Kortix-App-Authorization` value for a call
   * whose base URL is a Kortix App of THIS deployment in the caller's OWN
   * project — a ≤ 60 s signed assertion naming the calling session token.
   * Null for any other host. Optional: absent = never attach.
   */
  appAuthorizationFor?(input: {
    projectId: string;
    baseUrl: string;
    sessionId: string;
    tokenId: string;
  }): Promise<string | null>;
  /**
   * WHY `loadConnectorBySlug` answered null. That function collapses three
   * states into one null — no such row, a disabled row, and a row with no
   * usable connection for this session — and the gateway used to report all
   * three as `connector_not_found`. An agent told "not found" about a connector
   * it can see in `kortix connectors ls` cannot self-correct; one told
   * `connector_not_connected` can. Optional: deps without it keep the old
   * single reason.
   */
  explainMissingConnector?(
    projectId: string,
    slug: string,
  ): Promise<
    | 'connector_not_found'
    | 'connector_not_connected'
    | 'connector_disabled'
    | 'account_required'
    | 'computer_unpaired'
  >;
  /**
   * v2 X7: the retired `computer` call argument named a machine. Resolves it
   * (an account label or the machine's tunnel id) to one of the caller's
   * reachable computer accounts on `slug`. `not_computer` when `slug` is not a
   * computer connector (the argument then belongs to that connector); null
   * when nothing the caller may use matches.
   */
  selectComputerAccount?(
    projectId: string,
    slug: string,
    selector: unknown,
  ): Promise<GatewayConnector | null | 'not_computer'>;
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
  /**
   * A session's Slack post binds its thread to that session, so a human reply
   * in the thread comes back to the session instead of spawning a new one.
   * Returns the binding state echoed to the agent as `thread_binding`.
   */
  bindSlackThread?(input: {
    projectId: string;
    sessionId: string;
    channel: string;
    threadTs: string;
  }): Promise<Record<string, unknown>>;
  /**
   * Display names for the authors of a Slack history or thread read, keyed by
   * Slack user id. The agent reads `user_name` beside each `user` id. Best
   * effort: absent, failing, or slow, the read is returned unchanged.
   */
  nameSlackUsers?(input: { projectId: string; token: string; userIds: string[] }): Promise<ReadonlyMap<string, string>>;
  /**
   * Keeps a Slack or Teams channel read inside the calling project's own
   * conversations (channel-read-scope.ts). Every project in a workspace or
   * tenant resolves the same platform token, so the token alone does not.
   * Absent = unconfined: production always wires it (db-deps.ts).
   */
  gateChannelRead?(input: ChannelReadInput): Promise<ChannelReadGate>;
  /**
   * Keeps a Slack write (post, edit, delete, reaction, join) out of other
   * projects' channels and threads (channel-write-scope.ts): refused before
   * the call, and a post that landed elsewhere is taken back after it.
   * Absent = unconfined: production always wires it (db-deps.ts).
   */
  gateChannelWrite?(input: ChannelReadInput): Promise<ChannelWriteGate>;
  /** Email connections represent one installed AgentMail inbox. */
  loadEmailConnectorContext?(
    projectId: string,
    connectorSlug: string,
  ): Promise<EmailConnectorContext | null>;
  /** Resolve the AgentMail credential for the install that owns this inbox. */
  resolveEmailCredentialForInbox?(projectId: string, inboxId: string): Promise<string | null>;
  /** Private attachment staging/claim lifecycle for native email actions. */
  attachmentStore?: ConnectorAttachmentStore;
  /** Connector-scoped policies (relative patterns over the connector's tool paths). */
  loadPolicies(connectorId: string): Promise<Policy[]>;
  /** Project-scoped policies (fully-qualified patterns over <slug>.<path>). */
  loadProjectPolicies?(projectId: string): Promise<Policy[]>;
  /** Project's policy.default_mode setting (risk | allow_all). Defaults to allow_all. */
  loadDefaultMode?(projectId: string): Promise<DefaultMode>;
  /** Records the audit row; returns the new execution id used in the approval URL. */
  recordExecution(rec: ExecutionRecord): Promise<string | null>;
  /** Approval carry-over: atomically claim a recent human approval for this
   *  exact request. The callback asks the session to continue, and its next
   *  attempt consumes the approval once instead of creating another gate. */
  consumeApprovedExecution?(input: {
    sessionId: string | null;
    actingUserId: string;
    connectorId: string;
    actionPath: string;
    requestDigest: string;
  }): Promise<boolean>;
  /** Reuse a legacy client's pending row only when it identifies this exact
   *  session-bound request. Prevents a caller from relabeling another approval. */
  isPendingApprovalExecution?(input: {
    executionId: string;
    projectId: string;
    sessionId: string | null;
    actingUserId: string;
    connectorId: string;
    actionPath: string;
    requestDigest: string;
  }): Promise<boolean>;
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
  /**
   * Post an approval card into the chat thread of the session that made a
   * gated call (Slack). Resolves `posted: false` for sessions with no thread.
   * Injected so the gateway stays free of channel code.
   */
  postApprovalCard?(input: {
    projectId: string;
    sessionId: string;
    executionId: string;
    actionPath: string;
    risk: Risk;
    resultSummary: Record<string, unknown>;
    approvalUrl: string | null;
  }): Promise<{ posted: boolean }>;
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
  /** Composio execution through server-side sessions. */
  executeComposio?(input: {
    projectId: string;
    connectorSlug: string;
    connectionId: string;
    sessionId: string | null;
    toolkit: string;
    toolSlug: string;
    args: Record<string, unknown>;
    connectedAccountId: string | null;
  }): Promise<ExecResult>;
  /**
   * Computer (Agent Computer Tunnel) execution — required for `computer`
   * connectors. Relays one call to the machine of the account the generic
   * resolver chose, through the tunnel core.
   */
  executeComputerCall?(input: {
    tunnelId: string;
    accountId: string;
    projectId: string;
    sessionId: string | null;
    actorUserId: string;
    method: string;
    args: Record<string, unknown>;
  }): Promise<ComputerCallOutcome>;
  /** OFF disables ALL policy checks (legacy allow-all). Default ON. */
  enforcePolicies?: boolean;
}

/** Result of a `computer` connector call (gateway maps it onto a CallResult). */
export type ComputerCallOutcome =
  | { ok: true; data: unknown }
  | {
      ok: false;
      /** `computer_unpaired` | `computer_owner_left` (its owner left the account) |
       *  `computer_offline` | `computer_capability_not_approved`,
       *  an access refusal on the machine (`computer_access_pending` |
       *  `computer_access_denied` | `computer_access_off`), or `error` for a
       *  failure on the machine or in the relay. */
      kind:
        | 'computer_unpaired'
        | 'computer_owner_left'
        | 'computer_offline'
        | 'computer_capability_not_approved'
        | 'computer_access_pending'
        | 'computer_access_denied'
        | 'computer_access_off'
        | 'error';
      message: string;
    };

export interface CallInput {
  projectId: string;
  accountId: string;
  subject: ShareSubject;
  sessionId?: string | null;
  /** The presented account token's id (`account_tokens.token_id`), when the
   *  caller authenticated with one. With `sessionId` it identifies an agent
   *  session — the only caller that gets a Kortix App assertion. */
  actingTokenId?: string | null;
  connectorSlug: string;
  /** Connector-relative action path (e.g. `charges.create`). */
  actionPath: string;
  args?: Record<string, unknown>;
  /** @deprecated Older clients can identify an existing pending row. The
   *  gateway never blocks or polls it. */
  approvalExecutionId?: string | null;
  /** The agent's own words on what a gated call does ("sends draft X to Y").
   *  Shown to the approver next to the arguments, labelled unverified. Never
   *  sent to the provider and outside the request digest. */
  approvalContext?: string | null;
}

/** Which account a successful call ran as — echoed on the wire (router.ts). */
export interface CallResultAccount {
  connection_id: string;
  label: string;
  owner_type: string;
}

export type CallResult =
  | { status: 'ok'; data: unknown; risk: Risk; account?: CallResultAccount }
  /** `message`: the sentence the agent reads, for a denial whose fix is not in `reason` alone. */
  | { status: 'denied'; reason: string; message?: string }
  | {
      status: 'pending_approval';
      reason: string;
      /** The execution awaiting a human decision. */
      executionId?: string | null;
      /** Always false. The decision returns through the session callback. */
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
      /** Agent instruction for the asynchronous handoff. */
      approvalInstructions?: string | null;
    }
  | { status: 'error'; reason: string };

const MAX_APPROVAL_CONTEXT = 4_000;
const CARD_POST_BUDGET_MS = 5_000;
const CARD_POSTED_INSTRUCTIONS =
  'An approval card with Approve / Deny / Reply buttons was posted in the chat thread; the human decides there. Do not repost approval_url. Stop this turn — Kortix resumes the session after approve or deny.';

/** A card that is slow or fails must never fail or stall the gated call. */
async function postCardWithin(ms: number, post: () => Promise<{ posted: boolean }>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      post().then((r) => r.posted === true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } catch (error) {
    logger.warn(`[connector] approval card post failed: ${(error as Error).message}`);
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
const CONTEXT_HINT =
  ' Next time pass approval_context (CLI: --reason) describing the effect, so the approver can judge it.';

const SLACK_CHANNEL_ACTIONS = new Set(channelCatalog('slack').map((a) => a.path));
const EMAIL_CHANNEL_ACTIONS = new Set(channelCatalog('email').map((a) => a.path));

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
      return {
        slug: SLACK_CHANNEL_CONNECTOR_SLUG,
        connector: channelConnector,
      };
    }
  }

  if (input.connectorSlug === 'email' && EMAIL_CHANNEL_ACTIONS.has(input.actionPath)) {
    const channelConnector = await deps.loadConnectorBySlug(
      input.projectId,
      EMAIL_CHANNEL_CONNECTOR_SLUG,
    );
    if (channelConnector?.enabled && channelConnector.provider === 'channel') {
      return {
        slug: EMAIL_CHANNEL_CONNECTOR_SLUG,
        connector: channelConnector,
      };
    }
  }

  return {
    slug: input.connectorSlug,
    connector: await deps.loadConnectorBySlug(input.projectId, input.connectorSlug),
  };
}

/**
 * The account echo for a successful call — `undefined` when the connector
 * resolved no connection (a no-credential/public connector).
 */
function gatewayConnectorAccount(connector: GatewayConnector): CallResultAccount | undefined {
  if (!connector.connectionId) return undefined;
  return {
    connection_id: connector.connectionId,
    label: connector.connectionLabel ?? '',
    owner_type: connector.connectionOwnerType ?? 'project',
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
  // Composio never uses connector credentials. Its account binding and session
  // id are server-owned fields on the selected connector_connections row. This
  // branch also lets no-auth toolkits execute without inventing a credential.
  if (connector.provider === 'composio') {
    if (!connector.connectionId) return { ok: false, reason: 'composio_connection_missing' };
    if (!connector.hasAuth || connector.connectionMetadata?.is_no_auth === true) {
      return { ok: true, secret: null };
    }
    return typeof connector.connectionMetadata?.connected_account_id === 'string'
      ? { ok: true, secret: null }
      : { ok: false, reason: 'needs_auth' };
  }
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
  // A selected connection may carry a server-owned inbox id; legacy/default
  // connectors otherwise resolve their existing install context.
  const connectionInboxId =
    typeof connector.connectionMetadata?.inbox_id === 'string'
      ? connector.connectionMetadata.inbox_id
      : null;
  const metadataContext =
    input.sessionId && deps.loadEmailSessionContext
      ? await deps.loadEmailSessionContext(input.projectId, input.sessionId)
      : null;
  const sessionContext = connectionInboxId
    ? {
        inboxId: connectionInboxId,
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

/** Run one connector call through the full gateway path. */
/**
 * The App gate credential for this call, or null. Only an agent session (a
 * session id AND the token it presented) calling an openapi/http connector is
 * considered, and `deps.appAuthorizationFor` decides whether the base URL is an
 * App of the same project. A lookup failure never fails the call: the request
 * goes out exactly as it did before this existed.
 */
async function appAuthorizationForCall(
  deps: GatewayDeps,
  input: CallInput,
  connector: GatewayConnector,
  binding: ActionBinding,
): Promise<string | null> {
  if (!deps.appAuthorizationFor || !input.sessionId || !input.actingTokenId) return null;
  const baseUrl =
    binding.kind === 'openapi'
      ? (connector.baseUrl ?? binding.server)
      : binding.kind === 'http'
        ? connector.baseUrl
        : null;
  if (!baseUrl) return null;
  try {
    return await deps.appAuthorizationFor({
      projectId: input.projectId,
      baseUrl,
      sessionId: input.sessionId,
      tokenId: input.actingTokenId,
    });
  } catch (error) {
    logger.warn('[connector] App assertion lookup failed; calling without it', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * The connector's credential is a project secret whose audience does not
 * include the person this call acts for (projects/lib/secret-audience.ts).
 * `resolveCredential` throws it instead of returning null, so the caller is
 * told the truth — not shared with them — rather than `needs_auth`.
 */
export class CredentialNotSharedError extends Error {
  readonly reason = 'credential_not_shared';
  constructor(identifier: string) {
    super(
      `The credential ${identifier} is shared only with specific people, and this call does not run as one of them. ` +
        'It works in a private session of someone it is shared with. Ask its owner to share it with you.',
    );
    this.name = 'CredentialNotSharedError';
  }
}

export async function handleCall(deps: GatewayDeps, input: CallInput): Promise<CallResult> {
  const resolved = await resolveConnectorForCall(deps, input);
  const fullPath = `${resolved.slug}.${input.actionPath}`;

  const selection = await selectComputerAccountForCall(deps, input, resolved.slug, resolved.connector);
  if ('status' in selection) return selection;
  input = selection.input;
  const connector = selection.connector;
  if (!connector || !connector.enabled) {
    const reason = !connector
      ? deps.explainMissingConnector
        ? await deps.explainMissingConnector(input.projectId, resolved.slug)
        : 'connector_not_found'
      : 'connector_disabled';
    await audit(deps, input, null, 'denied', null, { reason });
    return { status: 'denied', reason };
  }

  const action = await deps.loadAction(connector.connectorId, input.actionPath);
  if (!action) {
    await audit(deps, input, connector, 'denied', null, {
      reason: 'action_not_found',
    });
    return { status: 'denied', reason: 'action_not_found' };
  }

  // Before any credential, approval or provider call: a read of another
  // project's conversation, or a write into it, never leaves the API.
  const channelInput: ChannelReadInput = {
    projectId: input.projectId,
    platform: connector.platform ?? null,
    actionPath: input.actionPath,
    args: input.args ?? {},
    risk: action.risk,
  };
  const channelGate =
    connector.provider === 'channel' && deps.gateChannelRead ? await deps.gateChannelRead(channelInput) : null;
  const channelWrite =
    connector.provider === 'channel' && deps.gateChannelWrite ? await deps.gateChannelWrite(channelInput) : null;
  const channelRefusal = channelGate?.refusal ?? channelWrite?.refusal ?? null;
  if (channelRefusal) {
    const { reason, message } = channelRefusal;
    await audit(deps, input, connector, 'denied', action.risk, { reason, message });
    return { status: 'denied', reason, message };
  }

  const emailExecution = await resolveEmailExecutionContext(deps, input, connector, resolved.slug);
  let usable: Awaited<ReturnType<typeof connectorUsable>>;
  try {
    usable = await connectorUsable(deps, connector, input, emailExecution.secretOverride);
  } catch (error) {
    if (error instanceof CredentialNotSharedError) {
      await audit(deps, input, connector, 'denied', action.risk, { reason: error.reason });
      return { status: 'denied', reason: error.reason, message: error.message };
    }
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
  const requestDigest = connectorRequestDigest(
    input.connectorSlug,
    input.actionPath,
    executionArgs,
    {
      connectionId: connector.connectionId ?? null,
      provider: connector.provider,
      baseUrl: connector.baseUrl,
      binding: action.binding,
    },
  );

  // Layered enforcement: project → connection → risk default.
  if (deps.enforcePolicies !== false) {
    const gated = await enforceCallPolicies(
      deps,
      input,
      connector,
      action,
      fullPath,
      executionArgs,
      requestDigest,
    );
    if (gated) return gated;
  }

  return runConnectorAction(
    deps,
    input,
    connector,
    action,
    fullPath,
    executionArgs,
    executionSecret,
    channelGate,
    channelWrite,
  );
}

// v2 X7: older agents select a machine with a `computer` argument. Map it to
// that account and strip it; relaying it would run the call on the default
// machine instead. An unknown name is refused, never ignored.
async function selectComputerAccountForCall(
  deps: GatewayDeps,
  input: CallInput,
  slug: string,
  connector: GatewayConnector | null,
): Promise<CallResult | { input: CallInput; connector: GatewayConnector | null }> {
  if (input.args && Object.hasOwn(input.args, 'computer') && deps.selectComputerAccount) {
    const { computer: selector, ...args } = input.args;
    const selected = await deps.selectComputerAccount(input.projectId, slug, selector);
    if (selected !== 'not_computer') {
      input = { ...input, args };
      if (!selected) {
        const reason = `account_not_found: no computer account you can use matches "${String(selector).slice(0, 120)}". Select the computer with --account "<name>".`;
        await audit(deps, input, null, 'denied', null, { reason: 'account_not_found' });
        return { status: 'denied', reason };
      }
      connector = selected;
    }
  }
  return { input, connector };
}

/**
 * Layered enforcement: project → connection → risk default. Returns the
 * result to answer with when policy blocks the call or holds it for approval,
 * or null when the call may run.
 */
async function enforceCallPolicies(
  deps: GatewayDeps,
  input: CallInput,
  connector: GatewayConnector,
  action: GatewayAction,
  fullPath: string,
  executionArgs: Record<string, unknown>,
  requestDigest: string,
): Promise<CallResult | null> {
  const [connectorPolicies, projectPolicies, defaultMode] = await Promise.all([
    deps.loadPolicies(connector.connectorId),
    deps.loadProjectPolicies?.(input.projectId) ?? Promise.resolve([] as Policy[]),
    deps.loadDefaultMode?.(input.projectId) ?? Promise.resolve('allow_all' as DefaultMode),
  ]);
  // Built once per gated call: the redacted preview goes in the audit row and
  // the one-liner rides alongside the link, so an out-of-band relay ("approve
  // this: <url>") is still specific about what is being approved.
  const argsPreviewDetails = buildArgsPreviewDetails(executionArgs);
  const argsPreview = argsPreviewDetails.preview;
  const approvalContext =
    input.approvalContext?.trim().slice(0, MAX_APPROVAL_CONTEXT) || null;
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
      ...(url
        ? {
            approvalInstructions: input.sessionId
              ? `Share approval_url with a human, then stop this turn. Kortix resumes the session after approve or deny.${approvalContext ? '' : CONTEXT_HINT}`
              : `Share approval_url with a human. Retry this exact call once they approve it.${approvalContext ? '' : CONTEXT_HINT}`,
          }
        : {}),
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
    await audit(
      deps,
      input,
      connector,
      'denied',
      action.risk,
      {
        reason: 'policy_block',
        policy_source: decision.source,
        args_preview_complete: argsPreviewDetails.complete,
        // A block is only auditable if you can see WHAT was blocked — otherwise
        // "denied gmail.send_email" can't be told apart from a false positive.
        args_preview: argsPreview,
      },
      requestDigest,
    );
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
    // Historical session grants remain in the ledger for audit only. No
    // runtime dependency can consult them for authorization.
    //
    // Approval carry-over claims one human approval for the exact request
    // digest after the decision callback asks the session to continue.
    const carriedOver = deps.consumeApprovedExecution
      ? await deps.consumeApprovedExecution({
          sessionId: input.sessionId ?? null,
          actingUserId: input.subject.userId,
          connectorId: connector.connectorId,
          // The audit-row form (see audit() below), NOT the relative form.
          actionPath: `${input.connectorSlug}.${input.actionPath}`,
          requestDigest,
        })
      : false;
    if (carriedOver) {
      await audit(deps, input, connector, 'ok', action.risk, {
        reason: 'approval_carryover',
        policy_source: decision.source,
      });
    } else {
      // Older clients can pass an existing id. Preserve that row instead of
      // stacking another one, but never poll it. New clients make one request
      // and wait for the server-side session callback.
      const reuseExisting =
        input.approvalExecutionId && deps.isPendingApprovalExecution
          ? await deps.isPendingApprovalExecution({
              executionId: input.approvalExecutionId,
              projectId: input.projectId,
              sessionId: input.sessionId ?? null,
              actingUserId: input.subject.userId,
              connectorId: connector.connectorId,
              actionPath: `${input.connectorSlug}.${input.actionPath}`,
              requestDigest,
            })
          : false;
      const executionId =
        (reuseExisting ? input.approvalExecutionId : null) ??
        (await audit(
          deps,
          input,
          connector,
          'pending_approval',
          action.risk,
          {
            reason: 'policy_require_approval',
            policy_source: decision.source,
            args_preview_complete: argsPreviewDetails.complete,
            // WITHOUT THIS the approval prompt can name the tool but not its
            // target — a human was being asked to authorise `gmail.send_email`
            // with no way to see who it emails. Redacted (see args-preview.ts):
            // credential-shaped fields never reach the audit trail.
            args_preview: argsPreview,
            // Reference args (`{draft_id}`) name a target without showing it,
            // so the agent may describe the effect. Unverified by design.
            ...(approvalContext ? { approval_context: approvalContext } : {}),
          },
          requestDigest,
        ));
      const extras = approvalExtras(executionId);
      const cardPosted =
        !reuseExisting && executionId && input.sessionId && deps.postApprovalCard
          ? await postCardWithin(CARD_POST_BUDGET_MS, () =>
              deps.postApprovalCard!({
                projectId: input.projectId,
                sessionId: input.sessionId!,
                executionId,
                actionPath: `${input.connectorSlug}.${input.actionPath}`,
                risk: action.risk,
                resultSummary: {
                  args_preview: argsPreview,
                  args_preview_complete: argsPreviewDetails.complete,
                  ...(approvalContext ? { approval_context: approvalContext } : {}),
                },
                approvalUrl: extras.approvalUrl ?? null,
              }),
            )
          : false;
      return {
        status: 'pending_approval',
        reason: 'policy_require_approval',
        executionId,
        retryable: false,
        ...extras,
        // The human decides on the card in their thread; a pasted link next
        // to it would only duplicate the request.
        ...(cardPosted
          ? { approvalInstructions: `${CARD_POSTED_INSTRUCTIONS}${approvalContext ? '' : CONTEXT_HINT}` }
          : {}),
      };
    }
  }
  return null;
}

/**
 * Execute an authorized call on its provider and audit the outcome. Attachment
 * claims are completed on success and released on every failure.
 */
async function runConnectorAction(
  deps: GatewayDeps,
  input: CallInput,
  connector: GatewayConnector,
  action: GatewayAction,
  fullPath: string,
  executionArgs: Record<string, unknown>,
  executionSecret: string | null,
  channelGate: ChannelReadGate | null,
  channelWrite: ChannelWriteGate | null,
): Promise<CallResult> {
  let attachmentClaim: Awaited<ReturnType<ConnectorAttachmentStore['claimForEmail']>> | null = null;
  let attachmentRefs: ReturnType<typeof findAttachmentRefs> = [];
  try {
    // `{ "$kortix_attachment": id }` references. The bytes are resolved only
    // into the provider-bound copy of the arguments, below.
    const isEmailChannel = connector.provider === 'channel' && connector.platform === 'email';
    attachmentRefs = findAttachmentRefs(executionArgs);
    if (
      attachmentRefs.length > 0 &&
      (connector.provider === 'pipedream' ||
        connector.provider === 'composio' ||
        connector.provider === 'computer')
    ) {
      // These runners take provider-native file inputs. Forwarding the
      // reference would deliver the message without its file.
      throw new Error(
        `connector_attachments_unsupported: ${connector.provider} connectors do not accept Kortix attachments`,
      );
    }

    // Computers (Agent Computer Tunnel): the generic resolver chose the
    // account; its machine receives the call through the shared tunnel core.
    if (connector.provider === 'computer') {
      return await runComputerCall(deps, input, connector, action, executionArgs, fullPath);
    }

    let result: ExecResult;
    if (connector.provider === 'pipedream') {
      result = await runPipedreamAction(deps, input, connector, action.binding, executionSecret, executionArgs);
    } else if (connector.provider === 'composio') {
      result = await runComposioAction(deps, input, connector, action.binding, executionArgs);
    } else {
      let providerArgs =
        connector.provider === 'channel'
          ? withChannelDefaults(connector.platform ?? '', input.actionPath, executionArgs)
          : executionArgs;
      const scope = {
        accountId: input.accountId,
        projectId: input.projectId,
        sessionId: input.sessionId ?? null,
        userId: input.subject.userId,
      };
      if (isEmailChannel) {
        // The Email channel sends files by signed URL: references become the
        // channel's own `{ attachment_id }` handles, then the URL claim runs.
        const emailArgs =
          attachmentRefs.length > 0
            ? emailChannelAttachmentArgs(executionArgs, attachmentRefs)
            : executionArgs;
        if (!deps.attachmentStore && hasAttachmentHandles(emailArgs)) {
          throw new Error('connector_attachment_transport_unavailable');
        }
        if (deps.attachmentStore) {
          attachmentClaim = await deps.attachmentStore.claimForEmail(scope, emailArgs);
          providerArgs = attachmentClaim.args;
        }
      } else if (attachmentRefs.length > 0) {
        if (!deps.attachmentStore?.claimInline) {
          throw new Error('connector_attachment_transport_unavailable');
        }
        const claim = await deps.attachmentStore.claimInline(scope, [
          ...new Set(attachmentRefs.map((ref) => ref.attachmentId)),
        ]);
        // Record the claim before resolving, so a shape refusal releases it.
        attachmentClaim = {
          args: executionArgs,
          claimToken: claim.claimToken,
          attachmentIds: claim.attachmentIds,
        };
        providerArgs = resolveAttachmentRefs(
          executionArgs,
          action.inputSchema,
          attachmentRefs,
          claim.files,
        );
      }
      result = await executeCall({
        binding: action.binding,
        baseUrl: connector.baseUrl,
        auth: connector.auth,
        headers: connector.headers,
        secret: executionSecret,
        args: providerArgs,
        paramHints: paramHintsFromSchema(action.inputSchema),
        appAuthorization: await appAuthorizationForCall(deps, input, connector, action.binding),
        fetchImpl: deps.fetchImpl,
      });
      // Channel platforms (Slack) reply HTTP 200 with an `{ ok:false, error }`
      // envelope on failure. Surface that as a real error so the agent gets the
      // cause (matching the in-sandbox CLI, which throws on `!ok`).
      if (connector.provider === 'channel') result = mapChannelEnvelope(result);
      // A list can hold other projects' conversations, and a thread read can
      // answer with a different thread: the gate sees the answer first.
      const scoped = result.ok && channelGate ? await channelGate.answer(result.data) : null;
      if (scoped && 'refusal' in scoped) {
        if (attachmentClaim?.claimToken) {
          await deps.attachmentStore
            ?.releaseClaim(attachmentClaim.claimToken, attachmentClaim.attachmentIds)
            .catch(() => {});
        }
        const { reason, message } = scoped.refusal;
        await audit(deps, input, connector, 'denied', action.risk, { reason, message });
        return { status: 'denied', reason, message };
      }
      if (scoped) result = { ...result, data: scoped.data };
      // A post that Slack delivered somewhere other than the conversation that
      // was checked (it resolved a name) is taken back, then refused.
      const misfire = result.ok && channelWrite ? channelWrite.misfire(result.data) : null;
      if (misfire) {
        const undone = misfire.undo
          ? await executeCall({
              binding: { kind: 'http', method: 'POST', path: misfire.undo.path },
              baseUrl: connector.baseUrl,
              auth: connector.auth,
              headers: connector.headers,
              secret: executionSecret,
              args: misfire.undo.args,
              fetchImpl: deps.fetchImpl,
            })
              .then((undo) => mapChannelEnvelope(undo).ok)
              .catch(() => false)
          : false;
        const { reason } = misfire.refusal;
        const message = `${misfire.refusal.message} ${undone ? 'Kortix removed it.' : 'Kortix could not remove it: delete it in Slack.'}`;
        await audit(deps, input, connector, 'denied', action.risk, { reason, message, removed: undone });
        return { status: 'denied', reason, message };
      }
    }
    if (result.ok) {
      if (attachmentClaim?.claimToken) {
        await deps.attachmentStore
          ?.completeClaim(attachmentClaim.claimToken, attachmentClaim.attachmentIds)
          .catch((error) => {
            logger.error('[connector] attachment completion failed after provider success', {
              error: error instanceof Error ? error.message : String(error),
              attachment_count: attachmentClaim?.attachmentIds.length ?? 0,
            });
          });
      }
      await audit(deps, input, connector, 'ok', action.risk, {
        http_status: result.status,
        ...(attachmentClaim?.attachmentIds.length
          ? { attachment_count: attachmentClaim.attachmentIds.length }
          : {}),
      });
      const named = await withSlackAuthorNames(deps, input, connector, executionSecret, result.data);
      const data = await withSlackThreadBinding(deps, input, connector, executionArgs, named);
      return { status: 'ok', data, risk: action.risk, account: gatewayConnectorAccount(connector) };
    }
    if (attachmentClaim?.claimToken) {
      await deps.attachmentStore
        ?.releaseClaim(attachmentClaim.claimToken, attachmentClaim.attachmentIds)
        .catch(() => {});
    }
    // An upstream that echoes the rejected body would echo the file's base64.
    const upstream = upstreamReason(result);
    const reason =
      teamsReadConsentHint(connector, result) +
      (attachmentRefs.length > 0 ? redactInlineBytes(upstream) : upstream) +
      fallbackHint(connector, action.binding);
    await audit(deps, input, connector, 'error', action.risk, {
      http_status: result.status,
      reason: reason.slice(0, 500),
    });
    const message = `[connector] ${fullPath} failed (upstream ${result.status}): ${reason.slice(0, 500)}`;
    if (connector.provider === 'composio' && result.status === 400) logger.debug(message);
    else logger.warn(message);
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
    logger.warn(`[connector] ${fullPath} threw: ${reason.slice(0, 500)}`);
    return { status: 'error', reason };
  }
}

/** Run a call on a paired computer through the tunnel and audit the outcome. */
async function runComputerCall(
  deps: GatewayDeps,
  input: CallInput,
  connector: GatewayConnector,
  action: GatewayAction,
  executionArgs: Record<string, unknown>,
  fullPath: string,
): Promise<CallResult> {
  if (action.binding.kind !== 'tunnel') {
    throw new Error(`computer connector has unexpected binding kind "${action.binding.kind}"`);
  }
  if (!deps.executeComputerCall) throw new Error('computer runner not wired');
  const outcome = connector.connectionTunnelId
    ? await deps.executeComputerCall({
        tunnelId: connector.connectionTunnelId,
        accountId: input.accountId,
        projectId: input.projectId,
        sessionId: input.sessionId ?? null,
        actorUserId: input.subject.userId,
        method: action.binding.method,
        args: executionArgs,
      })
    : ({
        ok: false,
        kind: 'computer_unpaired',
        message: 'This computer was unpaired. Pair it again to use it.',
      } as const);
  if (outcome.ok) {
    await audit(deps, input, connector, 'ok', action.risk, {
      method: action.binding.method,
    });
    return { status: 'ok', data: outcome.data, risk: action.risk, account: gatewayConnectorAccount(connector) };
  }
  await audit(deps, input, connector, 'error', action.risk, {
    reason: outcome.kind,
    message: outcome.message.slice(0, 500),
  });
  if (outcome.kind !== 'error') {
    return { status: 'error', reason: `${outcome.kind}: ${outcome.message}` };
  }
  logger.warn(`[connector] ${fullPath} computer call failed: ${outcome.message.slice(0, 500)}`);
  return { status: 'error', reason: outcome.message };
}

/** A Pipedream action or proxy call on the connected account `secret`. */
async function runPipedreamAction(
  deps: GatewayDeps,
  input: CallInput,
  connector: GatewayConnector,
  b: ActionBinding,
  secret: string | null,
  executionArgs: Record<string, unknown>,
): Promise<ExecResult> {
  if (!secret) {
    throw new Error(
      'pipedream connector has no connected account (run `kortix connectors connect`)',
    );
  }
  // A session-selected connection gets its own stable Pipedream external-user
  // identity. The legacy/default connection preserves the existing shared
  // `${projectId}:${slug}` identity for backwards compatibility.
  const userId =
    connector.connectionId && !connector.connectionIsDefault ? connector.connectionId : null;
  if (b.kind === 'pipedream') {
    if (!deps.executePipedream) throw new Error('pipedream action runner not wired');
    return await deps.executePipedream({
      projectId: input.projectId,
      connectorSlug: input.connectorSlug,
      app: b.app,
      actionKey: b.actionKey,
      args: executionArgs,
      accountId: secret, // the resolved binding = Pipedream account id
      userId,
    });
  } else if (b.kind === 'pipedream_proxy') {
    if (!deps.executePipedreamProxy) throw new Error('pipedream proxy runner not wired');
    return await deps.executePipedreamProxy({
      projectId: input.projectId,
      connectorSlug: input.connectorSlug,
      app: b.app,
      args: executionArgs,
      accountId: secret,
      userId,
    });
  } else {
    throw new Error(`pipedream connector has unexpected binding kind "${b.kind}"`);
  }
}

/** A Composio tool call on the connection's server-owned account and session. */
async function runComposioAction(
  deps: GatewayDeps,
  input: CallInput,
  connector: GatewayConnector,
  b: ActionBinding,
  executionArgs: Record<string, unknown>,
): Promise<ExecResult> {
  if (b.kind !== 'composio') {
    throw new Error(`composio connector has unexpected binding kind "${b.kind}"`);
  }
  if (!connector.connectionId) throw new Error('composio_connection_missing');
  const persistedSessionId =
    typeof connector.connectionMetadata?.session_id === 'string'
      ? connector.connectionMetadata.session_id
      : null;
  const connectedAccountId =
    typeof connector.connectionMetadata?.connected_account_id === 'string'
      ? connector.connectionMetadata.connected_account_id
      : null;
  const runner = deps.executeComposio ?? executeComposio;
  return await runner({
    projectId: input.projectId,
    connectorSlug: input.connectorSlug,
    connectionId: connector.connectionId,
    sessionId: persistedSessionId,
    toolkit: b.toolkit,
    toolSlug: b.toolSlug,
    args: executionArgs,
    connectedAccountId,
  });
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
 * After a session posts to Slack, bind the thread to that session: the new
 * message's own `ts` for a top-level post, `thread_ts` for a reply. The
 * session comes from the caller's token (never the request body), so a post
 * can only route replies to the session that made it. A bind failure never
 * fails the delivered message; the agent sees it in `thread_binding`.
 */
async function withSlackThreadBinding(
  deps: GatewayDeps,
  input: CallInput,
  connector: GatewayConnector,
  args: Record<string, unknown>,
  data: unknown,
): Promise<unknown> {
  if (
    !deps.bindSlackThread ||
    !input.sessionId ||
    connector.provider !== 'channel' ||
    connector.platform !== 'slack' ||
    input.actionPath !== 'send_message' ||
    !data ||
    typeof data !== 'object'
  ) {
    return data;
  }
  const posted = data as { ts?: unknown; channel?: unknown };
  const threadTs = typeof args.thread_ts === 'string' && args.thread_ts ? args.thread_ts : posted.ts;
  const channel = typeof posted.channel === 'string' && posted.channel ? posted.channel : args.channel;
  if (typeof threadTs !== 'string' || typeof channel !== 'string') return data;
  const threadBinding = await deps
    .bindSlackThread({ projectId: input.projectId, sessionId: input.sessionId, channel, threadTs })
    .catch((error) => {
      logger.warn('[connector] slack thread bind failed after a delivered post', {
        error: error instanceof Error ? error.message : String(error),
      });
      return { bound: false, thread_ts: threadTs, reason: 'bind_failed' };
    });
  return { ...data, thread_binding: threadBinding };
}

/** Slack reads that answer with messages. */
const SLACK_MESSAGE_READS: ReadonlySet<string> = new Set(['get_history', 'get_thread']);

/**
 * A Slack history or thread read names each message's author as `user_name`,
 * beside the `user` id the agent still operates with. Slack answers with ids
 * only, and an agent that reads ids answers with ids. Runs after the read-scope
 * gate, on the messages the agent may see. A failed lookup returns the read
 * unchanged.
 */
async function withSlackAuthorNames(
  deps: GatewayDeps,
  input: CallInput,
  connector: GatewayConnector,
  token: string | null,
  data: unknown,
): Promise<unknown> {
  if (
    !deps.nameSlackUsers ||
    !token ||
    connector.provider !== 'channel' ||
    connector.platform !== 'slack' ||
    !SLACK_MESSAGE_READS.has(input.actionPath) ||
    !data ||
    typeof data !== 'object'
  ) {
    return data;
  }
  const messages = (data as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return data;
  const authorOf = (message: unknown): string | null => {
    const user = message && typeof message === 'object' ? (message as { user?: unknown }).user : null;
    return typeof user === 'string' && user ? user : null;
  };
  const userIds = [...new Set(messages.map(authorOf).filter((id): id is string => id !== null))];
  if (userIds.length === 0) return data;
  const names = await deps.nameSlackUsers({ projectId: input.projectId, token, userIds }).catch((error) => {
    logger.warn('[connector] slack author names failed (non-fatal)', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  });
  if (!names || names.size === 0) return data;
  return {
    ...data,
    messages: messages.map((message) => {
      const name = names.get(authorOf(message) ?? '');
      return name ? { ...(message as Record<string, unknown>), user_name: name } : message;
    }),
  };
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
 * Teams refuses a read with 403 "… Resource specific consent grants on the
 * request ''" when the Kortix app in that team holds no permission to read its
 * messages: the team added it before the app asked for one, and an update that
 * adds a permission never installs itself (a team owner accepts it). Graph
 * names a permission; this names who fixes it and where. A new app version
 * reaches an organization only through a Teams admin's publish
 * (teams/catalog.ts needs their sign-in).
 */
function teamsReadConsentHint(connector: GatewayConnector, result: ExecResult): string {
  if (connector.provider !== 'channel' || connector.platform !== 'teams' || result.status !== 403) return '';
  const body = typeof result.data === 'string' ? result.data : JSON.stringify(result.data ?? '');
  if (!/Resource specific consent/i.test(body)) return '';
  return (
    'Kortix cannot read messages in this team yet: the Kortix app in the team has no permission to read them. ' +
    'A team owner updates the app in Teams (the team → ⋯ → Manage team → Apps → Update) and accepts the new permission. ' +
    'If no update is offered, a Teams admin first publishes the latest app from the Kortix project ' +
    '(Connectors → Channels → Microsoft Teams). '
  );
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
  requestDigest?: string | null,
): Promise<string | null> {
  try {
    return await deps.recordExecution({
      accountId: input.accountId,
      projectId: input.projectId,
      connectorId: connector?.connectorId ?? null,
      connectionId: connector?.connectionId ?? null,
      actionPath: `${input.connectorSlug}.${input.actionPath}`,
      actingUserId: input.subject.userId,
      sessionId: input.sessionId ?? null,
      status,
      risk,
      requestDigest: requestDigest ?? null,
      resultSummary: summary,
    });
  } catch {
    /* auditing must never break the call path */
    return null;
  }
}
