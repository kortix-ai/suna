import { Data, Effect, Either } from 'effect';
import type { Context } from 'hono';
import { agentMayUseConnector } from '../iam/agent-scope';
import { handleCall } from './gateway';
import { parseSharingIntent } from './share';
import type {
  DefaultMode,
  ExecutorPrincipal,
  ExecutorRouterDeps,
  ProjectPolicyView,
} from './router';

type JsonBody = Record<string, unknown>;
type HttpStatus = 200 | 202 | 400 | 401 | 403 | 404 | 500 | 501 | number;
type CrudOutcome =
  | { ok: true; sync?: unknown }
  | { ok: false; error: string; status: number };

export interface ExecutorHttpResponse<A extends JsonBody = JsonBody> {
  readonly body: A;
  readonly status: HttpStatus;
}

export class ExecutorHttpError extends Data.TaggedError('ExecutorHttpError')<{
  readonly status: HttpStatus;
  readonly body: JsonBody;
}> {}

export class ExecutorDependencyError extends Data.TaggedError('ExecutorDependencyError')<{
  readonly cause: unknown;
}> {}

type ExecutorWorkflow<A extends JsonBody = JsonBody> = Effect.Effect<
  ExecutorHttpResponse<A>,
  ExecutorHttpError | ExecutorDependencyError
>;

const response = <A extends JsonBody>(body: A, status: HttpStatus = 200): ExecutorHttpResponse<A> => ({
  body,
  status,
});

const failResponse = (body: JsonBody, status: HttpStatus) =>
  Effect.fail(new ExecutorHttpError({ body, status }));

const dependency = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    try: operation,
    catch: (cause) => new ExecutorDependencyError({ cause }),
  });

const parseJson = (c: Context, onInvalid: JsonBody = { error: 'invalid_json' }) =>
  Effect.tryPromise({
    try: () => c.req.json() as Promise<unknown>,
    catch: () => new ExecutorHttpError({ body: onInvalid, status: 400 }),
  });

const parseJsonOr = (c: Context, fallback: unknown) =>
  Effect.catchAll(parseJson(c), () => Effect.succeed(fallback));

const requirePrincipal = (deps: ExecutorRouterDeps, c: Context) =>
  dependency(() => deps.resolvePrincipal(c)).pipe(
    Effect.flatMap((principal) =>
      principal
        ? Effect.succeed(principal)
        : failResponse({ error: 'unauthorized' }, 401),
    ),
  );

const requireProjectPrincipal = (deps: ExecutorRouterDeps, c: Context, projectId: string) =>
  dependency(() => deps.resolveProjectPrincipal(c, projectId)).pipe(
    Effect.flatMap((principal) =>
      principal
        ? Effect.succeed(principal)
        : failResponse({ error: 'forbidden' }, 403),
    ),
  );

const requireAdmin = (deps: ExecutorRouterDeps, c: Context, projectId: string) =>
  dependency(() => deps.resolveAdmin(c, projectId)).pipe(
    Effect.flatMap((admin) =>
      admin
        ? Effect.succeed(admin)
        : failResponse({ error: 'forbidden' }, 403),
    ),
  );

const requireHandler = <A>(
  handler: A | undefined,
  message = 'not supported',
  status: HttpStatus = 501,
) =>
  handler
    ? Effect.succeed(handler)
    : failResponse({ error: message }, status);

const crudResponse = (result: CrudOutcome, successBody: JsonBody = { ok: true }) =>
  result.ok
    ? Effect.succeed(response(successBody))
    : Effect.succeed(response({ error: result.error }, result.status));

const crudSyncResponse = (result: CrudOutcome) =>
  result.ok
    ? Effect.succeed(response({ ok: true, sync: result.sync }))
    : Effect.succeed(response({ error: result.error }, result.status));

