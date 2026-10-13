/**
 * Integration test (real HTTP route, real Postgres): `volumes` and
 * `stateless_sessions` are ordinary project flags. A project manager toggles
 * them with `PATCH /v1/projects/:id/features`; the values live in the
 * project's own metadata; `stateless_sessions` needs `volumes` on, and
 * turning `volumes` off clears it. Another project of the same organization
 * is untouched.
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
const SIBLING = crypto.randomUUID();
const OWNER = crypto.randomUUID();

const minted: string[] = [];
let ownerSecret = '';

async function experimental(projectId: string): Promise<Record<string, unknown> | undefined> {
  const [row] = await db.select({ metadata: projects.metadata }).from(projects).where(eq(projects.projectId, projectId));
  return (row?.metadata as { experimental?: Record<string, unknown> } | null)?.experimental;
}

beforeAll(async () => {
  await db.execute(sql`alter table kortix.account_tokens add column if not exists agent_grant jsonb`);
  await db.execute(sql`alter table kortix.account_tokens add column if not exists session_id text`);
  await db.execute(sql`alter table kortix.account_tokens add column if not exists service_account_id uuid`);

  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'volumes-flag-test' });
  for (const [projectId, name] of [[PROJECT, 'volumes-flag-test-project'], [SIBLING, 'volumes-flag-sibling']] as const) {
    await db.insert(projects).values({ projectId, accountId: ACCOUNT, name, repoUrl: 'https://example.com/volumes-flag.git' });
  }
  await insertIntoView(db, accountMembers, [{ userId: OWNER, accountId: ACCOUNT, accountRole: 'owner', isSuperAdmin: false }]);
  await insertIntoView(db, projectMembers, [
    { accountId: ACCOUNT, projectId: PROJECT, userId: OWNER, projectRole: 'manager' },
    { accountId: ACCOUNT, projectId: SIBLING, userId: OWNER, projectRole: 'manager' },
  ]);
  const owner = await createAccountToken({ accountId: ACCOUNT, userId: OWNER, name: 'volumes-flag-owner' });
  minted.push(owner.tokenId);
  ownerSecret = owner.secretKey;
});

afterAll(async () => {
  for (const tokenId of minted) await db.execute(sql`delete from kortix.account_tokens where token_id = ${tokenId}`);
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

function setFlag(feature: 'volumes' | 'stateless_sessions', enabled: boolean | null) {
  return app.request(`/v1/projects/${PROJECT}/features`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${ownerSecret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ feature, enabled }),
  });
}

const view = (body: { experimental_features: Array<{ key: string }> }, key: string) =>
  body.experimental_features.find((f) => f.key === key);

describe('Volumes and Stateless sessions are project flags', () => {
  test('a project manager turns them on and off; Stateless sessions needs Volumes; the sibling project is untouched', async () => {
    const refused = await setFlag('stateless_sessions', true);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: 'Turn on Volumes first' });

    const volumes = await setFlag('volumes', true);
    expect(volumes.status).toBe(200);
    const vBody = await volumes.json();
    expect(vBody.experimental).toMatchObject({ volumes: true, stateless_sessions: false, drives: true, ephemeral_sandboxes: true });
    expect(view(vBody, 'volumes')).toMatchObject({ enabled: true, overridden: true, operator_only: false });
    expect(view(vBody, 'volumes')).not.toHaveProperty('scope');

    const stateless = await setFlag('stateless_sessions', true);
    expect(stateless.status).toBe(200);
    expect((await stateless.json()).experimental).toMatchObject({ volumes: true, stateless_sessions: true });
    expect(await experimental(PROJECT)).toEqual({ volumes: true, stateless_sessions: true });
    expect(await experimental(SIBLING)).toBeUndefined();

    // Volumes off clears Stateless sessions, so Volumes on again does not bring it back.
    const off = await setFlag('volumes', false);
    expect(off.status).toBe(200);
    expect((await off.json()).experimental).toMatchObject({ volumes: false, stateless_sessions: false, drives: false });
    expect(await experimental(PROJECT)).toEqual({ volumes: false });
    const again = await setFlag('volumes', true);
    expect((await again.json()).experimental).toMatchObject({ volumes: true, stateless_sessions: false });
  });
});
