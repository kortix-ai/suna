/**
 * Executor HTTP surface — one Hono router with two faces:
 *
 *   Gateway (sandbox-facing, KORTIX_EXECUTOR_TOKEN):
 *     GET  /v1/executor/connectors          — catalog the session can use
 *     POST /v1/executor/call                — { connector, action, args } → run
 *
 *   Admin (dashboard-facing, user auth + project access):
 *     GET  /v1/executor/projects/:projectId/connectors          — list + status
 *     POST /v1/executor/projects/:projectId/connectors/sync     — re-materialize from kortix.toml
 *     PUT  /v1/executor/projects/:projectId/connectors/:slug/sharing — set who-can-use
 *
 * Built against an injected `ExecutorRouterDeps` so the e2e drives the real HTTP
 * layer + real gateway logic with in-memory fakes (db + upstream) at the
 * boundary; production wires DB-backed deps (db-deps.ts). See docs/specs/executor.md.
 */
import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import { type Context } from 'hono';
import { handleCall, type GatewayDeps } from './gateway';
import { parseSharingIntent, type SharingIntent } from './share';
import { makeOpenApiApp, json, errors, auth } from '../openapi';

// Re-exported for callers that historically imported it from here.
export { parseSharingIntent };

// ── Response schemas ─────────────────────────────────────────────────────────
// Connector catalog/admin shapes are permissive (opaque tool metadata); the
// /call result `data` and the pipedream/policy payloads are modeled loosely
// because they pass through opaque upstream content.

// Connector catalog/admin entries carry opaque tool metadata (inputSchema, risk,
// sharing) — documented by example but modeled with `z.any()` so the strict
// zod-openapi handler-return check accepts the real interface-typed payloads
// without rejecting any currently-valid shape.
const CatalogActionSchema = z
  .object({
    path: z.string(),
    name: z.string(),
    description: z.string(),
    risk: z.string(),
    inputSchema: z.any().nullable(),
  })
  .openapi('ExecutorCatalogAction');
const CatalogConnectorSchema = z
  .object({
    slug: z.string(),
    name: z.string(),
    provider: z.string(),
    status: z.string(),
    actions: z.array(CatalogActionSchema),
  })
  .openapi('ExecutorCatalogConnector');
const ConnectorsResponseSchema = z
  .object({ connectors: z.array(CatalogConnectorSchema) })
  .openapi('ExecutorConnectors');

const AdminConnectorsResponseSchema = z
  .object({ connectors: z.array(CatalogConnectorSchema) })
  .openapi('ExecutorAdminConnectors');

// /call returns one of several envelopes by status; model permissively.
const CallResponseSchema = z
  .object({
    ok: z.boolean(),
    data: z.any().optional(),
    risk: z.any().optional(),
    status: z.string().optional(),
    reason: z.any().optional(),
  })
  .passthrough()
  .openapi('ExecutorCallResult');

const OkSchema = z.object({ ok: z.boolean() }).passthrough();
const SyncResultSchema = z
  .object({
    synced: z.number(),
    errors: z.array(z.object({ slug: z.string(), error: z.string() })),
  })
  .passthrough()
  .openapi('ExecutorSyncResult');
const CrudOkSchema = z.object({ ok: z.boolean(), sync: z.any().optional() }).passthrough();
const OpaqueSchema = z.record(z.string(), z.any());

export interface ExecutorPrincipal {
  userId: string;
  accountId: string;
  projectId: string;
  sessionId: string | null;
  /** The acting identity resolved to its group memberships (for sharing checks). */
  subject: { userId: string; groupIds: string[] };
}

export interface CatalogAction {
  path: string; // connector-relative
  name: string;
  description: string;
  risk: string;
  inputSchema: Record<string, unknown> | null;
}
export interface CatalogConnector {
  slug: string;
  name: string;
  provider: string;
  status: string;
  actions: CatalogAction[];
}

