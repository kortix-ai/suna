import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accounts, apps, projects } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { config } from '../../../config';
import { db } from '../../../shared/db';
import { inspectDatabaseError } from '../../../shared/database-errors';
import { encryptProjectSecret } from '../../../projects/surface';
import { authEnv, projectIssuer, projectSigner } from '../../tokens';
import { EMPTY_BACKEND_SWEEP, issuerStep } from './maintenance';
import {
  BackendLimitError,
  MAX_BACKENDS_PER_ACCOUNT,
  MAX_BACKENDS_PER_PROJECT,
  getLiveConvexApp,
  insertConvexApp,
} from './provision';
import { insertConvexRow } from '../../../__tests__/helpers/convex-apps';

// insertConvexApp counts and inserts under one per-account advisory lock, so
// concurrent creates cannot overshoot the project cap (3) or the account cap
// (10). Before the lock, every create of a burst passed the count together.
const ACCOUNT = crypto.randomUUID();
const OTHER_ACCOUNT = crypto.randomUUID();
const USER = crypto.randomUUID();
const PROJECTS = Array.from({ length: 5 }, () => crypto.randomUUID());
const OTHER_PROJECT = crypto.randomUUID();
const SHAPE_PROJECT = crypto.randomUUID();

beforeAll(async () => {
  await db.insert(accounts).values([
    { accountId: ACCOUNT, name: 'backend-cap-test' },
    { accountId: OTHER_ACCOUNT, name: 'backend-cap-other' },
  ]);
  await db.insert(projects).values([
    ...PROJECTS.map((projectId, i) => ({
      projectId,
      accountId: ACCOUNT,
      name: `backend-cap-${i}`,
      repoUrl: `https://example.com/backend-cap-${i}.git`,
    })),
    { projectId: OTHER_PROJECT, accountId: OTHER_ACCOUNT, name: 'backend-cap-other', repoUrl: 'https://example.com/o.git' },
    { projectId: SHAPE_PROJECT, accountId: OTHER_ACCOUNT, name: 'backend-cap-shape', repoUrl: 'https://example.com/s.git' },
  ]);
});

afterAll(async () => {
  for (const accountId of [ACCOUNT, OTHER_ACCOUNT]) {
    await db.delete(apps).where(eq(apps.accountId, accountId));
    await db.delete(projects).where(eq(projects.accountId, accountId));
    await db.delete(accounts).where(eq(accounts.accountId, accountId));
  }
});

const create = async (projectId: string, accountId: string, slug: string) =>
  (await insertConvexApp({ projectId, accountId, userId: USER, slug, name: slug })).row;

async function liveCount(where: ReturnType<typeof eq>): Promise<number> {
  return (await db.select({ id: apps.appId }).from(apps).where(and(where, eq(apps.kind, 'convex')))).length;
}

describe('insertConvexApp caps', () => {
  test('10 concurrent creates in one project leave exactly 3 rows; the rest answer BackendLimitError', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => create(PROJECTS[0]!, ACCOUNT, `burst-${i}`)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(MAX_BACKENDS_PER_PROJECT);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(10 - MAX_BACKENDS_PER_PROJECT);
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(BackendLimitError);
      expect(String(r.reason.message)).toContain('a project can have at most 3 backend Apps');
    }
    expect(await liveCount(eq(apps.projectId, PROJECTS[0]!))).toBe(MAX_BACKENDS_PER_PROJECT);
  });

  test('concurrent creates across projects stop at the account cap of 10; another account is unaffected', async () => {
    // PROJECTS[0] already holds 3. Four more projects × 3 attempts = 12 attempts for 7 free slots.
    const attempts = PROJECTS.slice(1).flatMap((projectId, p) =>
      Array.from({ length: 3 }, (_, i) => create(projectId, ACCOUNT, `p${p}-${i}`)),
    );
    const results = await Promise.allSettled(attempts);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(MAX_BACKENDS_PER_ACCOUNT - MAX_BACKENDS_PER_PROJECT);
    expect(await liveCount(eq(apps.accountId, ACCOUNT))).toBe(MAX_BACKENDS_PER_ACCOUNT);
    const accountRefusals = results.filter(
      (r) => r.status === 'rejected' && String(r.reason.message).includes('an account can have at most 10 backend Apps'),
    );
    expect(accountRefusals.length).toBeGreaterThan(0);

    await create(OTHER_PROJECT, OTHER_ACCOUNT, 'main');
    expect(await liveCount(eq(apps.accountId, OTHER_ACCOUNT))).toBe(1);
  });

  test('a convex App is created with kind convex and always on; its machine row waits to provision', async () => {
    const row = await create(SHAPE_PROJECT, OTHER_ACCOUNT, 'shape');
    const [app] = await db.select().from(apps).where(eq(apps.appId, row.appId));
    expect(app).toMatchObject({ kind: 'convex', alwaysOn: true, cpuCores: 1, memoryGb: 1, diskGb: 10 });
    expect(row).toMatchObject({ status: 'provisioning', provider: 'platinum', externalId: null, slug: 'shape' });
  });

  test('a size outside the machine limits answers BackendLimitError invalid_size before any row exists', async () => {
    const error = await insertConvexApp({
      projectId: SHAPE_PROJECT, accountId: OTHER_ACCOUNT, userId: USER, slug: 'too-big', name: 'too-big',
      size: { cpu: 64 },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BackendLimitError);
    expect((error as BackendLimitError).code).toBe('invalid_size');
    expect(await liveCount(eq(apps.slug, 'too-big'))).toBe(0);
  });

  test('a duplicate live slug still fails with the unique violation, not a limit error', async () => {
    await create(OTHER_PROJECT, OTHER_ACCOUNT, 'dup');
    const error = await create(OTHER_PROJECT, OTHER_ACCOUNT, 'dup').catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(BackendLimitError);
    expect(inspectDatabaseError(error)?.pgCode).toBe('23505');
  });
});

