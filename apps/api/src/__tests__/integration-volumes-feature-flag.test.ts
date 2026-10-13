/**
 * Integration test (real HTTP route, real Postgres): `volumes` and
 * `stateless_sessions` are ordinary per-project flags. A project admin who is
 * not a platform operator turns them on and off with
 * `PATCH /v1/projects/:id/features`; the choice lives in the project's
 * metadata, the derived `drives` / `ephemeral_sandboxes` flags and the boot
 * mode follow it, and the `session_boot_modes` policy row is never written. A
 * per-organization entry left in that row (before 2026-10-13) decides nothing.
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
const { BOOT_MODE_SETTING_KEY, refreshBootModePolicy } = await import('../platform/services/boot-mode-setting');
const { resolveProjectBootMode } = await import('../platform/services/boot-mode-store');

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const OWNER = crypto.randomUUID();

const minted: string[] = [];
let ownerSecret = '';
let original: unknown;

async function storedPolicy(): Promise<Record<string, any> | undefined> {
  const rows = (await db.execute(
    sql`select value from kortix.platform_settings where key = ${BOOT_MODE_SETTING_KEY}`,
  )) as unknown as Array<{ value: Record<string, any> }>;
  return rows[0]?.value;
}

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

  // A row as #9592 left it: Volumes and Stateless on for this organization.
  original = await storedPolicy();
  const legacy = {
    killSwitch: false,
    volumes: { enabled: false, percent: 0, orgs: { [ACCOUNT]: true } },
    orgs: { [ACCOUNT]: { mode: 'volume', standardFallback: true } },
  };
  await db.execute(sql`
    insert into kortix.platform_settings (key, value, updated_at)
    values (${BOOT_MODE_SETTING_KEY}, ${JSON.stringify(legacy)}::jsonb, now())
    on conflict (key) do update set value = excluded.value, updated_at = now()
  `);
  await refreshBootModePolicy();
});

afterAll(async () => {
  if (original === undefined) {
    await db.execute(sql`delete from kortix.platform_settings where key = ${BOOT_MODE_SETTING_KEY}`);
  } else {
    await db.execute(sql`update kortix.platform_settings set value = ${JSON.stringify(original)}::jsonb where key = ${BOOT_MODE_SETTING_KEY}`);
  }
  for (const tokenId of minted) await db.execute(sql`delete from kortix.account_tokens where token_id = ${tokenId}`);
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

async function setFlag(feature: 'volumes' | 'stateless_sessions', enabled: boolean | null) {
  const res = await app.request(`/v1/projects/${PROJECT}/features`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${ownerSecret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ feature, enabled }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

const row = (body: any, key: string) => body.experimental_features.find((f: { key: string }) => f.key === key);

describe('Volumes and Stateless sessions are project flags', () => {
  test("an organization entry in the policy row turns nothing on for the organization's projects", async () => {
    const res = await app.request(`/v1/projects/${PROJECT}`, { headers: { Authorization: `Bearer ${ownerSecret}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.experimental).toMatchObject({ volumes: false, stateless_sessions: false, drives: false, ephemeral_sandboxes: false });
    for (const key of ['volumes', 'stateless_sessions']) {
      expect(row(body, key)).toMatchObject({ enabled: false, overridden: false, operator_only: false, scope: 'project' });
    }
    expect(await resolveProjectBootMode({ projectId: PROJECT, provider: 'platinum' })).toMatchObject({ mode: 'standard', source: 'volumes_off' });
  });

  test('a project admin (not a platform operator) turns them on and off; the policy row is never written', async () => {
    const before = await storedPolicy();

    // Stateless sessions need Volumes.
    const early = await setFlag('stateless_sessions', true);
    expect(early.status).toBe(400);
    expect(early.body.error).toBe('Turn on Volumes first');

    const on = await setFlag('volumes', true);
    expect(on.status).toBe(200);
    expect(on.body.experimental).toMatchObject({ volumes: true, drives: true, ephemeral_sandboxes: true });
    expect(row(on.body, 'volumes')).toMatchObject({ enabled: true, overridden: true, operator_only: false, scope: 'project' });
    expect(await storedFlags()).toEqual({ volumes: true });
    expect(await resolveProjectBootMode({ projectId: PROJECT, provider: 'platinum' })).toMatchObject({ mode: 'standard', source: 'default' });

    const stateless = await setFlag('stateless_sessions', true);
    expect(stateless.status).toBe(200);
    expect(row(stateless.body, 'stateless_sessions')).toMatchObject({ enabled: true, overridden: true });
    expect(await resolveProjectBootMode({ projectId: PROJECT, provider: 'platinum' })).toMatchObject({ mode: 'volume', source: 'project' });

    // Volumes off: everything built on it is off, the Stateless choice is kept but inert.
    const off = await setFlag('volumes', false);
    expect(off.status).toBe(200);
    expect(off.body.experimental).toMatchObject({ volumes: false, stateless_sessions: false, drives: false, ephemeral_sandboxes: false });
    expect(row(off.body, 'stateless_sessions')).toMatchObject({ enabled: false, overridden: true });
    expect(await resolveProjectBootMode({ projectId: PROJECT, provider: 'platinum' })).toMatchObject({ mode: 'standard', source: 'volumes_off' });

    // Clearing returns to the default (off).
    expect((await setFlag('volumes', null)).status).toBe(200);
    expect((await setFlag('stateless_sessions', null)).status).toBe(200);
    expect(await storedFlags()).toBeUndefined();

    expect(await storedPolicy()).toEqual(before);
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
