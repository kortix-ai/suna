import { logger } from '../lib/logger';
import { SLACK_CHANNEL_CONNECTOR_SLUG, channelCatalog } from './channels';
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
import { type SecretGrant, type ShareScope, type ShareSubject, isSecretUsableBy } from './share';
import type { ActionBinding, Risk } from './types';

export interface GatewayConnector {
  connectorId: string;
  slug: string;
  provider: 'pipedream' | 'mcp' | 'openapi' | 'graphql' | 'http' | 'channel' | 'computer';
  /** server / base_url / endpoint / url, per provider (null for some). */
  baseUrl: string | null;
  auth: ExecutorAuth;
  /** Whether this connector needs a credential at all (false = public/no-auth). */
  hasAuth: boolean;
  /** Who can use it. */
  shareScope: ShareScope;
  grants: SecretGrant[];
  /** shared = one project credential; per_user = each member's own. */
  credentialMode: 'shared' | 'per_user';
  enabled: boolean;
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
  /** Connector-scoped policies (relative patterns over the connector's tool paths). */
  loadPolicies(connectorId: string): Promise<Policy[]>;
  /** Project-scoped policies (fully-qualified patterns over <slug>.<path>). */
  loadProjectPolicies?(projectId: string): Promise<Policy[]>;
  /** Project's policy.default_mode setting (risk | allow_all). Defaults to allow_all. */
  loadDefaultMode?(projectId: string): Promise<DefaultMode>;
  recordExecution(rec: ExecutionRecord): Promise<void>;
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
}

export type CallResult =
  | { status: 'ok'; data: unknown; risk: Risk }
  | { status: 'denied'; reason: string }
  | { status: 'pending_approval'; reason: string }
  | { status: 'error'; reason: string };

const SLACK_CHANNEL_ACTIONS = new Set(channelCatalog('slack').map((a) => a.path));

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

  return {
    slug: input.connectorSlug,
    connector: await deps.loadConnectorBySlug(input.projectId, input.connectorSlug),
  };
}

/** Is this connector usable by the subject? Access (connector sharing) + credential (by mode). */
async function connectorUsable(
  deps: GatewayDeps,
  connector: GatewayConnector,
  subject: ShareSubject,
): Promise<{ ok: true; secret: string | null } | { ok: false; reason: string }> {
  // 1. Access — who can use this connector.
  if (!isSecretUsableBy(connector.shareScope, connector.grants, subject)) {
    return { ok: false, reason: 'not_shared' };
  }
  // 2. Credential — none needed (public), shared, or this member's own (per_user).
  if (!connector.hasAuth) return { ok: true, secret: null };
  const userId = connector.credentialMode === 'per_user' ? subject.userId : null;
  const secret = await deps.resolveCredential(connector, userId);
  if (secret == null) return { ok: false, reason: 'needs_auth' };
  return { ok: true, secret };
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

  const usable = await connectorUsable(deps, connector, input.subject);
  if (!usable.ok) {
    await audit(deps, input, connector.connectorId, 'denied', action.risk, {
      reason: usable.reason,
    });
    return { status: 'denied', reason: usable.reason };
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
    });
    if (decision.action === 'block') {
      await audit(deps, input, connector.connectorId, 'denied', action.risk, {
        reason: 'policy_block',
        policy_source: decision.source,
      });
      return { status: 'denied', reason: 'policy_block' };
    }
    if (decision.action === 'require_approval') {
      await audit(deps, input, connector.connectorId, 'pending_approval', action.risk, {
        reason: 'policy_require_approval',
        policy_source: decision.source,
      });
      return { status: 'pending_approval', reason: 'policy_require_approval' };
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
      const { computer: selectorRaw, ...rest } = input.args ?? {};
      const selector = typeof selectorRaw === 'string' && selectorRaw.trim() ? selectorRaw.trim() : null;
      const outcome = await deps.executeComputerCall({
        accountId: input.accountId,
        selector,
        method: action.binding.method,
        args: rest,
      });
      if (outcome.ok) {
        await audit(deps, input, connector.connectorId, 'ok', action.risk, { method: action.binding.method });
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
      await audit(deps, input, connector.connectorId, 'error', action.risk, { reason: outcome.message.slice(0, 500) });
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
      const userId = connector.credentialMode === 'per_user' ? input.subject.userId : null;
      if (b.kind === 'pipedream') {
        if (!deps.executePipedream) throw new Error('pipedream action runner not wired');
        result = await deps.executePipedream({
          projectId: input.projectId,
          connectorSlug: input.connectorSlug,
          app: b.app,
          actionKey: b.actionKey,
          args: input.args ?? {},
          accountId: usable.secret, // the resolved binding = Pipedream account id
          userId,
        });
      } else if (b.kind === 'pipedream_proxy') {
        if (!deps.executePipedreamProxy) throw new Error('pipedream proxy runner not wired');
        result = await deps.executePipedreamProxy({
          projectId: input.projectId,
          connectorSlug: input.connectorSlug,
          app: b.app,
          args: input.args ?? {},
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
        secret: usable.secret,
        args: input.args ?? {},
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
): Promise<void> {
  try {
    await deps.recordExecution({
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
  }
}
