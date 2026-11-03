/**
 * Integration test (real HTTP route, real Postgres): every project has a
 * Drive where the platform stores one. `volumes` and `drives` are no flags
 * since 2026-11-02: the project detail sends both as `true` (Platinum is
 * configured here), the catalog has no row for either, a write of either key
 * is an unknown flag, and a stored `false` from before is inert. The
 * Stateless sessions flag is gone the same way.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

if (!process.env.PLATINUM_API_KEY || process.env.PLATINUM_API_KEY.startsWith('encrypted:')) {
  process.env.PLATINUM_API_KEY = 'pt_test_key';
}

const { eq, sql } = await import('drizzle-orm');
const { accountMembers, accounts, projectMembers, projects } = await import('@kortix/db');
const { db } = await import('../shared/db');
const { app } = await import('../index');
const { createAccountToken } = await import('../repositories/account-tokens');
const { insertIntoView } = await import('./helpers/compat-views');

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const OWNER = crypto.randomUUID();

const minted: string[] = [];
let ownerSecret = '';

async function storedFlags(): Promise<Record<string, unknown> | undefined> {
  const [row] = await db.select({ metadata: projects.metadata }).from(projects).where(eq(projects.projectId, PROJECT));
  return (row?.metadata as { experimental?: Record<string, unknown> } | null)?.experimental;
}

beforeAll(async () => {
  await db.execute(sql`alter table kortix.account_tokens add column if not exists agent_grant jsonb`);
  await db.execute(sql`alter table kortix.account_tokens add column if not exists session_id text`);
  await db.execute(sql`alter table kortix.account_tokens add column if not exists service_account_id uuid`);

  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'volumes-flag-test' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'volumes-flag-test-project',
    repoUrl: 'https://example.com/volumes-flag.git',
  });
  await insertIntoView(db, accountMembers, [{ userId: OWNER, accountId: ACCOUNT, accountRole: 'owner', isSuperAdmin: false }]);
  await insertIntoView(db, projectMembers, [{ accountId: ACCOUNT, projectId: PROJECT, userId: OWNER, projectRole: 'manager' }]);
  const owner = await createAccountToken({ accountId: ACCOUNT, userId: OWNER, name: 'volumes-flag-owner' });
  minted.push(owner.tokenId);
  ownerSecret = owner.secretKey;
});

afterAll(async () => {
  for (const tokenId of minted) await db.execute(sql`delete from kortix.account_tokens where token_id = ${tokenId}`);
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

async function setFlag(feature: string, enabled: boolean | null) {
  const res = await app.request(`/v1/projects/${PROJECT}/features`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${ownerSecret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ feature, enabled }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

const row = (body: any, key: string) => body.experimental_features.find((f: { key: string }) => f.key === key);

describe('Every project has a Drive', () => {
  test('the detail sends volumes and drives as true; the catalog lists neither; a write is an unknown flag', async () => {
    const fresh = await app.request(`/v1/projects/${PROJECT}`, { headers: { Authorization: `Bearer ${ownerSecret}` } });
    expect(fresh.status).toBe(200);
    const freshBody = (await fresh.json()) as any;
    expect(freshBody.experimental).toMatchObject({ volumes: true, drives: true });
    expect(row(freshBody, 'volumes')).toBeUndefined();
    expect(row(freshBody, 'drives')).toBeUndefined();

    for (const feature of ['volumes', 'drives']) {
      const write = await setFlag(feature, false);
      expect(write.status).toBe(400);
      expect(write.body.error).toBe(`Unknown feature flag '${feature}'`);
    }
    expect(await storedFlags()).toBeUndefined();
  });

  test('a stored false from before the graduation is inert', async () => {
    await db.execute(sql`
      update kortix.projects
         set metadata = coalesce(metadata, '{}'::jsonb) || '{"experimental":{"volumes":false,"drives":false}}'::jsonb
       where project_id = ${PROJECT}`);
    const res = await app.request(`/v1/projects/${PROJECT}`, { headers: { Authorization: `Bearer ${ownerSecret}` } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).experimental).toMatchObject({ volumes: true, drives: true });
  });

  test('Stateless sessions is gone: the key is unknown, and a stored choice is inert', async () => {
    const write = await setFlag('stateless_sessions', true);
    expect(write.status).toBe(400);
    expect(write.body.error).toBe("Unknown feature flag 'stateless_sessions'");

    await db.execute(sql`
      update kortix.projects
         set metadata = coalesce(metadata, '{}'::jsonb) || '{"experimental":{"stateless_sessions":true,"ephemeral_sandboxes":true}}'::jsonb
       where project_id = ${PROJECT}`);
    const res = await app.request(`/v1/projects/${PROJECT}`, { headers: { Authorization: `Bearer ${ownerSecret}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.experimental).not.toHaveProperty('stateless_sessions');
    expect(body.experimental).not.toHaveProperty('ephemeral_sandboxes');
    expect(row(body, 'stateless_sessions')).toBeUndefined();
  });
});
