/**
 * KRTX-2017: one `POST /v1/connectors/projects/:id/call` request must read a
 * small, constant number of database statements — not a count that grows with
 * every call.
 *
 * Before KRTX-2017 the request fanned out over ~26 statements: the same rows
 * were re-read several times (the stored agent grant was read once by auth and
 * again by the grant reconcile; the git project row was loaded twice inside the
 * reconcile; the connector row was read twice, once for the call and once more
 * just for `provider_type`), and every call re-resolved the session's stored
 * grant from the project manifest.
 *
 * This suite drives the REAL app (Hono `app` + real PostgreSQL, the way prod
 * serves the route) and pins the request's `Server-Timing: db n=` budget. The
 * fixture is prod-shaped: a private session with an ACTIVE sandbox, a session
 * token carrying an agent grant that names the connector, an openapi connector
 * whose action runs against a loopback stub, and a local bare git upstream with
 * a manifest declaring the session's agent, so the grant reconcile's manifest
 * fan-out actually runs (an unreachable upstream keeps the stored grant and
 * skips the reads this suite pins).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { app } from '../index';
import { db } from '../shared/db';
import {
  localTestDatabaseUrl,
  seedProject,
  seedSession,
  removeSeeded,
  type SeededProject,
} from './helpers/integration-fixtures';
import { insertIntoView } from './helpers/compat-views';
import { createLocalGitUpstream } from './helpers/local-git-upstream';
import {
  accountMembers,
  connectorActions,
  connectors,
  projectMembers,
  projectSessions,
  projects,
  sessionSandboxes,
} from '@kortix/db';
import { createAccountToken } from '../repositories/account-tokens';
import { config } from '../config';
import {
  ensureDefaultConnection,
  upsertConnectionCredential,
} from '../connectors/credentials';

/**
 * The statement budget one /call request may spend. Above this, the request is
 * the fan-out KRTX-2017 named; below it, the duplicated reads are gone.
 *
 * The lane runs unmemoized (ttlMemo stays off under NODE_ENV=test, so a suite
 * that seeds policies mid-file keeps enforcing them), so this pins the
 * per-call WORST case — every read the request itself performs, no cache
 * credit. 22 = token + sandbox liveness + account/project/session rows, ONE
 * git-project row + ONE manifest load for the grant reconcile, connector +
 * connection + binding + credential reads, the policy reads, and the audit
 * insert. The pre-fix request spent 24 on the same fixture; the memoized
 * warm path production serves spends less still (measured on the local
 * stack: db n=15 per call).
 */
const CALL_STATEMENT_BUDGET = 22;

const AGENT = 'main';
const CONNECTOR_SLUG = 'stub';
const ACTION_RELPATH = 'charges.create';

let fixture: {
  project: SeededProject;
  userId: string;
  sessionId: string;
  token: string;
  connectorId: string;
} | null = null;
let upstream: ReturnType<typeof createLocalGitUpstream> | null = null;
let stubServer: ReturnType<typeof Bun.serve> | null = null;

