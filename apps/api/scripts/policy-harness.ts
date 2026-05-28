/**
 * Boots the REAL executor router (createExecutorRouter) on a port with
 * in-memory backends + test hooks, so a separate curl process can drive the
 * full policy flow end-to-end. Kept dependency-free: same fakes the e2e tests
 * use, just plumbed through Bun.serve().
 *
 * Usage: PORT=18080 bun run apps/api/scripts/policy-harness.ts
 *        (kill with SIGTERM)
 *
 * Test-only endpoints (NOT in production router):
 *   PUT /__test/world  — reset the world to {policies, defaultMode}
 *   GET /__test/world  — read current state
 */
import { Hono } from 'hono';
import {
  createExecutorRouter,
  type CatalogConnector,
  type DefaultMode,
  type ExecutorPrincipal,
  type ExecutorRouterDeps,
  type ProjectPoliciesViewResponse,
  type ProjectPolicyView,
} from '../src/executor/router';
import type {
  GatewayAction,
  GatewayConnector,
  GatewayDeps,
  ExecutionRecord,
} from '../src/executor/gateway';
import { resolveEffectiveAction, type Policy } from '../src/executor/policy';

const ACCOUNT = 'acct-1';
const PROJECT = 'proj-1';
const USER = 'user-alice';

interface World {
  connectors: Map<string, GatewayConnector>;
  actions: Map<string, GatewayAction>;
  policiesByConnector: Map<string, Policy[]>;
  projectPolicies: Policy[];
  defaultMode: DefaultMode;
  executions: ExecutionRecord[];
  upstream: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }>;
}

function freshWorld(): World {
  const stripe: GatewayConnector = {
    connectorId: 'conn-stripe',
    slug: 'stripe',
    provider: 'openapi',
    baseUrl: 'https://api.stripe.com',
    auth: { type: 'bearer', in: 'header', name: null, prefix: null },
    hasAuth: true,
    shareScope: 'project',
    grants: [],
    credentialMode: 'shared',
    enabled: true,
  };
  const createCharge: GatewayAction = {
    path: 'stripe.charges.create',
    relPath: 'charges.create',
    inputSchema: { type: 'object', properties: { amount: {} } },
    risk: 'write',
    binding: { kind: 'openapi', method: 'POST', path: '/v1/charges', server: 'https://api.stripe.com' },
  };
  const listCharges: GatewayAction = {
    path: 'stripe.charges.list',
    relPath: 'charges.list',
    inputSchema: null,
    risk: 'read',
    binding: { kind: 'openapi', method: 'GET', path: '/v1/charges', server: 'https://api.stripe.com' },
  };
  const deleteCharge: GatewayAction = {
    path: 'stripe.charges.delete',
    relPath: 'charges.delete',
    inputSchema: null,
    risk: 'destructive',
    binding: { kind: 'openapi', method: 'DELETE', path: '/v1/charges/{id}', server: 'https://api.stripe.com' },
  };
  return {
    connectors: new Map([['stripe', stripe]]),
    actions: new Map([
      ['conn-stripe|charges.create', createCharge],
      ['conn-stripe|charges.list', listCharges],
      ['conn-stripe|charges.delete', deleteCharge],
    ]),
    policiesByConnector: new Map(),
    projectPolicies: [],
    defaultMode: 'allow_all',
    executions: [],
    upstream: [],
  };
}

let world: World = freshWorld();

function principalFor(userId: string): ExecutorPrincipal {
  return { userId, accountId: ACCOUNT, projectId: PROJECT, sessionId: 'sess-1', subject: { userId, groupIds: [] } };
}

function catalogFor(p: ExecutorPrincipal): CatalogConnector[] {
  const out: CatalogConnector[] = [];
  for (const conn of world.connectors.values()) {
    const connectorPolicies = world.policiesByConnector.get(conn.connectorId) ?? [];
    const actions = [...world.actions.entries()]
      .filter(([k]) => k.startsWith(`${conn.connectorId}|`))
      .filter(([, a]) =>
        resolveEffectiveAction({
          fullPath: a.path,
          relPath: a.relPath,
          projectPolicies: world.projectPolicies,
          connectorPolicies,
          risk: a.risk,
          defaultMode: world.defaultMode,
        }).action !== 'block',
      )
      .map(([, a]) => ({ path: a.relPath, name: a.path, description: '', risk: a.risk, inputSchema: a.inputSchema }));
    out.push({ slug: conn.slug, name: conn.slug, provider: conn.provider, status: 'active', actions });
    void p;
  }
  return out;
}

function makeGatewayDeps(): GatewayDeps {
  return {
    loadConnectorBySlug: async (_p, slug) => world.connectors.get(slug) ?? null,
    loadAction: async (connectorId, rel) => world.actions.get(`${connectorId}|${rel}`) ?? null,
    resolveCredential: async () => 'sk_live_test',
    loadPolicies: async (connectorId) => world.policiesByConnector.get(connectorId) ?? [],
    loadProjectPolicies: async () => world.projectPolicies,
    loadDefaultMode: async () => world.defaultMode,
    enforcePolicies: true,
    recordExecution: async (r) => { world.executions.push(r); },
    fetchImpl: async (url, init) => {
      world.upstream.push({ url, method: init.method, headers: init.headers, body: typeof init.body === 'string' ? init.body : undefined });
      return { status: 200, ok: true, text: async () => '{"id":"ch_1","paid":true}' };
    },
  };
}

const deps: ExecutorRouterDeps = {
  resolvePrincipal: async (c) => {
    const token = c.req.header('Authorization');
    return token === 'Bearer test-executor-token' ? principalFor(USER) : null;
  },
  makeGatewayDeps,
  listCatalog: async (p) => catalogFor(p),
  resolveAdmin: async (c) => {
    return c.req.header('X-Test-Admin') === 'alice' ? { accountId: ACCOUNT, userId: USER } : null;
  },
  listConnectors: async () => [],
  syncConnectors: async () => ({ synced: world.connectors.size, errors: [] }),
  setSharing: async () => true,
  getProjectPolicies: async (): Promise<ProjectPoliciesViewResponse> => ({
    policies: world.projectPolicies.map((p) => ({ match: p.match, action: p.action })),
    defaultMode: world.defaultMode,
    errors: [],
  }),
  setProjectPolicies: async (_pid, _aid, policies: ProjectPolicyView[], defaultMode) => {
    world.projectPolicies = policies.map((p, i) => ({ match: p.match, action: p.action, position: i }));
    world.defaultMode = defaultMode;
    return { ok: true, sync: { synced: world.connectors.size, errors: [] } };
  },
};

const executor = createExecutorRouter(deps);

const app = new Hono();
app.route('/v1/executor', executor);

// ── Test-only world inspection / reset (NOT mounted in production) ────────────
app.get('/__test/world', (c) =>
  c.json({
    projectPolicies: world.projectPolicies,
    defaultMode: world.defaultMode,
    connectorPolicies: Object.fromEntries(world.policiesByConnector),
    upstreamCalls: world.upstream.length,
    executions: world.executions.length,
  }),
);
app.post('/__test/reset', (c) => {
  world = freshWorld();
  return c.json({ ok: true });
});

const port = Number(process.env.PORT ?? 18080);
const server = Bun.serve({ port, fetch: app.fetch });
console.log(`policy-harness listening on http://localhost:${server.port}`);
console.log(`  PROJECT=${PROJECT}  USER=${USER}`);
console.log(`  exec token: Bearer test-executor-token`);
console.log(`  admin header: X-Test-Admin: alice`);
