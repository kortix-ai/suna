/**
 * Integration test (real local PostgreSQL): the database round trips one
 * proxied request costs on `/v1/p/<sandbox>/<port>/…`.
 *
 * Measured on Dev (2026-10-02), a tiny `/v1/p` call spent ~0.8–1.0 s of its
 * ~0.9–1.3 s total in the database, `db;desc="n=6"`, on a link where every
 * statement crosses a continent. On such a link the number of SEQUENTIAL
 * statements sets the latency, so this suite pins both the statements and
 * their overlap:
 *
 *   - the PAT check reads the token row once: the IAM actor takes its binding
 *     from that read instead of selecting the same `account_tokens` row again;
 *   - the sandbox row read starts before authentication and overlaps it;
 *   - the ownership check reuses the row the proxy loaded instead of selecting
 *     it a second time.
 *
 * Everything that reads the database is real. Only the provider's network call
 * that resolves the box's address is replaced, with a local fake box.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { createDb } from '@kortix/db';
import { beginStage } from '../lib/server-timing';

// Capture every statement this process sends and how many are in flight at
// once. Installed before anything imports `shared/db`, which reuses the
// instance it finds here for the same URL. Static imports above must not load
// `shared/db` (they are hoisted ahead of this).
const statements: string[] = [];
const capture = { on: false, inflight: 0, maxInflight: 0 };
const DATABASE_URL = process.env.DATABASE_URL ?? '';
const globalForDb = globalThis as typeof globalThis & {
  __kortixApiDb?: unknown;
  __kortixApiDbUrl?: string;
};
globalForDb.__kortixApiDb = createDb(
  DATABASE_URL,
  {
    debug: (_connection: number, query: string) => {
      if (capture.on) statements.push(query.replace(/\s+/g, ' ').trim());
    },
  },
  {
    onQuery: () => {
      const endStage = beginStage('db');
      if (!capture.on) return endStage;
      capture.inflight += 1;
      capture.maxInflight = Math.max(capture.maxInflight, capture.inflight);
      let done = false;
      return () => {
        if (done) return;
        done = true;
        capture.inflight -= 1;
        endStage();
      };
    },
  },
);
globalForDb.__kortixApiDbUrl = DATABASE_URL;

// The fake box: answers every path with a small JSON body, like a file list.
const box = Bun.serve({ port: 0, fetch: () => Response.json([{ name: 'a.txt', type: 'file' }]) });

const realProviders = await import('../platform/providers');
mock.module('../platform/providers', () => ({
  ...realProviders,
  getProvider: (name: string) => ({
    name,
    ingressCacheTtlMs: 5 * 60 * 1000,
    routeIngress: (request: { port: number }) => ({ effectivePort: request.port }),
    resolveIngress: async () => ({ url: `http://127.0.0.1:${box.port}`, headers: {} }),
  }),
}));

const { accounts, accountMembers, accountTokens, projects, projectSessions, sessionSandboxes } =
  await import('@kortix/db');
const { eq } = await import('drizzle-orm');
const { Hono } = await import('hono');
const { db } = await import('../shared/db');
const { runWithContext } = await import('../lib/request-context');
const { stageSnapshot } = await import('../lib/server-timing');
const { createAccountToken } = await import('../repositories/account-tokens');
const { sandboxProxyApp } = await import('../sandbox-proxy');
const { insertIntoView } = await import('./helpers/compat-views');

const run = crypto.randomUUID().slice(0, 8);
const ACCOUNT = crypto.randomUUID();
const USER = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const SESSION = crypto.randomUUID();
const SANDBOX = crypto.randomUUID();
const EXTERNAL_ID = `sbx_hot_path_${run}`;
let pat = '';
let patTokenId = '';

const app = new Hono().route('/v1/p', sandboxProxyApp);

type Measured = { status: number; db: number; maxInflight: number; queries: string[] };

async function proxiedGet(path: string, headers: Record<string, string>): Promise<Measured> {
  statements.length = 0;
  capture.on = true;
  capture.inflight = 0;
  capture.maxInflight = 0;
  try {
    return await runWithContext('GET', `/v1/p/${EXTERNAL_ID}/8000${path}`, async () => {
      const res = await app.request(`/v1/p/${EXTERNAL_ID}/8000${path}`, { headers });
      await res.arrayBuffer();
      // Fire-and-forget writes (activity touch, last-used, audit) run on the
      // request's context; let them land so a cold run sees all of them.
      await Bun.sleep(150);
      return {
        status: res.status,
        db: stageSnapshot().db?.count ?? 0,
        maxInflight: capture.maxInflight,
        queries: [...statements],
      };
    });
  } finally {
    capture.on = false;
  }
}

const asUser = () => ({ Authorization: `Bearer ${pat}` });
/** Postgres.js type introspection runs once per new connection, not per request. */
const requestStatements = (m: Measured) =>
  m.queries.filter((q) => !q.includes('pg_catalog.pg_type'));
