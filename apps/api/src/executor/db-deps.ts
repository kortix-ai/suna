/**
 * Production wiring for the executor router — DB-backed ExecutorRouterDeps +
 * GatewayDeps. Access lives on the connector; credentials are split per (connector,
 * user). The pure logic (gateway/share/execute/policy/normalize) is tested; this
 * is the glue to Postgres + the credential store + Pipedream. See docs/specs/executor.md.
 */
import type { Context } from 'hono';
import { and, eq } from 'drizzle-orm';
import {
  executorConnectorActions,
  executorConnectorPolicies,
  executorConnectors,
  executorExecutions,
  executorProjectPolicies,
  executorProjectSettings,
  projects,
} from '@kortix/db';
import { db } from '../shared/db';
import { validateAccountToken } from '../repositories/account-tokens';
import { authorize } from '../iam';
import {
  isSecretUsableBy,
  resolveShareSubject,
  scopeToIntent,
  type SharingIntent,
} from './share';
import {
  credentialExists,
  loadConnectorGrants,
  loadGrantsForMany,
  resolveCredentialValue,
  setConnectorSharingDb,
} from './credentials';
import {
  resolveEffectiveAction,
  type DefaultMode,
  type Policy,
} from './policy';
import { syncProjectConnectors } from './sync';
import {
  finalizePipedreamConnection,
  pipedreamConfigured,
  pipedreamConnectUrl,
  runPipedreamAction,
  runPipedreamProxy,
  browsePipedreamApps,
  verifyWebhookSig,
} from './pipedream';
import {
  deleteConnectorFromManifest,
  getProjectPoliciesFromManifest,
  setConnectorCredentialShared,
  setConnectorCredentialModeInManifest,
  setConnectorNameInManifest,
  getConnectorPoliciesFromManifest,
  setConnectorPoliciesInManifest,
  setProjectPoliciesInManifest,
  upsertConnectorInManifest,
  type ConnectorDraft,
} from './manifest-crud';
import type { ActionBinding, Risk } from './types';
import type { ExecutorAuth, FetchImpl } from './execute';
import type { GatewayAction, GatewayConnector, GatewayDeps } from './gateway';
import type {
  AdminConnectorView,
  CatalogConnector,
  ExecutorPrincipal,
  ExecutorRouterDeps,
} from './router';

const DEFAULT_AUTH: ExecutorAuth = { type: 'none', in: 'header', name: null, prefix: null };

type ConnectorRow = typeof executorConnectors.$inferSelect;

function authOf(row: ConnectorRow): { auth: ExecutorAuth; hasAuth: boolean } {
  const cfg = (row.config ?? {}) as Record<string, any>;
  const auth: ExecutorAuth = cfg.auth
    ? { type: cfg.auth.type, in: cfg.auth.in ?? 'header', name: cfg.auth.name ?? null, prefix: cfg.auth.prefix ?? null }
    : DEFAULT_AUTH;
  const hasAuth = row.providerType === 'pipedream' || auth.type !== 'none';
  return { auth, hasAuth };
}

function baseUrlOf(row: ConnectorRow): string | null {
  const cfg = (row.config ?? {}) as Record<string, any>;
  switch (row.providerType) {
    case 'openapi': return cfg.server ?? null;
    case 'http': return cfg.baseUrl ?? null;
    case 'graphql': return cfg.endpoint ?? null;
    case 'mcp': return cfg.url ?? null;
    default: return null;
  }
}

function toGatewayConnector(row: ConnectorRow, grants: Awaited<ReturnType<typeof loadConnectorGrants>>): GatewayConnector {
  const { auth, hasAuth } = authOf(row);
  return {
    connectorId: row.connectorId,
    slug: row.slug,
    provider: row.providerType,
    baseUrl: baseUrlOf(row),
    auth,
    hasAuth,
    shareScope: row.shareScope as 'project' | 'restricted',
    grants,
    credentialMode: row.credentialMode as 'shared' | 'per_user',
    enabled: row.enabled,
  };
}