const callForPrincipal = (
  deps: ExecutorRouterDeps,
  c: Context,
  principal: ExecutorPrincipal,
): ExecutorWorkflow =>
  Effect.gen(function* () {
    const body = (yield* parseJson(c)) as any;
    const connectorSlug = typeof body?.connector === 'string' ? body.connector.trim() : '';
    const actionPath = typeof body?.action === 'string' ? body.action.trim() : '';
    if (!connectorSlug || !actionPath) {
      return yield* failResponse({ error: 'connector and action are required' }, 400);
    }

    if (!agentMayUseConnector(principal.agentGrant ?? null, connectorSlug)) {
      return response(
        { ok: false, status: 'denied', reason: 'connector_not_assigned' },
        403,
      );
    }

    const args = body?.args && typeof body.args === 'object'
      ? (body.args as Record<string, unknown>)
      : {};
    const result = yield* dependency(() =>
      handleCall(deps.makeGatewayDeps(principal), {
        projectId: principal.projectId,
        accountId: principal.accountId,
        subject: principal.subject,
        sessionId: principal.sessionId,
        connectorSlug,
        actionPath,
        args,
      }),
    );

    switch (result.status) {
      case 'ok':
        return response({ ok: true, data: result.data, risk: result.risk });
      case 'pending_approval':
        return response(
          { ok: false, status: 'pending_approval', reason: result.reason },
          202,
        );
      case 'denied':
        return response(
          { ok: false, status: 'denied', reason: result.reason },
          result.reason === 'connector_not_found' || result.reason === 'action_not_found' ? 404 : 403,
        );
      default:
        return response({ ok: false, status: 'error', reason: result.reason }, 500);
    }
  });

export async function runExecutorWorkflow<A extends JsonBody>(
  c: Context,
  workflow: ExecutorWorkflow<A>,
): Promise<any> {
  const result = await Effect.runPromise(Effect.either(workflow));
  if (Either.isRight(result)) {
    return c.json(result.right.body, result.right.status as never);
  }
  const error = result.left;
  if (error instanceof ExecutorHttpError) {
    return c.json(error.body, error.status as never);
  }
  if (error instanceof ExecutorDependencyError) {
    throw error.cause;
  }
  throw error;
}

export const gatewayCatalogWorkflow = (
  deps: ExecutorRouterDeps,
  c: Context,
): ExecutorWorkflow =>
  Effect.gen(function* () {
    const principal = yield* requirePrincipal(deps, c);
    const connectors = yield* dependency(() => deps.listCatalog(principal));
    return response({ connectors });
  });

export const gatewayCallWorkflow = (
  deps: ExecutorRouterDeps,
  c: Context,
): ExecutorWorkflow =>
  Effect.gen(function* () {
    const principal = yield* requirePrincipal(deps, c);
    return yield* callForPrincipal(deps, c, principal);
  });

export const projectCatalogWorkflow = (
  deps: ExecutorRouterDeps,
  c: Context,
  projectId: string,
): ExecutorWorkflow =>
  Effect.gen(function* () {
    const principal = yield* requireProjectPrincipal(deps, c, projectId);
    const connectors = yield* dependency(() => deps.listCatalog(principal));
    return response({ connectors });
  });

export const projectCallWorkflow = (
  deps: ExecutorRouterDeps,
  c: Context,
  projectId: string,
): ExecutorWorkflow =>
  Effect.gen(function* () {
    const principal = yield* requireProjectPrincipal(deps, c, projectId);
    return yield* callForPrincipal(deps, c, principal);
  });

export const adminListConnectorsWorkflow = (
  deps: ExecutorRouterDeps,
  c: Context,
  projectId: string,
): ExecutorWorkflow =>
  Effect.gen(function* () {
    const admin = yield* requireAdmin(deps, c, projectId);
    const connectors = yield* dependency(() => deps.listConnectors(projectId, admin.userId));
    return response({ connectors });
  });

