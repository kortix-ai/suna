/**
 * Executor gateway — the chokepoint every tool call goes through. Resolves the
 * connector + action, checks the acting user can use it (project-secret
 * sharing), resolves the credential SERVER-SIDE, runs the call, audits it.
 * The sandbox never holds an app secret.
 *
 * Policy enforcement is layered:
 *   1. project-level [[policies]] (fully-qualified patterns) — admin guardrails
 *   2. connector-level [[connectors.policies]] (relative patterns) — connector-author rules
 *   3. risk-derived default (when `default_mode = risk`) or always_run (`allow_all`)
 *
 * Written against an injectable `GatewayDeps` so the full decision+execution
 * path is unit-tested with fakes (incl. a mocked third party). The HTTP router
 * (router.ts) wires real DB/secret deps.
 */
import {
  resolveEffectiveAction,
  type DefaultMode,
  type Policy,
} from './policy';
import { isSecretUsableBy, type SecretGrant, type ShareScope, type ShareSubject } from './share';
import { executeCall, paramHintsFromSchema, type ExecResult, type ExecutorAuth, type FetchImpl } from './execute';
import type { ActionBinding, Risk } from './types';

export interface GatewayConnector {
  connectorId: string;
  slug: string;
  provider: 'pipedream' | 'mcp' | 'openapi' | 'graphql' | 'http';
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

interface ExecutionRecord {
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
  /** Resolve the credential value/binding. `userId=null` = shared; set = that member's own. */
  resolveCredential(connectorId: string, userId: string | null): Promise<string | null>;
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
}

interface CallInput {
  projectId: string;
  accountId: string;
  subject: ShareSubject;
  sessionId?: string | null;
  connectorSlug: string;
  /** Connector-relative action path (e.g. `charges.create`). */
  actionPath: string;
  args?: Record<string, unknown>;
}

type CallResult =
  | { status: 'ok'; data: unknown; risk: Risk }
  | { status: 'denied'; reason: string }
  | { status: 'pending_approval'; reason: string }
  | { status: 'error'; reason: string };

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
  const secret = await deps.resolveCredential(connector.connectorId, userId);
  if (secret == null) return { ok: false, reason: 'needs_auth' };
  return { ok: true, secret };
}

/** Run one executor call through the full gateway path. */
export async function handleCall(deps: GatewayDeps, input: CallInput): Promise<CallResult> {
  const fullPath = `${input.connectorSlug}.${input.actionPath}`;

  const connector = await deps.loadConnectorBySlug(input.projectId, input.connectorSlug);
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
    await audit(deps, input, connector.connectorId, 'denied', action.risk, { reason: usable.reason });
    return { status: 'denied', reason: usable.reason };
  }

  // Layered policy enforcement: project policies first → connector → risk default.
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

  try {
    let result: ExecResult;
    if (connector.provider === 'pipedream') {
      const b = action.binding;
      if (!usable.secret) {
        throw new Error('pipedream connector has no connected account (run `kortix connectors connect`)');
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
    }
    await audit(deps, input, connector.connectorId, result.ok ? 'ok' : 'error', action.risk, {
      http_status: result.status,
    });
    return result.ok
      ? { status: 'ok', data: result.data, risk: action.risk }
      : { status: 'error', reason: `upstream_${result.status}` };
  } catch (e) {
    await audit(deps, input, connector.connectorId, 'error', action.risk, { reason: (e as Error).message });
    return { status: 'error', reason: (e as Error).message };
  }
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
