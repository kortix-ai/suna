/**
 * Integration test (real local PostgreSQL): the database work one proxied
 * request does on `/v1/p/<sandbox>/<port>/…`, and when the sandbox row read is
 * allowed to start.
 *
 * Measured on Dev (2026-10-02), a tiny `/v1/p` call spent ~0.8–1.0 s of its
 * ~0.9–1.3 s total in the database, `db;desc="n=6"`, on a link where every
 * statement crosses a continent. This suite pins:
 *
 *   - the PAT check reads the token row once: the IAM actor takes its binding
 *     from that read instead of selecting the same `account_tokens` row again;
 *   - the ownership check reuses the row the proxy loaded;
 *   - the sandbox row read starts only AFTER authentication and the rate
 *     limiter (a miss can fall back to a case-insensitive scan, so it must not
 *     be reachable unauthenticated or over the limit), and from there overlaps
 *     the rest of the request, e.g. an upload body still arriving.
 *
 * Everything that reads the database is real. Only the provider's network call
 * that resolves the box's address is replaced, with a local fake box.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { createDb } from '@kortix/db';
import { beginStage } from '../lib/server-timing';

// Capture every statement this process sends. Installed before anything
// imports `shared/db`, which reuses the instance it finds here for the same
// URL. Static imports above must not load `shared/db` (they are hoisted).
const statements: string[] = [];
const capture = { on: false };
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
  { onQuery: () => beginStage('db') },
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

// Count every prefetch the proxy app starts.
const prefetched: string[] = [];
// Bun patches a mocked module's namespace in place: keep the real functions.
const { prefetchSandbox: realPrefetchSandbox, takePrefetchedSandbox } = await import(
  '../sandbox-proxy/prefetch'
);
mock.module('../sandbox-proxy/prefetch', () => ({
  takePrefetchedSandbox,
  prefetchSandbox: (...args: Parameters<typeof realPrefetchSandbox>) => {
    prefetched.push(args[1]);
    return realPrefetchSandbox(...args);
  },
}));

const { accounts, accountMembers, accountTokens, projects, projectSessions, sessionSandboxes } =
  await import('@kortix/db');
const { eq } = await import('drizzle-orm');
const { Hono } = await import('hono');
const { config } = await import('../config');
const { db } = await import('../shared/db');
const { runWithContext } = await import('../lib/request-context');
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

type Measured = { status: number; queries: string[] };

async function proxied(
  sandboxId: string,
  path: string,
  init: RequestInit & { duplex?: 'half' } = {},
): Promise<Measured> {
  statements.length = 0;
  capture.on = true;
  try {
    return await runWithContext(
      init.method ?? 'GET',
      `/v1/p/${sandboxId}/8000${path}`,
      async () => {
        const res = await app.request(`/v1/p/${sandboxId}/8000${path}`, init);
        await res.arrayBuffer();
        // Fire-and-forget writes (activity touch, last-used, audit) run on the
        // request's context; let them land so a cold run sees all of them.
        await Bun.sleep(150);
        return { status: res.status, queries: [...statements] };
      },
    );
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
    const cold = await proxied(EXTERNAL_ID, '/file?path=/workspace', { headers: asUser() });
    expect(cold.status).toBe(200);
    const queries = requestStatements(cold);
    expect(queries.filter(isTokenValidation)).toHaveLength(1);
    expect(queries.filter(isTokenBindingReread)).toHaveLength(0);
    expect(queries.filter(isSandboxRowRead)).toHaveLength(1);
    expect(queries.filter(isSandboxRefReread)).toHaveLength(0);
  });

  test('warm: the token check, then the sandbox row, and nothing else', async () => {
    const warm = await proxied(EXTERNAL_ID, '/file?path=/workspace', { headers: asUser() });
    expect(warm.status).toBe(200);
    const queries = requestStatements(warm);
    expect(queries).toHaveLength(2);
    // Authentication first: the row is never read before the caller is known.
    expect(isTokenValidation(queries[0] ?? '')).toBe(true);
    expect(isSandboxRowRead(queries[1] ?? '')).toBe(true);
  });

  test('the row read overlaps an upload body that is still arriving', async () => {
    let rowReadBeforeBodyEnded = false;
    let pulls = 0;
    // `pull` runs only when the server reads the body, so it sees this
    // request's statements, never an earlier test's.
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(new TextEncoder().encode('first chunk;'));
          return;
        }
        for (let waited = 0; waited < 2_000; waited += 20) {
          if (statements.some(isSandboxRowRead)) {
            rowReadBeforeBodyEnded = true;
            break;
          }
          await Bun.sleep(20);
        }
        controller.enqueue(new TextEncoder().encode('last chunk'));
        controller.close();
      },
    });
    const upload = await proxied(EXTERNAL_ID, '/file/upload?path=/workspace/a.txt', {
      method: 'POST',
      headers: { ...asUser(), 'content-type': 'application/octet-stream' },
      body,
      duplex: 'half',
    });
    expect(upload.status).toBe(200);
    expect(rowReadBeforeBodyEnded).toBe(true);
  });

  test('an unauthenticated request starts no prefetch and reads no sandbox row', async () => {
    const before = prefetched.length;
    // A forged credential (it does not verify) and no credential at all.
    const forged = await proxied(EXTERNAL_ID, '/file?path=/workspace', {
      headers: { Authorization: 'Bearer kortix_pat_forged', Cookie: '__preview_session=x' },
    });
    const anonymous = await proxied(EXTERNAL_ID, '/file?path=/workspace');
    expect(forged.status).toBe(401);
    expect(anonymous.status).toBe(401);
    expect(prefetched.length).toBe(before);
    expect(requestStatements(forged).filter(isSandboxRowRead)).toHaveLength(0);
    expect(requestStatements(anonymous).filter(isSandboxRowRead)).toHaveLength(0);
  });

  test('a request over the rate limit starts no prefetch', async () => {
    const key = `sbx_rate_limited_${run}`;
    const limits = config as unknown as { KORTIX_PROXY_REQS_PER_MIN: number };
    const previous = limits.KORTIX_PROXY_REQS_PER_MIN;
    limits.KORTIX_PROXY_REQS_PER_MIN = 2;
    try {
      await proxied(key, '/file', { headers: asUser() });
      await proxied(key, '/file', { headers: asUser() });
      const before = prefetched.length;
      const limited = await proxied(key, '/file', { headers: asUser() });
      expect(limited.status).toBe(429);
      expect(prefetched.length).toBe(before);
      expect(requestStatements(limited).filter(isSandboxRowRead)).toHaveLength(0);
    } finally {
      limits.KORTIX_PROXY_REQS_PER_MIN = previous;
    }
  });

  test('a revoked token is refused on its very next request', async () => {
    await db
      .update(accountTokens)
      .set({ status: 'revoked', revokedAt: new Date() })
      .where(eq(accountTokens.tokenId, patTokenId));
    const revoked = await proxied(EXTERNAL_ID, '/file?path=/workspace', { headers: asUser() });
    expect(revoked.status).toBe(401);
  });
});