const isTokenBindingReread = (q: string) =>
  q.startsWith('select "project_id", "agent_grant", "service_account_id"') &&
  q.includes('"account_tokens"');
const isSandboxRefReread = (q: string) =>
  q.startsWith('select "sandbox_id", "account_id", "project_id" from "kortix"."session_sandboxes"');
const isSandboxRowRead = (q: string) =>
  q.startsWith('select "kortix"."session_sandboxes"."sandbox_id"');
const isTokenValidation = (q: string) =>
  q.startsWith('select "kortix"."account_tokens"."token_id"');

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: `hot-path-${run}` });
  await insertIntoView(db, accountMembers, [
    { userId: USER, accountId: ACCOUNT, accountRole: 'owner' },
  ]);
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: `hot-path-${run}`,
    repoUrl: 'https://example.test/hot-path.git',
  });
  await db.insert(projectSessions).values({
    sessionId: SESSION,
    accountId: ACCOUNT,
    projectId: PROJECT,
    branchName: `session/${SESSION}`,
    createdBy: USER,
    visibility: 'private',
    status: 'running',
  });
  await db.insert(sessionSandboxes).values({
    sandboxId: SANDBOX,
    sessionId: SESSION,
    accountId: ACCOUNT,
    projectId: PROJECT,
    externalId: EXTERNAL_ID,
    provider: 'platinum',
    status: 'active',
    baseUrl: `http://127.0.0.1:${box.port}`,
    config: { serviceKey: `sk_hot_path_${run}` },
    deadlineAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  const created = await createAccountToken({
    accountId: ACCOUNT,
    userId: USER,
    name: `hot-path-${run}`,
  });
  pat = created.secretKey;
  patTokenId = created.tokenId;
});

afterAll(() => {
  box.stop(true);
});

describe('/v1/p hot path database round trips', () => {
  test('cold: the token row and the sandbox row are each read once', async () => {
    const cold = await proxiedGet('/file?path=/workspace', asUser());
    if (process.env.HOT_PATH_REPORT)
      await Bun.write(`${process.env.HOT_PATH_REPORT}.cold.json`, JSON.stringify(cold, null, 2));
    expect(cold.status).toBe(200);
    const queries = requestStatements(cold);
    expect(queries.filter(isTokenValidation)).toHaveLength(1);
    expect(queries.filter(isTokenBindingReread)).toHaveLength(0);
    expect(queries.filter(isSandboxRowRead)).toHaveLength(1);
    expect(queries.filter(isSandboxRefReread)).toHaveLength(0);
  });

  test('warm: two reads, in flight together', async () => {
    const warm = await proxiedGet('/file?path=/workspace', asUser());
    if (process.env.HOT_PATH_REPORT)
      await Bun.write(`${process.env.HOT_PATH_REPORT}.warm.json`, JSON.stringify(warm, null, 2));
    expect(warm.status).toBe(200);
    const queries = requestStatements(warm);
    // The PAT check and the sandbox row: nothing else on a warm request.
    expect(queries.filter(isTokenValidation)).toHaveLength(1);
    expect(queries.filter(isSandboxRowRead)).toHaveLength(1);
    expect(queries).toHaveLength(2);
    // The sandbox row read no longer waits for authentication.
    expect(warm.maxInflight).toBeGreaterThanOrEqual(2);
    expect(isSandboxRowRead(queries[0] ?? '')).toBe(true);
  });

  test('a request without a credential reads no sandbox row', async () => {
    const anonymous = await proxiedGet('/file?path=/workspace', {});
    expect(anonymous.status).toBe(401);
    expect(requestStatements(anonymous).filter(isSandboxRowRead)).toHaveLength(0);
  });

  test('a revoked token is refused on its very next request', async () => {
    await db
      .update(accountTokens)
      .set({ status: 'revoked', revokedAt: new Date() })
      .where(eq(accountTokens.tokenId, patTokenId));
    const revoked = await proxiedGet('/file?path=/workspace', asUser());
    expect(revoked.status).toBe(401);
  });
});