const nodeFetch: FetchImpl = async (url, init) => {
  const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body });
  return { status: res.status, ok: res.ok, text: () => res.text() };
};

export function makeDbGatewayDeps(): GatewayDeps {
  return {
    loadConnectorBySlug: async (projectId, slug) => {
      const [row] = await db
        .select()
        .from(executorConnectors)
        .where(and(eq(executorConnectors.projectId, projectId), eq(executorConnectors.slug, slug)))
        .limit(1);
      if (!row) return null;
      return toGatewayConnector(row, await loadConnectorGrants(row.connectorId));
    },
    loadAction: async (connectorId, relPath) => {
      const [a] = await db
        .select()
        .from(executorConnectorActions)
        .where(and(eq(executorConnectorActions.connectorId, connectorId), eq(executorConnectorActions.path, relPath)))
        .limit(1);
      if (!a) return null;
      return {
        path: a.path,
        relPath: a.path,
        inputSchema: a.inputSchema ?? null,
        risk: a.risk as Risk,
        binding: a.binding as unknown as ActionBinding,
      } satisfies GatewayAction;
    },
    resolveCredential: (connectorId, userId) => resolveCredentialValue(connectorId, userId),
    loadPolicies: loadConnectorPoliciesFor,
    loadProjectPolicies: loadProjectPoliciesFor,
    loadDefaultMode: loadDefaultModeFor,
    recordExecution: async (rec) => {
      await db.insert(executorExecutions).values({
        accountId: rec.accountId,
        projectId: rec.projectId,
        connectorId: rec.connectorId,
        actionPath: rec.actionPath,
        actingUserId: rec.actingUserId,
        sessionId: rec.sessionId,
        status: rec.status,
        risk: rec.risk,
        resultSummary: rec.resultSummary,
        resolvedAt: new Date(),
      });
    },
    executePipedream: ({ projectId, connectorSlug, app, actionKey, args, accountId, userId }) =>
      runPipedreamAction(projectId, connectorSlug, app, actionKey, args, accountId, userId),
    executePipedreamProxy: ({ projectId, connectorSlug, args, accountId, userId }) =>
      runPipedreamProxy(projectId, connectorSlug, args, accountId, userId),
    fetchImpl: nodeFetch,
    enforcePolicies: true,
  };
}

async function loadConnectorPoliciesFor(connectorId: string): Promise<Policy[]> {
  const rows = await db
    .select()
    .from(executorConnectorPolicies)
    .where(eq(executorConnectorPolicies.connectorId, connectorId));
  return rows.map((r) => ({ match: r.match, action: r.action, position: r.position }));
}

async function loadProjectPoliciesFor(projectId: string): Promise<Policy[]> {
  const rows = await db
    .select()
    .from(executorProjectPolicies)
    .where(eq(executorProjectPolicies.projectId, projectId));
  return rows.map((r) => ({ match: r.match, action: r.action, position: r.position }));
}

async function loadDefaultModeFor(projectId: string): Promise<DefaultMode> {
  const [row] = await db
    .select({ defaultMode: executorProjectSettings.defaultMode })
    .from(executorProjectSettings)
    .where(eq(executorProjectSettings.projectId, projectId))
    .limit(1);
  return (row?.defaultMode as DefaultMode) ?? 'allow_all';
}

/** Load a pipedream connector's app slug, id, mode (verifies provider). */
async function loadPipedreamConnector(projectId: string, slug: string) {
  const [row] = await db
    .select({ connectorId: executorConnectors.connectorId, providerType: executorConnectors.providerType, config: executorConnectors.config, credentialMode: executorConnectors.credentialMode })
    .from(executorConnectors)
    .where(and(eq(executorConnectors.projectId, projectId), eq(executorConnectors.slug, slug)))
    .limit(1);
  if (!row || row.providerType !== 'pipedream') return null;
  const app = (row.config as any)?.app;
  if (typeof app !== 'string' || !app) return null;
  return { connectorId: row.connectorId, app, mode: row.credentialMode as 'shared' | 'per_user' };
}