export interface AdminConnectorView extends CatalogConnector {
  authSecret: string | null;
  /** Credential storage mode — shared project credential vs each member's own. */
  credentialMode: 'shared' | 'per_user';
  /** Current access (who can use), for the dashboard picker. */
  sharing: SharingIntent | null;
  /** Whether the viewing user's credential is set (shared row, or their own for per_user). */
  secretSet: boolean;
}

export interface SyncResult {
  synced: number;
  errors: Array<{ slug: string; error: string }>;
}

export type CrudOutcome =
  | { ok: true; sync?: SyncResult }
  | { ok: false; error: string; status: number };

export type PolicyAction = 'always_run' | 'require_approval' | 'block';
export type DefaultMode = 'risk' | 'allow_all';

export interface ProjectPolicyView {
  match: string;
  action: PolicyAction;
}

export interface ProjectPoliciesViewResponse {
  policies: ProjectPolicyView[];
  defaultMode: DefaultMode;
  errors: Array<{ path: string; error: string }>;
}

export interface ExecutorRouterDeps {
  /** Gateway auth: resolve the executor token → principal, or null for 401. */
  resolvePrincipal(c: Context): Promise<ExecutorPrincipal | null>;
  /** Build the DB-backed (or fake) gateway deps for a principal. */
  makeGatewayDeps(p: ExecutorPrincipal): GatewayDeps;
  /** The catalog the principal can actually use (sharing-filtered, blocked hidden). */
  listCatalog(p: ExecutorPrincipal): Promise<CatalogConnector[]>;
  /** Admin auth: resolve user + verify project access, or null for 401/403. */
  resolveAdmin(c: Context, projectId: string): Promise<{ accountId: string; userId: string } | null>;
  listConnectors(projectId: string, viewerUserId: string): Promise<AdminConnectorView[]>;
  syncConnectors(projectId: string, accountId: string): Promise<SyncResult>;
  /** Set sharing for a connector's bound secret. Returns false if the connector/secret is unknown. */
  setSharing(projectId: string, slug: string, intent: SharingIntent): Promise<boolean>;
  /** Create/update a connector in kortix.toml + materialize. */
  createConnector?(projectId: string, accountId: string, draft: Record<string, unknown>): Promise<CrudOutcome>;
  /** Remove a connector from kortix.toml + drop its rows. */
  deleteConnector?(projectId: string, slug: string): Promise<CrudOutcome>;
  /** Set a connector's credential value (stored scope='connector', never injected). */
  setConnectorCredential?(projectId: string, slug: string, value: string): Promise<CrudOutcome>;
  /** Pipedream 1-click: mint a connect token (for the frontend SDK overlay) + link. null = not pipedream. */
  pipedreamConnect?(projectId: string, slug: string, userId: string): Promise<{ token?: string; app?: string; connectUrl?: string } | null>;
  /** Pipedream 1-click: after the user finishes, persist the account binding (their own for per_user). */
  pipedreamFinalize?(projectId: string, slug: string, userId: string): Promise<{ connected: boolean; accountId?: string } | null>;
  /** Pipedream webhook: verify sig + finalize. Returns false on bad signature. */
  pipedreamWebhook?(externalUserId: string, sig: string | null): Promise<boolean>;
  /** Browse the Pipedream app catalogue (search + paginate). */
  listPipedreamApps?(query: string | undefined, cursor: string | undefined): Promise<{
    apps: Array<{ slug: string; name: string; description: string | null; imgSrc: string | null; categories: string[] }>;
    nextCursor?: string;
    hasMore: boolean;
  }>;
  /** Read project-level [[policies]] + [policy].default_mode from kortix.toml. */
  getProjectPolicies?(projectId: string): Promise<ProjectPoliciesViewResponse | null>;
  /** Replace project policies + default_mode (CRUD round-trips to kortix.toml). */
  setProjectPolicies?(
    projectId: string,
    accountId: string,
    policies: ProjectPolicyView[],
    defaultMode: DefaultMode,
  ): Promise<CrudOutcome>;
}

// Path-param schema shared by all admin routes.
const ProjectParam = z.object({ projectId: z.string() });
const ProjectSlugParam = z.object({ projectId: z.string(), slug: z.string() });

