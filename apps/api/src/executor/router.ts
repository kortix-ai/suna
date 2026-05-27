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
import { Hono, type Context } from 'hono';
import { handleCall, type GatewayDeps } from './gateway';
import { parseSharingIntent, type SharingIntent } from './share';

// Re-exported for callers that historically imported it from here.
export { parseSharingIntent };

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

export function createExecutorRouter(deps: ExecutorRouterDeps): Hono {
  const app = new Hono();

  // ── Gateway: list usable connectors ──────────────────────────────────────
  app.get('/connectors', async (c) => {
    const p = await deps.resolvePrincipal(c);
    if (!p) return c.json({ error: 'unauthorized' }, 401);
    const connectors = await deps.listCatalog(p);
    return c.json({ connectors });
  });

  // ── Gateway: run a tool call ─────────────────────────────────────────────
  app.post('/call', async (c) => {
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
  });

  // ── Admin: list connectors for the dashboard ─────────────────────────────
  app.get('/projects/:projectId/connectors', async (c) => {
    const projectId = c.req.param('projectId');
    const admin = await deps.resolveAdmin(c, projectId);
    if (!admin) return c.json({ error: 'forbidden' }, 403);
    return c.json({ connectors: await deps.listConnectors(projectId, admin.userId) });
  });

  // ── Admin: add/update a connector (writes kortix.toml) ───────────────────
  app.post('/projects/:projectId/connectors', async (c) => {
    const projectId = c.req.param('projectId');
    const admin = await deps.resolveAdmin(c, projectId);
    if (!admin) return c.json({ error: 'forbidden' }, 403);
    if (!deps.createConnector) return c.json({ error: 'not supported' }, 501);
    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
    const result = await deps.createConnector(projectId, admin.accountId, body);
    return result.ok ? c.json({ ok: true, sync: result.sync }) : c.json({ error: result.error }, result.status as 400);
  });

  // ── Admin: delete a connector ────────────────────────────────────────────
  app.delete('/projects/:projectId/connectors/:slug', async (c) => {
    const projectId = c.req.param('projectId');
    const slug = c.req.param('slug');
    const admin = await deps.resolveAdmin(c, projectId);
    if (!admin) return c.json({ error: 'forbidden' }, 403);
    if (!deps.deleteConnector) return c.json({ error: 'not supported' }, 501);
    const result = await deps.deleteConnector(projectId, slug);
    return result.ok ? c.json({ ok: true }) : c.json({ error: result.error }, result.status as 400);
  });

  // ── Admin: set a connector's credential value ────────────────────────────
  app.put('/projects/:projectId/connectors/:slug/credential', async (c) => {
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
  });

  // ── Admin: browse the Pipedream app catalogue ────────────────────────────
  app.get('/projects/:projectId/pipedream/apps', async (c) => {
    const projectId = c.req.param('projectId');
    const admin = await deps.resolveAdmin(c, projectId);
    if (!admin) return c.json({ error: 'forbidden' }, 403);
    if (!deps.listPipedreamApps) return c.json({ error: 'pipedream not configured' }, 501);
    const result = await deps.listPipedreamApps(c.req.query('q') || undefined, c.req.query('cursor') || undefined);
    return c.json(result);
  });

  // ── Admin: re-materialize from kortix.toml ───────────────────────────────
  app.post('/projects/:projectId/connectors/sync', async (c) => {
    const projectId = c.req.param('projectId');
    const admin = await deps.resolveAdmin(c, projectId);
    if (!admin) return c.json({ error: 'forbidden' }, 403);
    const result = await deps.syncConnectors(projectId, admin.accountId);
    return c.json(result);
  });

  // ── Admin: set sharing for a connector's credential ──────────────────────
  app.put('/projects/:projectId/connectors/:slug/sharing', async (c) => {
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
  });

  // ── Pipedream 1-click connect (admin) ────────────────────────────────────
  app.post('/projects/:projectId/connectors/:slug/connect', async (c) => {
    const projectId = c.req.param('projectId');
    const slug = c.req.param('slug');
    const admin = await deps.resolveAdmin(c, projectId);
    if (!admin) return c.json({ error: 'forbidden' }, 403);
    if (!deps.pipedreamConnect) return c.json({ error: 'pipedream not configured' }, 501);
    const result = await deps.pipedreamConnect(projectId, slug, admin.userId);
    if (!result) return c.json({ error: 'not a pipedream connector' }, 404);
    return c.json(result);
  });

  app.post('/projects/:projectId/connectors/:slug/connect/finalize', async (c) => {
    const projectId = c.req.param('projectId');
    const slug = c.req.param('slug');
    const admin = await deps.resolveAdmin(c, projectId);
    if (!admin) return c.json({ error: 'forbidden' }, 403);
    if (!deps.pipedreamFinalize) return c.json({ error: 'pipedream not configured' }, 501);
    const result = await deps.pipedreamFinalize(projectId, slug, admin.userId);
    if (!result) return c.json({ error: 'not a pipedream connector' }, 404);
    return c.json(result);
  });

  // ── Admin: read project policies (top-level [[policies]] + [policy]) ────
  app.get('/projects/:projectId/policies', async (c) => {
    const projectId = c.req.param('projectId');
    const admin = await deps.resolveAdmin(c, projectId);
    if (!admin) return c.json({ error: 'forbidden' }, 403);
    if (!deps.getProjectPolicies) return c.json({ error: 'not supported' }, 501);
    const result = await deps.getProjectPolicies(projectId);
    if (!result) return c.json({ error: 'project not found' }, 404);
    return c.json(result);
  });

  // ── Admin: replace project policies (write-through to kortix.toml) ──────
  app.put('/projects/:projectId/policies', async (c) => {
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
  });

  // ── Pipedream webhook (no user auth — HMAC-signed) ────────────────────────
  app.post('/webhook/pipedream', async (c) => {
    if (!deps.pipedreamWebhook) return c.json({ error: 'pipedream not configured' }, 501);
    const sig = c.req.query('sig') ?? null;
    let body: any;
    try { body = await c.req.json(); } catch { body = {}; }
    const extUserId = typeof body?.external_user_id === 'string' ? body.external_user_id : '';
    if (!extUserId) return c.json({ error: 'missing external_user_id' }, 400);
    const ok = await deps.pipedreamWebhook(extUserId, sig);
    return ok ? c.json({ ok: true }) : c.json({ error: 'invalid signature' }, 401);
  });

  return app;
}