async function resolvePrincipal(c: Context): Promise<ExecutorPrincipal | null> {
  const header = c.req.header('Authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  const result = await validateAccountToken(token);
  if (!result.isValid || !result.userId || !result.accountId || !result.projectId) return null;
  return {
    userId: result.userId,
    accountId: result.accountId,
    projectId: result.projectId,
    sessionId: c.req.header('X-Kortix-Session-Id') ?? null,
    subject: await resolveShareSubject(result.userId),
  };
}

/** The catalog a principal can actually use (access + credential present + not blocked). */
async function listCatalog(p: ExecutorPrincipal): Promise<CatalogConnector[]> {
  const conns = await db
    .select()
    .from(executorConnectors)
    .where(and(eq(executorConnectors.projectId, p.projectId), eq(executorConnectors.enabled, true)));
  const grantsByConnector = await loadGrantsForMany(conns.map((c) => c.connectorId));

  // Project-scoped layer is the same for every connector in this list — load once.
  const [projectPolicies, defaultMode] = await Promise.all([
    loadProjectPoliciesFor(p.projectId),
    loadDefaultModeFor(p.projectId),
  ]);

  const out: CatalogConnector[] = [];
  for (const row of conns) {
    const grants = grantsByConnector.get(row.connectorId) ?? [];
    if (!isSecretUsableBy(row.shareScope as 'project' | 'restricted', grants, p.subject)) continue;
    const { hasAuth } = authOf(row);
    if (hasAuth) {
      const uid = row.credentialMode === 'per_user' ? p.userId : null;
      if (!(await credentialExists(row.connectorId, uid))) continue; // not connected for this user
    }
    const connectorPolicies = await loadConnectorPoliciesFor(row.connectorId);
    const actions = await db.select().from(executorConnectorActions).where(eq(executorConnectorActions.connectorId, row.connectorId));
    out.push({
      slug: row.slug,
      name: row.name,
      provider: row.providerType,
      status: row.status,
      actions: actions
        .filter((a) => resolveEffectiveAction({
          fullPath: `${row.slug}.${a.path}`,
          relPath: a.path,
          projectPolicies,
          connectorPolicies,
          risk: a.risk,
          defaultMode,
        }).action !== 'block')
        .map((a) => ({ path: a.path, name: a.name, description: a.description ?? '', risk: a.risk, inputSchema: a.inputSchema ?? null })),
    });
  }
  return out;
}

async function resolveAdmin(c: Context, projectId: string): Promise<{ accountId: string; userId: string } | null> {
  const userId = c.get('userId') as string | undefined;
  if (!userId) return null;
  const [proj] = await db.select({ accountId: projects.accountId }).from(projects).where(eq(projects.projectId, projectId)).limit(1);
  if (!proj) return null;
  const decision = await authorize(userId, proj.accountId, 'project.write', { type: 'project', id: projectId });
  if (!decision.allowed) return null;
  return { accountId: proj.accountId, userId };
}

/** Admin list — sharing + credential mode + whether the viewer's credential is set. */
async function listConnectors(projectId: string, viewerUserId: string): Promise<AdminConnectorView[]> {
  const conns = await db.select().from(executorConnectors).where(eq(executorConnectors.projectId, projectId));
  const grantsByConnector = await loadGrantsForMany(conns.map((c) => c.connectorId));
  const out: AdminConnectorView[] = [];
  for (const row of conns) {
    const grants = grantsByConnector.get(row.connectorId) ?? [];
    const { hasAuth } = authOf(row);
    const mode = row.credentialMode as 'shared' | 'per_user';
    let secretSet = !hasAuth;
    if (hasAuth) {
      secretSet = await credentialExists(row.connectorId, mode === 'per_user' ? viewerUserId : null);
    }
    const actions = await db.select().from(executorConnectorActions).where(eq(executorConnectorActions.connectorId, row.connectorId));
    out.push({
      slug: row.slug,
      name: row.name,
      provider: row.providerType,
      status: row.status,
      credentialMode: mode,
      actions: actions.map((a) => ({ path: a.path, name: a.name, description: a.description ?? '', risk: a.risk, inputSchema: a.inputSchema ?? null })),
      authSecret: hasAuth ? 'credential' : null,
      sharing: scopeToIntent(row.shareScope as 'project' | 'restricted', grants),
      secretSet,
    });
  }
  return out;
}

async function setSharing(projectId: string, slug: string, intent: SharingIntent): Promise<boolean> {
  const [row] = await db
    .select({ connectorId: executorConnectors.connectorId })
    .from(executorConnectors)
    .where(and(eq(executorConnectors.projectId, projectId), eq(executorConnectors.slug, slug)))
    .limit(1);
  if (!row) return false;
  await setConnectorSharingDb(row.connectorId, intent);
  return true;
}

export const dbExecutorRouterDeps: ExecutorRouterDeps = {
  resolvePrincipal,
  makeGatewayDeps: () => makeDbGatewayDeps(),
  listCatalog,
  resolveAdmin,
  listConnectors,
  // The manual "Sync" button re-pulls catalogs unconditionally (force) — the
  // user is explicitly asking to refresh, e.g. an MCP server gained new tools.
  syncConnectors: (projectId, accountId) => syncProjectConnectors(projectId, accountId, { force: true }),
  setSharing,
  createConnector: (projectId, accountId, draft) =>
    upsertConnectorInManifest(projectId, accountId, draft as unknown as ConnectorDraft, (draft as any)?.sharing as SharingIntent | undefined),
  deleteConnector: (projectId, slug) => deleteConnectorFromManifest(projectId, slug),
  setConnectorCredential: (projectId, slug, value) => setConnectorCredentialShared(projectId, slug, value),
  setCredentialMode: (projectId, accountId, slug, mode) => setConnectorCredentialModeInManifest(projectId, accountId, slug, mode),
  setConnectorName: (projectId, accountId, slug, name) => setConnectorNameInManifest(projectId, accountId, slug, name),
  getConnectorPolicies: (projectId, slug) => getConnectorPoliciesFromManifest(projectId, slug),
  setConnectorPolicies: (projectId, accountId, slug, policies) =>
    setConnectorPoliciesInManifest(projectId, accountId, slug, policies as Parameters<typeof setConnectorPoliciesInManifest>[3]),
  pipedreamConnect: pipedreamConfigured()
    ? async (projectId, slug, userId) => {
        const conn = await loadPipedreamConnector(projectId, slug);
        if (!conn) return null;
        const effectiveUser = conn.mode === 'per_user' ? userId : null;
        const { connectUrl, token } = await pipedreamConnectUrl(projectId, slug, conn.app, effectiveUser);
        return { token, app: conn.app, connectUrl };
      }
    : undefined,
  pipedreamFinalize: pipedreamConfigured()
    ? async (projectId, slug, userId) => {
        const conn = await loadPipedreamConnector(projectId, slug);
        if (!conn) return null;
        const effectiveUser = conn.mode === 'per_user' ? userId : null;
        const r = await finalizePipedreamConnection({ projectId, slug, app: conn.app, connectorId: conn.connectorId, userId: effectiveUser });
        return { connected: r.connected, accountId: r.accountId };
      }
    : undefined,
  pipedreamWebhook: pipedreamConfigured()
    ? async (extUserId, sig) => {
        if (!verifyWebhookSig(extUserId, sig)) return false;
        const [projectId, slug, userId] = extUserId.split(':');
        if (!projectId || !slug) return false;
        const conn = await loadPipedreamConnector(projectId, slug);
        if (!conn) return false;
        await finalizePipedreamConnection({ projectId, slug, app: conn.app, connectorId: conn.connectorId, userId: userId ?? null });
        return true;
      }
    : undefined,
  listPipedreamApps: pipedreamConfigured()
    ? (query, cursor) => browsePipedreamApps(query, cursor)
    : undefined,
  getProjectPolicies: getProjectPoliciesFromManifest,
  setProjectPolicies: (projectId, accountId, policies, defaultMode) =>
    setProjectPoliciesInManifest(projectId, accountId, policies, defaultMode),
};