export const createConnectorWorkflow = (
  deps: ExecutorRouterDeps,
  c: Context,
  projectId: string,
): ExecutorWorkflow =>
  Effect.gen(function* () {
    const admin = yield* requireAdmin(deps, c, projectId);
    const createConnector = yield* requireHandler(deps.createConnector);
    const body = (yield* parseJson(c)) as Record<string, unknown>;
    if (body?.sharing !== undefined) {
      const intent = parseSharingIntent(body.sharing, admin.userId);
      if (!intent) {
        return yield* failResponse(
          { error: 'invalid sharing — mode must be project|private|members' },
          400,
        );
      }
      body.sharing = intent;
    }
    const result = yield* dependency(() => createConnector(projectId, admin.accountId, body));
    return yield* crudSyncResponse(result);
  });

export const deleteConnectorWorkflow = (
  deps: ExecutorRouterDeps,
  c: Context,
  projectId: string,
  slug: string,
): ExecutorWorkflow =>
  Effect.gen(function* () {
    yield* requireAdmin(deps, c, projectId);
    const deleteConnector = yield* requireHandler(deps.deleteConnector);
    const result = yield* dependency(() => deleteConnector(projectId, slug));
    return yield* crudResponse(result);
  });

export const setConnectorCredentialWorkflow = (
  deps: ExecutorRouterDeps,
  c: Context,
  projectId: string,
  slug: string,
): ExecutorWorkflow =>
  Effect.gen(function* () {
    yield* requireAdmin(deps, c, projectId);
    const setConnectorCredential = yield* requireHandler(deps.setConnectorCredential);
    const body = (yield* parseJson(c)) as any;
    const value = typeof body?.value === 'string' ? body.value : '';
    if (!value) return yield* failResponse({ error: 'value is required' }, 400);
    const result = yield* dependency(() => setConnectorCredential(projectId, slug, value));
    return yield* crudResponse(result);
  });

export const deleteConnectorCredentialWorkflow = (
  deps: ExecutorRouterDeps,
  c: Context,
  projectId: string,
  slug: string,
): ExecutorWorkflow =>
  Effect.gen(function* () {
    const admin = yield* requireAdmin(deps, c, projectId);
    const deleteConnectorCredential = yield* requireHandler(deps.deleteConnectorCredential);
    const result = yield* dependency(() =>
      deleteConnectorCredential(projectId, slug, admin.userId),
    );
    return yield* crudResponse(result);
  });

export const pipedreamAppsWorkflow = (
  deps: ExecutorRouterDeps,
  c: Context,
  projectId: string,
): ExecutorWorkflow =>
  Effect.gen(function* () {
    yield* requireAdmin(deps, c, projectId);
    const listPipedreamApps = yield* requireHandler(
      deps.listPipedreamApps,
      'pipedream not configured',
    );
    const result = yield* dependency(() =>
      listPipedreamApps(c.req.query('q') || undefined, c.req.query('cursor') || undefined),
    );
    return response(result as unknown as JsonBody);
  });

export const connectStatusWorkflow = (deps: ExecutorRouterDeps): ExecutorWorkflow =>
  Effect.succeed(response({
    configured: !!deps.listPipedreamApps,
    provider: deps.listPipedreamApps ? 'pipedream' : null,
  }));

export const syncConnectorsWorkflow = (
  deps: ExecutorRouterDeps,
  c: Context,
  projectId: string,
): ExecutorWorkflow =>
  Effect.gen(function* () {
    const admin = yield* requireAdmin(deps, c, projectId);
    const result = yield* dependency(() => deps.syncConnectors(projectId, admin.accountId));
    return response(result as unknown as JsonBody);
  });

export const setSharingWorkflow = (
  deps: ExecutorRouterDeps,
  c: Context,
  projectId: string,
  slug: string,
): ExecutorWorkflow =>
  Effect.gen(function* () {
    const admin = yield* requireAdmin(deps, c, projectId);
    const body = yield* parseJson(c);
    const intent = parseSharingIntent(body, admin.userId);
    if (!intent) {
      return yield* failResponse(
        { error: 'invalid sharing — mode must be project|private|members' },
        400,
      );
    }
    const ok = yield* dependency(() => deps.setSharing(projectId, slug, intent));
    if (!ok) return response({ error: 'connector or its credential not found' }, 404);
    return response({ ok: true });
  });

