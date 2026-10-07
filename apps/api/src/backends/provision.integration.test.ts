import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accounts, projectBackends, projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { config } from '../config';
import { db } from '../shared/db';
import { inspectDatabaseError } from '../shared/database-errors';
import { encryptProjectSecret } from '../projects/surface';
import { generateBackendAuthKey, legacyBackendIssuer } from './auth';
import {
  BackendLimitError,
  MAX_BACKENDS_PER_ACCOUNT,
  MAX_BACKENDS_PER_PROJECT,
  backendMemberToken,
  getLiveBackend,
  insertBackend,
  moveBackendIssuers,
} from './provision';

// insertBackend counts and inserts under one per-account advisory lock, so
// concurrent creates cannot overshoot the project cap (3) or the account cap
// (10). Before the lock, every create of a burst passed the count together.
const ACCOUNT = crypto.randomUUID();
const OTHER_ACCOUNT = crypto.randomUUID();
const USER = crypto.randomUUID();
const PROJECTS = Array.from({ length: 5 }, () => crypto.randomUUID());
const OTHER_PROJECT = crypto.randomUUID();

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
  ]);
});

afterAll(async () => {
  for (const accountId of [ACCOUNT, OTHER_ACCOUNT]) {
    await db.delete(projectBackends).where(eq(projectBackends.accountId, accountId));
    await db.delete(projects).where(eq(projects.accountId, accountId));
    await db.delete(accounts).where(eq(accounts.accountId, accountId));
  }
});

const create = (projectId: string, accountId: string, name: string) =>
  insertBackend({ projectId, accountId, userId: USER, name });

async function liveCount(where: ReturnType<typeof eq>): Promise<number> {
  return (await db.select({ id: projectBackends.backendId }).from(projectBackends).where(where)).length;
}

describe('insertBackend caps', () => {
  test('10 concurrent creates in one project leave exactly 3 rows; the rest answer BackendLimitError', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => create(PROJECTS[0]!, ACCOUNT, `burst-${i}`)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(MAX_BACKENDS_PER_PROJECT);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(10 - MAX_BACKENDS_PER_PROJECT);
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(BackendLimitError);
      expect(String(r.reason.message)).toContain('a project can have at most 3 backends');
    }
    expect(await liveCount(eq(projectBackends.projectId, PROJECTS[0]!))).toBe(MAX_BACKENDS_PER_PROJECT);
  });

  test('concurrent creates across projects stop at the account cap of 10; another account is unaffected', async () => {
    // PROJECTS[0] already holds 3. Four more projects × 3 attempts = 12 attempts for 7 free slots.
    const attempts = PROJECTS.slice(1).flatMap((projectId, p) =>
      Array.from({ length: 3 }, (_, i) => create(projectId, ACCOUNT, `p${p}-${i}`)),
    );
    const results = await Promise.allSettled(attempts);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(MAX_BACKENDS_PER_ACCOUNT - MAX_BACKENDS_PER_PROJECT);
    expect(await liveCount(eq(projectBackends.accountId, ACCOUNT))).toBe(MAX_BACKENDS_PER_ACCOUNT);
    const accountRefusals = results.filter(
      (r) => r.status === 'rejected' && String(r.reason.message).includes('an account can have at most 10 backends'),
    );
    expect(accountRefusals.length).toBeGreaterThan(0);

    await create(OTHER_PROJECT, OTHER_ACCOUNT, 'main');
    expect(await liveCount(eq(projectBackends.accountId, OTHER_ACCOUNT))).toBe(1);
  });

  test('a duplicate live name still fails with the unique violation, not a limit error', async () => {
    await create(OTHER_PROJECT, OTHER_ACCOUNT, 'dup');
    const error = await create(OTHER_PROJECT, OTHER_ACCOUNT, 'dup').catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(BackendLimitError);
    expect(inspectDatabaseError(error)?.pgCode).toBe('23505');
  });
});

describe('sign-in issuer', () => {
  const apiOrigin = (config.KORTIX_URL ?? '').replace(/\/+$/, '').replace(/\/v1$/, '');
  const issuerOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()).iss;

  test('a new backend stores <public API origin>/v1/backends/<id> at creation', async () => {
    const row = await create(OTHER_PROJECT, OTHER_ACCOUNT, 'issuer');
    expect(apiOrigin).toMatch(/^https?:\/\//);
    expect(row.authIssuer).toBe(`${apiOrigin}/v1/backends/${row.backendId}`);
  });

  test('the move writes the new issuer into the backend env, then mints with it; a failed write keeps the old one', async () => {
    const envWrites: unknown[] = [];
    const ok = Bun.serve({
      port: 0,
      fetch: async (req) => {
        envWrites.push({ path: new URL(req.url).pathname, auth: req.headers.get('authorization'), body: await req.json() });
        return new Response(null, { status: 200 });
      },
    });
    const down = Bun.serve({ port: 0, fetch: () => new Response('boom', { status: 500 }) });
    try {
      const legacy = async (name: string, url: string) => {
        const backendId = crypto.randomUUID();
        await db.insert(projectBackends).values({
          backendId,
          projectId: PROJECTS[4]!,
          accountId: ACCOUNT,
          name,
          status: 'running',
          provider: 'platinum',
          url,
          adminKeyEnc: encryptProjectSecret(PROJECTS[4]!, 'synthetic-admin|key'),
          authKeyEnc: encryptProjectSecret(PROJECTS[4]!, generateBackendAuthKey()),
          cpu: 1,
          memoryGb: 1,
          diskGb: 10,
        });
        return backendId;
      };
      const movedId = await legacy('legacy-ok', `http://127.0.0.1:${ok.port}`);
      const stuckId = await legacy('legacy-down', `http://127.0.0.1:${down.port}`);
      const before = (await getLiveBackend(PROJECTS[4]!, movedId))!;
      expect(issuerOf(backendMemberToken(before, { userId: 'u', email: null })!.token)).toBe(legacyBackendIssuer(movedId));

      expect(await moveBackendIssuers()).toEqual({ moved: 1, failed: 1 });

      const issuer = `${apiOrigin}/v1/backends/${movedId}`;
      expect(envWrites).toEqual([
        {
          path: '/api/update_environment_variables',
          auth: 'Convex synthetic-admin|key',
          body: { changes: [{ name: 'KORTIX_AUTH_ISSUER', value: issuer }] },
        },
      ]);
      const after = (await getLiveBackend(PROJECTS[4]!, movedId))!;
      expect(after.authIssuer).toBe(issuer);
      expect(issuerOf(backendMemberToken(after, { userId: 'u', email: null })!.token)).toBe(issuer);
      const stuck = (await getLiveBackend(PROJECTS[4]!, stuckId))!;
      expect(stuck.authIssuer).toBeNull();
      expect(issuerOf(backendMemberToken(stuck, { userId: 'u', email: null })!.token)).toBe(legacyBackendIssuer(stuckId));

      // A second pass writes nothing for the moved backend.
      envWrites.length = 0;
      expect(await moveBackendIssuers()).toEqual({ moved: 0, failed: 1 });
      expect(envWrites).toEqual([]);
    } finally {
      ok.stop(true);
      down.stop(true);
    }
  });
});