beforeAll(async () => {
  localTestDatabaseUrl();
  // The stub upstream answers on loopback, which the connector egress guard
  // refuses by default; the suite allows it for its own fixture's host.
  config.KORTIX_CONNECTOR_EGRESS_ALLOW_HOSTS = ['127.0.0.1', 'localhost'];

  // A bare repository on disk as the project's git upstream: the mirror reads
  // it in milliseconds and the manifest read completes, so the reconcile
  // fan-out this suite pins actually runs.
  upstream = createLocalGitUpstream('call-connector-fanout', {
    'kortix.yaml': [
      'kortix_version: 2',
      'default_agent: main',
      'agents:',
      `  ${AGENT}:`,
      '    connectors: [stub]',
      '    kortix_permissions: all',
      '    secrets: all',
      '',
    ].join('\n'),
    'agents/main.md': '# main\n\nTest agent for the /call fan-out suite.\n',
  });

  stubServer = Bun.serve({
    port: 0,
    idleTimeout: 30,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === 'POST' && url.pathname === '/v1/charges') {
        return Response.json({ id: 'ch_test_1', object: 'charge', ok: true }, { status: 201 });
      }
      return Response.json({ error: { message: `no route ${req.method} ${url.pathname}` } }, { status: 404 });
    },
  });

  const project = await seedProject('call-fanout');
  const userId = crypto.randomUUID();
  await insertIntoView(db, accountMembers, {
    accountId: project.account_id,
    userId,
    accountRole: 'owner',
  });
  await insertIntoView(db, projectMembers, {
    accountId: project.account_id,
    projectId: project.project_id,
    userId,
    projectRole: 'manager',
  });
  // Point the PROJECT at the local upstream (seedProject writes a dead URL).
  await db
    .update(projects)
    .set({ repoUrl: upstream.repoUrl })
    .where(eq(projects.projectId, project.project_id));

  const sessionId = await seedSession(project, userId);
  // The session runs AGENT and the token's grant names it, so the reconcile
  // has nothing to heal and the manifest fan-out is what runs.
  await db
    .update(projectSessions)
    .set({ agentName: AGENT })
    .where(eq(projectSessions.sessionId, sessionId));

  const sandboxId = crypto.randomUUID();
  await db.insert(sessionSandboxes).values({
    sandboxId,
    sessionId,
    accountId: project.account_id,
    projectId: project.project_id,
    provider: 'daytona',
    status: 'active',
    externalId: 'call-fanout-box',
    baseUrl: 'http://127.0.0.1:1',
    deadlineAt: new Date(Date.now() + 24 * 3600 * 1000),
  });

  const token = await createAccountToken({
    accountId: project.account_id,
    userId,
    projectId: project.project_id,
    sessionId,
    name: 'call-fanout-session-token',
    agentGrant: {
      agent: AGENT,
      permissions: ['all'],
      connectors: [CONNECTOR_SLUG],
      env: 'all',
    },
  });

  const stubBase = `http://127.0.0.1:${stubServer.port}`;
  const [connector] = await db
    .insert(connectors)
    .values({
      accountId: project.account_id,
      projectId: project.project_id,
      slug: CONNECTOR_SLUG,
      name: 'Stub',
      providerType: 'openapi',
      enabled: true,
      status: 'active',
      config: {
        base_url: stubBase,
        auth: { type: 'bearer', in: 'header', name: 'Authorization', prefix: 'Bearer' },
      },
    })
    .returning();

  await db.insert(connectorActions).values({
    connectorId: connector.connectorId,
    path: ACTION_RELPATH,
    name: 'Create charge',
    description: 'test action',
    inputSchema: { type: 'object', properties: { amount: { type: 'number' } } },
    risk: 'write',
    binding: { kind: 'openapi', method: 'POST', path: '/v1/charges', server: stubBase },
  });

  const connectionId = await ensureDefaultConnection({
    projectId: project.project_id,
    connectorId: connector.connectorId,
    createdBy: userId,
  });
  await upsertConnectionCredential({
    projectId: project.project_id,
    connectorId: connector.connectorId,
    connectionId,
    value: 'sk_test_call_fanout',
  });

  fixture = {
    project,
    userId,
    sessionId,
    token: token.secretKey,
    connectorId: connector.connectorId,
  };
});

afterAll(async () => {
  if (fixture) {
    await db.delete(connectors).where(eq(connectors.connectorId, fixture.connectorId));
    await removeSeeded([fixture.project]);
  }
  stubServer?.stop(true);
  upstream?.remove();
});

/** `db;dur=…;desc="n=N"` out of a `Server-Timing` header. */
function dbStatementCount(res: Response): number {
  const timing = res.headers.get('Server-Timing') ?? '';
  const entry = timing.split(',').find((part) => part.trim().startsWith('db;'));
  const match = /desc="n=(\d+)"/.exec(entry ?? '');
  if (!match) throw new Error(`no db statement count in Server-Timing: ${timing}`);
  return Number(match[1]);
}

/** One real /call through the Hono app. */
function callConnector(): Promise<Response> {
  return Promise.resolve(
    app.request(
      `/v1/connectors/projects/${fixture!.project.project_id}/call`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${fixture!.token}`,
        },
        body: JSON.stringify({
          connector: CONNECTOR_SLUG,
          action: ACTION_RELPATH,
          args: { amount: 4200, currency: 'usd' },
        }),
      },
    ),
  );
}

test('one connector call reads a bounded number of statements', async () => {
  // Warm-up: the first call may re-mint the token's grant (the seeded grant
  // carries no manifest provenance) and pays the mirror's first clone.
  const warmup = await callConnector();
  const warmupBody = (await warmup.json().catch(() => null)) as unknown;
  expect(warmup.status, JSON.stringify(warmupBody)).toBe(200);
  expect(warmupBody).toMatchObject({ ok: true });

  const res = await callConnector();
  const resBody = (await res.json().catch(() => null)) as unknown;
  expect(res.status, JSON.stringify(resBody)).toBe(200);
  expect(resBody).toMatchObject({ ok: true });

  const statements = dbStatementCount(res);
  expect(statements).toBeLessThanOrEqual(CALL_STATEMENT_BUDGET);

  // The fix's shape: a second call spends the same as the first one — the
  // per-call count is a constant, not a function of how many calls ran.
  const res2 = await callConnector();
  expect(res2.status).toBe(200);
  expect(dbStatementCount(res2)).toBeLessThanOrEqual(CALL_STATEMENT_BUDGET);
});