export const setCredentialModeWorkflow = (
  deps: ExecutorRouterDeps,
  c: Context,
  projectId: string,
  slug: string,
): ExecutorWorkflow =>
  Effect.gen(function* () {
    const admin = yield* requireAdmin(deps, c, projectId);
    const setCredentialMode = yield* requireHandler(deps.setCredentialMode);
    const body = (yield* parseJson(c)) as any;
    const mode = body?.mode;
    if (mode !== 'shared' && mode !== 'per_user') {
      return yield* failResponse({ error: 'mode must be "shared" or "per_user"' }, 400);
    }
    const result = yield* dependency(() =>
      setCredentialMode(projectId, admin.accountId, slug, mode),
    );
    return yield* crudSyncResponse(result);
  });

export const setConnectorNameWorkflow = (
  deps: ExecutorRouterDeps,
  c: Context,
  projectId: string,
  slug: string,
): ExecutorWorkflow =>
  Effect.gen(function* () {
    const admin = yield* requireAdmin(deps, c, projectId);
    const setConnectorName = yield* requireHandler(deps.setConnectorName);
    const body = (yield* parseJson(c)) as any;
    const name = typeof body?.name === 'string' ? body.name : '';
    if (!name.trim()) return yield* failResponse({ error: '`name` is required' }, 400);
    const result = yield* dependency(() =>
      setConnectorName(projectId, admin.accountId, slug, name),
    );
    return yield* crudSyncResponse(result);
  });

export const getConnectorPoliciesWorkflow = (
  deps: ExecutorRouterDeps,
  c: Context,
  projectId: string,
  slug: string,
): ExecutorWorkflow =>
  Effect.gen(function* () {
    yield* requireAdmin(deps, c, projectId);
    const getConnectorPolicies = yield* requireHandler(deps.getConnectorPolicies);
    const result = yield* dependency(() => getConnectorPolicies(projectId, slug));
    if (!result) return response({ error: 'connector not found' }, 404);
    return response(result as unknown as JsonBody);
  });

export const getConnectorConfigWorkflow = (
  deps: ExecutorRouterDeps,
  c: Context,
  projectId: string,
  slug: string,
): ExecutorWorkflow =>
  Effect.gen(function* () {
    yield* requireAdmin(deps, c, projectId);
    const getConnectorConfig = yield* requireHandler(deps.getConnectorConfig);
    const result = yield* dependency(() => getConnectorConfig(projectId, slug));
    if (!result) return response({ error: 'connector not found' }, 404);
    return response(result as unknown as JsonBody);
  });

export const setConnectorPoliciesWorkflow = (
  deps: ExecutorRouterDeps,
  c: Context,
  projectId: string,
  slug: string,
): ExecutorWorkflow =>
  Effect.gen(function* () {
    const admin = yield* requireAdmin(deps, c, projectId);
    const setConnectorPolicies = yield* requireHandler(deps.setConnectorPolicies);
    const body = (yield* parseJson(c)) as any;
    const policies = Array.isArray(body?.policies) ? body.policies : null;
    if (!policies) return yield* failResponse({ error: '`policies` must be an array' }, 400);
    const result = yield* dependency(() =>
      setConnectorPolicies(projectId, admin.accountId, slug, policies),
    );
    return yield* crudSyncResponse(result);
  });