describe('sign-in issuer', () => {
  const apiOrigin = (config.KORTIX_URL ?? '').replace(/\/+$/, '').replace(/\/v1$/, '');

  test('the project issuer is <public API origin>/v1/projects/<project id>; a new App trusts none until its environment is written', async () => {
    const row = await create(OTHER_PROJECT, OTHER_ACCOUNT, 'issuer');
    expect(apiOrigin).toMatch(/^https?:\/\//);
    expect(projectIssuer(OTHER_PROJECT)).toBe(`${apiOrigin}/v1/projects/${OTHER_PROJECT}`);
    expect(row.authIssuer).toBeNull();
  });

  test('maintenance moves an App off another issuer: all three KORTIX_AUTH_* written; a failed write is retried, a moved App is left alone', async () => {
    const envWrites: Array<{ path: string; auth: string | null; edgeToken: string | null; body: unknown }> = [];
    const ok = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (req) => {
        envWrites.push({
          path: new URL(req.url).pathname,
          auth: req.headers.get('authorization'),
          edgeToken: req.headers.get('x-pt-preview-token'),
          body: await req.json(),
        });
        return new Response(null, { status: 200 });
      },
    });
    const down = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('boom', { status: 500 }) });
    // Kortix reaches a machine through its private Platinum exposure: the fake
    // control plane exposes a machine whose id ends in `-ok` at `ok`, any other at `down`.
    const platinum = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req) => {
        const [, , , id, sub] = new URL(req.url).pathname.split('/');
        if (sub !== 'expose') return Response.json({ id, state: 'running' });
        // Loopback by address: `localhost` does not resolve on a platform sandbox, and the API fetches this URL (shared/platinum.test.ts convention).
        const origin = id!.endsWith('-ok') ? `http://127.0.0.1:${ok.port}` : `http://127.0.0.1:${down.port}`;
        return Response.json({ port: 3210, public: false, url: `${origin}/?t=synthetic-edge-token` });
      },
    });
    const saved = { key: config.PLATINUM_API_KEY, url: config.PLATINUM_API_URL };
    config.PLATINUM_API_KEY = 'pt_synthetic_issuer_move';
    config.PLATINUM_API_URL = `http://127.0.0.1:${platinum.port}`;
    const project = PROJECTS[4]!;
    try {
      const running = async (name: string, externalId: string, authIssuer: string | null) =>
        (
          await insertConvexRow({
            projectId: project,
            accountId: ACCOUNT,
            slug: name,
            status: 'running',
            externalId,
            url: `https://legacy-${name}.example`,
            adminKeyEnc: encryptProjectSecret(project, 'synthetic-admin|key'),
            authIssuer,
          })
        ).appId;
      const suffix = crypto.randomUUID().slice(0, 8);
      const movedId = await running('legacy-ok', `sbx-${suffix}-ok`, `${apiOrigin}/v1/backends/${crypto.randomUUID()}`);
      const stuckId = await running('legacy-down', `sbx-${suffix}-down`, null);
      const currentId = await running('current-ok', `sbx-${suffix}-current-ok`, projectIssuer(project));

      const first = { ...EMPTY_BACKEND_SWEEP };
      await issuerStep(first);
      expect(first).toMatchObject({ movedIssuers: 1, errors: 1 });

      const want = authEnv(projectIssuer(project), movedId, await projectSigner(project));
      expect(envWrites).toEqual([
        {
          path: '/api/update_environment_variables',
          auth: 'Convex synthetic-admin|key',
          edgeToken: 'synthetic-edge-token',
          body: { changes: Object.entries(want).map(([name, value]) => ({ name, value })) },
        },
      ]);
      expect((await getLiveConvexApp(project, movedId))!.authIssuer).toBe(projectIssuer(project));
      expect((await getLiveConvexApp(project, stuckId))!.authIssuer).toBeNull();
      expect((await getLiveConvexApp(project, currentId))!.authIssuer).toBe(projectIssuer(project));
      // The operation lock is released either way.
      expect((await getLiveConvexApp(project, stuckId))!.metadata).not.toHaveProperty('operation');

      // A second pass writes nothing for the moved App and retries the failed one.
      envWrites.length = 0;
      const second = { ...EMPTY_BACKEND_SWEEP };
      await issuerStep(second);
      expect(second).toMatchObject({ movedIssuers: 0, errors: 1 });
      expect(envWrites).toEqual([]);
    } finally {
      config.PLATINUM_API_KEY = saved.key;
      config.PLATINUM_API_URL = saved.url;
      ok.stop(true);
      down.stop(true);
      platinum.stop(true);
    }
  });
});