export function createExecutorRouter(deps: ExecutorRouterDeps): OpenAPIHono {
  const app = makeOpenApiApp();

  // ── Gateway: list usable connectors ──────────────────────────────────────
  app.openapi(
    createRoute({
      method: 'get',
      path: '/connectors',
      tags: ['executor'],
      summary: 'List the connectors the executor principal can use',
      ...auth,
      responses: {
        200: json(ConnectorsResponseSchema, 'Sharing-filtered connector catalog'),
        ...errors(401),
      },
    }),
    async (c: any) => {
      const p = await deps.resolvePrincipal(c);
      if (!p) return c.json({ error: 'unauthorized' }, 401);
      const connectors = await deps.listCatalog(p);
      return c.json({ connectors });
    },
  );

  // ── Gateway: run a tool call ─────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: 'post',
      path: '/call',
      tags: ['executor'],
      summary: 'Run a connector action (generic connector gateway)',
      ...auth,
      request: {
        body: {
          content: {
            'application/json': {
              // Fields optional at the schema layer: the handler does auth FIRST
              // (401) then its own field validation (custom invalid_json / "connector
              // and action are required" 400 envelopes). A required schema here would
              // 400 before the auth check — see the handler note below.
              schema: z.object({
                connector: z.string().optional(),
                action: z.string().optional(),
                args: z.record(z.string(), z.any()).optional(),
              }),
            },
          },
        },
      },
      responses: {
        200: json(CallResponseSchema, 'Tool result (ok)'),
        202: json(CallResponseSchema, 'Pending approval'),
        400: json(CallResponseSchema, 'Bad request (invalid_json / missing fields)'),
        401: json(CallResponseSchema, 'Unauthorized'),
        403: json(CallResponseSchema, 'Denied'),
        404: json(CallResponseSchema, 'Connector or action not found'),
        502: json(CallResponseSchema, 'Execution error'),
      },
    }),
    // Manual parse kept: original tolerates a missing/partial body (defaulting
    // args to {} and trimming strings) and returns custom `invalid_json` /
    // field-required 400 envelopes — typed validation would reject inputs the
    // existing contract accepts.
    async (c: any) => {
      const p = await deps.resolvePrincipal(c);
      if (!p) return c.json({ error: 'unauthorized' }, 401);

      let body: any;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'invalid_json' }, 400);
      }
      const connectorSlug = typeof body?.connector === 'string' ? body.connector.trim() : '';
      const actionPath = typeof body?.action === 'string' ? body.action.trim() : '';
      if (!connectorSlug || !actionPath) {
        return c.json({ error: 'connector and action are required' }, 400);
      }
      const args = body?.args && typeof body.args === 'object' ? (body.args as Record<string, unknown>) : {};

      const result = await handleCall(deps.makeGatewayDeps(p), {
        projectId: p.projectId,
        accountId: p.accountId,
        subject: p.subject,
        sessionId: p.sessionId,
        connectorSlug,
        actionPath,
        args,
      });

      switch (result.status) {
        case 'ok':
          return c.json({ ok: true, data: result.data, risk: result.risk });
        case 'pending_approval':
          return c.json({ ok: false, status: 'pending_approval', reason: result.reason }, 202);
        case 'denied':
          return c.json(
            { ok: false, status: 'denied', reason: result.reason },
            result.reason === 'connector_not_found' || result.reason === 'action_not_found' ? 404 : 403,
          );
        default:
          return c.json({ ok: false, status: 'error', reason: result.reason }, 502);
      }
    },
  );

  // ── Admin: list connectors for the dashboard ─────────────────────────────
  app.openapi(
    createRoute({
      method: 'get',
      path: '/projects/{projectId}/connectors',
      tags: ['executor'],
      summary: 'List a project\'s connectors with status (dashboard)',
      ...auth,
      request: { params: ProjectParam },
      responses: {
        200: json(AdminConnectorsResponseSchema, 'Connectors with admin status'),
        ...errors(403),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const admin = await deps.resolveAdmin(c, projectId);
      if (!admin) return c.json({ error: 'forbidden' }, 403);
      return c.json({ connectors: await deps.listConnectors(projectId, admin.userId) });
    },
  );

  // ── Admin: add/update a connector (writes kortix.toml) ───────────────────
  app.openapi(
    createRoute({
      method: 'post',
      path: '/projects/{projectId}/connectors',
      tags: ['executor'],
      summary: 'Create or update a connector in kortix.toml',
      ...auth,
      request: {
        params: ProjectParam,
        body: { content: { 'application/json': { schema: OpaqueSchema } } },
      },
      responses: {
        200: json(CrudOkSchema, 'Created/updated'),
        ...errors(400, 403, 501),
      },
    }),
    // Manual parse kept: the connector draft is an opaque record validated
    // downstream; original returns `invalid_json` / `not supported` envelopes.
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const admin = await deps.resolveAdmin(c, projectId);
      if (!admin) return c.json({ error: 'forbidden' }, 403);
      if (!deps.createConnector) return c.json({ error: 'not supported' }, 501);
      let body: any;
      try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
      if (body?.sharing !== undefined) {
        const intent = parseSharingIntent(body.sharing, admin.userId);
        if (!intent) return c.json({ error: 'invalid sharing — mode must be project|private|members' }, 400);
        body.sharing = intent;
      }
      const result = await deps.createConnector(projectId, admin.accountId, body);
      return result.ok ? c.json({ ok: true, sync: result.sync }) : c.json({ error: result.error }, result.status as 400);
    },
  );

  // ── Admin: delete a connector ────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/projects/{projectId}/connectors/{slug}',
      tags: ['executor'],
      summary: 'Delete a connector from kortix.toml',
      ...auth,
      request: { params: ProjectSlugParam },
      responses: {
        200: json(OkSchema, 'Deleted'),
        ...errors(400, 403, 501),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const slug = c.req.param('slug');
      const admin = await deps.resolveAdmin(c, projectId);
      if (!admin) return c.json({ error: 'forbidden' }, 403);
      if (!deps.deleteConnector) return c.json({ error: 'not supported' }, 501);
      const result = await deps.deleteConnector(projectId, slug);
      return result.ok ? c.json({ ok: true }) : c.json({ error: result.error }, result.status as 400);
    },
  );

  // ── Admin: set a connector's credential value ────────────────────────────
  app.openapi(
    createRoute({
      method: 'put',
      path: '/projects/{projectId}/connectors/{slug}/credential',
      tags: ['executor'],
      summary: 'Set a connector\'s credential value',
      ...auth,
      request: {
        params: ProjectSlugParam,
        body: { content: { 'application/json': { schema: z.object({ value: z.string() }) } } },
      },
      responses: {
        200: json(OkSchema, 'Credential set'),
        ...errors(400, 403, 501),
      },
    }),
    // Manual parse kept: original returns `invalid_json` and a `value is
    // required` 400 (empty string rejected) before delegating.
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const slug = c.req.param('slug');
      const admin = await deps.resolveAdmin(c, projectId);
      if (!admin) return c.json({ error: 'forbidden' }, 403);
      if (!deps.setConnectorCredential) return c.json({ error: 'not supported' }, 501);
      let body: any;
      try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
      const value = typeof body?.value === 'string' ? body.value : '';
      if (!value) return c.json({ error: 'value is required' }, 400);
      const result = await deps.setConnectorCredential(projectId, slug, value);
      return result.ok ? c.json({ ok: true }) : c.json({ error: result.error }, result.status as 400);
    },
  );

  // ── Admin: browse the Pipedream app catalogue ────────────────────────────
  app.openapi(
    createRoute({
      method: 'get',
      path: '/projects/{projectId}/pipedream/apps',
      tags: ['executor'],
      summary: 'Browse the Pipedream app catalogue',
      ...auth,
      request: {
        params: ProjectParam,
        query: z.object({ q: z.string().optional(), cursor: z.string().optional() }),
      },
      responses: {
        200: json(OpaqueSchema, 'Pipedream apps page'),
        ...errors(403, 501),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const admin = await deps.resolveAdmin(c, projectId);
      if (!admin) return c.json({ error: 'forbidden' }, 403);
      if (!deps.listPipedreamApps) return c.json({ error: 'pipedream not configured' }, 501);
      const result = await deps.listPipedreamApps(c.req.query('q') || undefined, c.req.query('cursor') || undefined);
      return c.json(result);
    },
  );

  // ── Admin: re-materialize from kortix.toml ───────────────────────────────
  app.openapi(
    createRoute({
      method: 'post',
      path: '/projects/{projectId}/connectors/sync',
      tags: ['executor'],
      summary: 'Re-materialize connectors from kortix.toml',
      ...auth,
      request: { params: ProjectParam },
      responses: {
        200: json(SyncResultSchema, 'Sync result'),
        ...errors(403),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const admin = await deps.resolveAdmin(c, projectId);
      if (!admin) return c.json({ error: 'forbidden' }, 403);
      const result = await deps.syncConnectors(projectId, admin.accountId);
      return c.json(result);
    },
  );

  // ── Admin: set sharing for a connector's credential ──────────────────────
  app.openapi(
    createRoute({
      method: 'put',
      path: '/projects/{projectId}/connectors/{slug}/sharing',
      tags: ['executor'],
      summary: 'Set who can use a connector\'s bound credential',
      ...auth,
      request: {
        params: ProjectSlugParam,
        body: { content: { 'application/json': { schema: OpaqueSchema } } },
      },
      responses: {
        200: json(OkSchema, 'Sharing updated'),
        ...errors(400, 403, 404),
      },
    }),
    // Manual parse kept: original validates the sharing intent via
    // parseSharingIntent (custom message) and returns `invalid_json`.
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const slug = c.req.param('slug');
      const admin = await deps.resolveAdmin(c, projectId);
      if (!admin) return c.json({ error: 'forbidden' }, 403);

      let body: any;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'invalid_json' }, 400);
      }
      const intent = parseSharingIntent(body, admin.userId);
      if (!intent) return c.json({ error: 'invalid sharing — mode must be project|private|members' }, 400);

      const ok = await deps.setSharing(projectId, slug, intent);
      if (!ok) return c.json({ error: 'connector or its credential not found' }, 404);
      return c.json({ ok: true });
    },
  );

  // ── Pipedream 1-click connect (admin) ────────────────────────────────────
  app.openapi(
    createRoute({
      method: 'post',
      path: '/projects/{projectId}/connectors/{slug}/connect',
      tags: ['executor'],
      summary: 'Pipedream 1-click: mint a connect token',
      ...auth,
      request: { params: ProjectSlugParam },
      responses: {
        200: json(OpaqueSchema, 'Connect token / overlay info'),
        ...errors(403, 404, 501),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const slug = c.req.param('slug');
      const admin = await deps.resolveAdmin(c, projectId);
      if (!admin) return c.json({ error: 'forbidden' }, 403);
      if (!deps.pipedreamConnect) return c.json({ error: 'pipedream not configured' }, 501);
      const result = await deps.pipedreamConnect(projectId, slug, admin.userId);
      if (!result) return c.json({ error: 'not a pipedream connector' }, 404);
      return c.json(result);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/projects/{projectId}/connectors/{slug}/connect/finalize',
      tags: ['executor'],
      summary: 'Pipedream 1-click: persist the account binding',
      ...auth,
      request: { params: ProjectSlugParam },
      responses: {
        200: json(OpaqueSchema, 'Connection finalized'),
        ...errors(403, 404, 501),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const slug = c.req.param('slug');
      const admin = await deps.resolveAdmin(c, projectId);
      if (!admin) return c.json({ error: 'forbidden' }, 403);
      if (!deps.pipedreamFinalize) return c.json({ error: 'pipedream not configured' }, 501);
      const result = await deps.pipedreamFinalize(projectId, slug, admin.userId);
      if (!result) return c.json({ error: 'not a pipedream connector' }, 404);
      return c.json(result);
    },
  );

  // ── Admin: read project policies (top-level [[policies]] + [policy]) ────
  app.openapi(
    createRoute({
      method: 'get',
      path: '/projects/{projectId}/policies',
      tags: ['executor'],
      summary: 'Read project policies and default mode',
      ...auth,
      request: { params: ProjectParam },
      responses: {
        200: json(OpaqueSchema, 'Project policies view'),
        ...errors(403, 404, 501),
      },
    }),
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const admin = await deps.resolveAdmin(c, projectId);
      if (!admin) return c.json({ error: 'forbidden' }, 403);
      if (!deps.getProjectPolicies) return c.json({ error: 'not supported' }, 501);
      const result = await deps.getProjectPolicies(projectId);
      if (!result) return c.json({ error: 'project not found' }, 404);
      return c.json(result);
    },
  );

  // ── Admin: replace project policies (write-through to kortix.toml) ──────
  app.openapi(
    createRoute({
      method: 'put',
      path: '/projects/{projectId}/policies',
      tags: ['executor'],
      summary: 'Replace project policies and default mode',
      ...auth,
      request: {
        params: ProjectParam,
        body: { content: { 'application/json': { schema: OpaqueSchema } } },
      },
      responses: {
        200: json(CrudOkSchema, 'Policies replaced'),
        ...errors(400, 403, 501),
      },
    }),
    // Manual parse kept: original does per-policy validation with indexed error
    // messages (`policy #N: ...`) and tolerates a partial/missing body.
    async (c: any) => {
      const projectId = c.req.param('projectId');
      const admin = await deps.resolveAdmin(c, projectId);
      if (!admin) return c.json({ error: 'forbidden' }, 403);
      if (!deps.setProjectPolicies) return c.json({ error: 'not supported' }, 501);

      let body: any;
      try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }

      const rawPolicies = Array.isArray(body?.policies) ? body.policies : [];
      const policies: ProjectPolicyView[] = [];
      for (let i = 0; i < rawPolicies.length; i++) {
        const p = rawPolicies[i];
        const match = typeof p?.match === 'string' ? p.match.trim() : '';
        const action = typeof p?.action === 'string' ? p.action.trim() : '';
        if (!match) return c.json({ error: `policy #${i + 1}: \`match\` is required` }, 400);
        if (action !== 'always_run' && action !== 'require_approval' && action !== 'block') {
          return c.json({ error: `policy #${i + 1}: invalid \`action\` "${action}"` }, 400);
        }
        policies.push({ match, action });
      }
      const defaultMode = body?.defaultMode === 'risk' ? 'risk' : 'allow_all';

      const result = await deps.setProjectPolicies(projectId, admin.accountId, policies, defaultMode);
      return result.ok
        ? c.json({ ok: true, sync: result.sync })
        : c.json({ error: result.error }, result.status as 400);
    },
  );

  // ── Pipedream webhook (no user auth — HMAC-signed) ────────────────────────
  app.openapi(
    createRoute({
      method: 'post',
      path: '/webhook/pipedream',
      tags: ['executor'],
      summary: 'Pipedream webhook (HMAC-signed, no user auth)',
      request: {
        query: z.object({ sig: z.string().optional() }),
        body: { content: { 'application/json': { schema: OpaqueSchema } } },
      },
      responses: {
        200: json(OkSchema, 'Accepted'),
        ...errors(400, 401, 501),
      },
    }),
    // Manual parse kept: webhook tolerates an unparseable body (defaults to {})
    // and authenticates via HMAC signature, not a user token.
    async (c: any) => {
      if (!deps.pipedreamWebhook) return c.json({ error: 'pipedream not configured' }, 501);
      const sig = c.req.query('sig') ?? null;
      let body: any;
      try { body = await c.req.json(); } catch { body = {}; }
      const extUserId = typeof body?.external_user_id === 'string' ? body.external_user_id : '';
      if (!extUserId) return c.json({ error: 'missing external_user_id' }, 400);
      const ok = await deps.pipedreamWebhook(extUserId, sig);
      return ok ? c.json({ ok: true }) : c.json({ error: 'invalid signature' }, 401);
    },
  );

  return app;
}
