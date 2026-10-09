/**
 * KRTX-2018: one `POST /v1/projects/:id/sessions/:id/start` request must read a
 * bounded number of database statements — not a count that grows with the
 * server-side long-poll.
 *
 * Measured before the diet (2026-10-09, prod signals + this fixture): the
 * request spent two statements per 200 ms long-poll tick — the resolve's
 * `project_sessions` read and `openSession`'s own re-read of the same tick's
 * `session_sandboxes` row — plus a separate `session_sandboxes.config` probe
 * by the token heal and a full row read by the first open. A 15 s boot wait
 * (74 ticks) measured 168 statements on the local stack; prod carried the same
 * shape at 46 statements/request average and 96 at p-max over 2,569 req/day.
 *
 * This suite drives the REAL app (Hono `app` + real PostgreSQL, the way prod
 * serves the route) and pins the `Server-Timing: db n=` budget for both call
 * shapes: the one-shot open and a bounded long-poll. The fixture is
 * prod-shaped: a private session with an ACTIVE platinum sandbox whose
 * control plane answers from a loopback stub while its daemon stays
 * unreachable, billing admission on (the free-tier init pays once, in the
 * warm-up), and the IAM fold unmemoized (the lane runs with ttlMemo disabled,
 * so this pins the per-request worst case — every read the request itself
 * performs, no cache credit).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { app } from '../index';
import { db } from '../shared/db';
import { config } from '../config';
import {
  localTestDatabaseUrl,
  seedProject,
  seedSession,
  removeSeeded,
  type SeededProject,
} from './helpers/integration-fixtures';
import { insertIntoView } from './helpers/compat-views';
import {
  accountMembers,
  projectMembers,
  projectSessions,
  sessionSandboxes,
} from '@kortix/db';
import { createAccountToken } from '../repositories/account-tokens';

/**
 * The statement budget ONE /start request may spend.
 *
 * ONE-SHOT (no long-poll): token validation + last-used write, the project
 * row, the IAM fold (account- and project-scoped role assignments, the
 * principal record, the roles/permissions catalogs — twice, the engine
 * resolves the actor for the project gate and again for the agent filter),
 * the token binding, visibility (subject grants + session row), the agent
 * object grants, billing, the session+sandbox read, and the audit insert.
 *
 * LONG-POLL (`wait_ms=2000`): the one-shot cost plus one joined
 * session+sandbox read per ~200 ms tick. Before the diet every tick also
 * re-read the sandbox row inside `openSession` — the two-per-tick fan-out
 * this suite pins out.
 */
const ONE_SHOT_STATEMENT_BUDGET = 30;
const LONG_POLL_STATEMENT_BUDGET = 42;

/** The long-poll the second suite runs. Ten ticks at the default 200 ms. */
const LONG_POLL_MS = 2000;

let fixture: {
  project: SeededProject;
  userId: string;
  sessionId: string;
  token: string;
} | null = null;
let stubServer: ReturnType<typeof Bun.serve> | null = null;
const savedConfig: Record<string, unknown> = {};

beforeAll(async () => {
  localTestDatabaseUrl();

  // The platinum control plane answers on loopback (the sandbox is
  // provider-running); its daemon never does (the session stays in the
  // booting state the long-poll serves). This is the prod-shaped mix for a
  // wake: the box is up, OpenCode is not answering yet.
  stubServer = Bun.serve({
    port: 0,
    idleTimeout: 30,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.startsWith('/v1/sandboxes/')) {
        return Response.json({ id: url.pathname.split('/')[3], state: 'running' });
      }
      return Response.json({ error: `no route ${url.pathname}` }, { status: 404 });
    },
  });
  savedConfig.PLATINUM_API_URL = config.PLATINUM_API_URL;
  savedConfig.PLATINUM_API_KEY = config.PLATINUM_API_KEY;
  savedConfig.ALLOWED_SANDBOX_PROVIDERS = config.ALLOWED_SANDBOX_PROVIDERS;
  savedConfig.KORTIX_BILLING_INTERNAL_ENABLED = config.KORTIX_BILLING_INTERNAL_ENABLED;
  config.PLATINUM_API_URL = `http://127.0.0.1:${stubServer.port}`;
  config.PLATINUM_API_KEY = 'pt_test_start_statement_budget';
  config.ALLOWED_SANDBOX_PROVIDERS = ['platinum'];
  config.KORTIX_BILLING_INTERNAL_ENABLED = true;

  const project = await seedProject('start-budget');
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
  const sessionId = await seedSession(project, userId);
  await db
    .update(projectSessions)
    .set({ agentName: 'main' })
    .where(eq(projectSessions.sessionId, sessionId));
  await db.insert(sessionSandboxes).values({
    sandboxId: crypto.randomUUID(),
    sessionId,
    accountId: project.account_id,
    projectId: project.project_id,
    provider: 'platinum',
    status: 'active',
    externalId: 'start-budget-box',
    baseUrl: 'http://127.0.0.1:1',
    deadlineAt: new Date(Date.now() + 24 * 3600 * 1000),
  });
  const token = await createAccountToken({
    accountId: project.account_id,
    userId,
    name: 'start-budget-pat',
  });
  fixture = { project, userId, sessionId, token: token.secretKey };
});

afterAll(async () => {
  if (fixture) await removeSeeded([fixture.project]);
  stubServer?.stop(true);
  for (const [key, value] of Object.entries(savedConfig)) {
    (config as unknown as Record<string, unknown>)[key] = value;
  }
});

/** `db;dur=…;desc="n=N"` out of a `Server-Timing` header. */
function dbStatementCount(res: Response): number {
  const timing = res.headers.get('Server-Timing') ?? '';
  const entry = timing.split(',').find((part) => part.trim().startsWith('db;'));
  const match = /desc="n=(\d+)"/.exec(entry ?? '');
  if (!match) throw new Error(`no db statement count in Server-Timing: ${timing}`);
  return Number(match[1]);
}

function startSession(waitMs?: number): Promise<Response> {
  const query = waitMs ? `?wait_ms=${waitMs}` : '';
  return Promise.resolve(
    app.request(
      `/v1/projects/${fixture!.project.project_id}/sessions/${fixture!.sessionId}/start${query}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${fixture!.token}`,
        },
        body: JSON.stringify({}),
      },
    ),
  );
}

test('one-shot /start reads a bounded number of statements', async () => {
  expect(fixture).not.toBeNull();
  // Warm-up: absorbs the billing free-tier initialization and the driver's
  // first per-connection type preparation, neither of which the steady-state
  // request pays.
  await startSession();
  const res = await startSession();
  expect(res.status).toBe(200);
  const n = dbStatementCount(res);
  console.info(`[start-budget] one-shot db statements: ${n} (budget ${ONE_SHOT_STATEMENT_BUDGET})`);
  expect(n).toBeLessThanOrEqual(ONE_SHOT_STATEMENT_BUDGET);
}, 30_000);

test('a bounded long-poll stays flat per tick', async () => {
  expect(fixture).not.toBeNull();
  const res = await startSession(LONG_POLL_MS);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { stage?: string };
  expect(body.stage).toBe('starting');
  const n = dbStatementCount(res);
  console.info(
    `[start-budget] long-poll ${LONG_POLL_MS}ms db statements: ${n} (budget ${LONG_POLL_STATEMENT_BUDGET})`,
  );
  expect(n).toBeLessThanOrEqual(LONG_POLL_STATEMENT_BUDGET);
}, 30_000);