export const pipedreamConnectWorkflow = (
  deps: ExecutorRouterDeps,
  c: Context,
  projectId: string,
  slug: string,
): ExecutorWorkflow =>
  Effect.gen(function* () {
    const admin = yield* requireAdmin(deps, c, projectId);
    const pipedreamConnect = yield* requireHandler(
      deps.pipedreamConnect,
      'pipedream not configured',
    );
    const body = (yield* parseJsonOr(c, {})) as any;
    const redirects = body?.success_redirect_uri || body?.error_redirect_uri
      ? { success: body.success_redirect_uri, error: body.error_redirect_uri }
      : undefined;
    const result = yield* dependency(() =>
      pipedreamConnect(projectId, slug, admin.userId, redirects),
    );
    if (!result) return response({ error: 'not a pipedream connector' }, 404);
    return response(result as unknown as JsonBody);
  });

export const pipedreamFinalizeWorkflow = (
  deps: ExecutorRouterDeps,
  c: Context,
  projectId: string,
  slug: string,
): ExecutorWorkflow =>
  Effect.gen(function* () {
    const admin = yield* requireAdmin(deps, c, projectId);
    const pipedreamFinalize = yield* requireHandler(
      deps.pipedreamFinalize,
      'pipedream not configured',
    );
    const result = yield* dependency(() =>
      pipedreamFinalize(projectId, slug, admin.userId),
    );
    if (!result) return response({ error: 'not a pipedream connector' }, 404);
    return response(result as unknown as JsonBody);
  });

export const getProjectPoliciesWorkflow = (
  deps: ExecutorRouterDeps,
  c: Context,
  projectId: string,
): ExecutorWorkflow =>
  Effect.gen(function* () {
    yield* requireAdmin(deps, c, projectId);
    const getProjectPolicies = yield* requireHandler(deps.getProjectPolicies);
    const result = yield* dependency(() => getProjectPolicies(projectId));
    if (!result) return response({ error: 'project not found' }, 404);
    return response(result as unknown as JsonBody);
  });

export const setProjectPoliciesWorkflow = (
  deps: ExecutorRouterDeps,
  c: Context,
  projectId: string,
): ExecutorWorkflow =>
  Effect.gen(function* () {
    const admin = yield* requireAdmin(deps, c, projectId);
    const setProjectPolicies = yield* requireHandler(deps.setProjectPolicies);
    const body = (yield* parseJson(c)) as any;
    const rawPolicies = Array.isArray(body?.policies) ? body.policies : [];
    const policies: ProjectPolicyView[] = [];

    for (let i = 0; i < rawPolicies.length; i++) {
      const policy = rawPolicies[i];
      const match = typeof policy?.match === 'string' ? policy.match.trim() : '';
      const action = typeof policy?.action === 'string' ? policy.action.trim() : '';
      if (!match) {
        return yield* failResponse({ error: `policy #${i + 1}: \`match\` is required` }, 400);
      }
      if (action !== 'always_run' && action !== 'require_approval' && action !== 'block') {
        return yield* failResponse(
          { error: `policy #${i + 1}: invalid \`action\` "${action}"` },
          400,
        );
      }
      policies.push({ match, action });
    }

    const defaultMode: DefaultMode = body?.defaultMode === 'risk' ? 'risk' : 'allow_all';
    const result = yield* dependency(() =>
      setProjectPolicies(projectId, admin.accountId, policies, defaultMode),
    );
    return yield* crudSyncResponse(result);
  });

export const pipedreamWebhookWorkflow = (
  deps: ExecutorRouterDeps,
  c: Context,
): ExecutorWorkflow =>
  Effect.gen(function* () {
    const pipedreamWebhook = yield* requireHandler(
      deps.pipedreamWebhook,
      'pipedream not configured',
    );
    const sig = c.req.query('sig') ?? null;
    const body = (yield* parseJsonOr(c, {})) as any;
    const extUserId = typeof body?.external_user_id === 'string' ? body.external_user_id : '';
    if (!extUserId) return yield* failResponse({ error: 'missing external_user_id' }, 400);
    const ok = yield* dependency(() => pipedreamWebhook(extUserId, sig));
    return ok ? response({ ok: true }) : response({ error: 'invalid signature' }, 401);
  });
