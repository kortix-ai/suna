/**
 * Integration test (real HTTP route, real Postgres): `volumes` is an ordinary
 * per-project flag. A project admin who is not a platform operator turns it
 * on and off with `PATCH /v1/projects/:id/features`; the choice lives in the
 * project's metadata and the derived `drives` flag follows it. The Stateless
 * sessions flag is gone: its key is unknown, and a stored choice is inert.
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

describe('Volumes is a project flag', () => {
  test('a project admin (not a platform operator) turns it on and off; drives follows', async () => {
    // Unset, it follows the platform default: on (Platinum is configured above).
    const fresh = await app.request(`/v1/projects/${PROJECT}`, { headers: { Authorization: `Bearer ${ownerSecret}` } });
    expect(fresh.status).toBe(200);
    const freshBody = (await fresh.json()) as any;
    expect(freshBody.experimental).toMatchObject({ volumes: true, drives: true });
    expect(row(freshBody, 'volumes')).toMatchObject({ enabled: true, overridden: false, operator_only: false, scope: 'project' });

    const off = await setFlag('volumes', false);
    expect(off.status).toBe(200);
    expect(off.body.experimental).toMatchObject({ volumes: false, drives: false });

    const on = await setFlag('volumes', true);
    expect(on.status).toBe(200);
    expect(on.body.experimental).toMatchObject({ volumes: true, drives: true });
    expect(row(on.body, 'volumes')).toMatchObject({ enabled: true, overridden: true, operator_only: false, scope: 'project' });
    expect(await storedFlags()).toEqual({ volumes: true });

    expect((await setFlag('volumes', null)).status).toBe(200);
    expect(await storedFlags()).toBeUndefined();
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

  test('a derived flag is not a choice of its own', async () => {
    const res = await app.request(`/v1/projects/${PROJECT}/features`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${ownerSecret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ feature: 'drives', enabled: true }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("follows the project's Volumes flag");
  });
});
