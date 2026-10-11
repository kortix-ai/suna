/**
 * Integration test (real HTTP route, real Postgres): the `volumes` feature flag
 * IS the organization's Volumes switch. A platform operator's
 * `PATCH /v1/projects/:id/features` writes the organization's entry in the
 * `session_boot_modes` policy row (the one Admin → Volumes edits), and the
 * derived `drives` / `ephemeral_sandboxes` flags follow it. Anyone else gets
 * 403 `feature_operator_only` and nothing changes.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

if (!process.env.PLATINUM_API_KEY || process.env.PLATINUM_API_KEY.startsWith('encrypted:')) {
  process.env.PLATINUM_API_KEY = 'pt_test_key';
}

const { eq, sql } = await import('drizzle-orm');
const { accountMembers, accounts, platformUserRoles, projectMembers, projects } = await import('@kortix/db');
const { db } = await import('../shared/db');
const { app } = await import('../index');
const { createAccountToken } = await import('../repositories/account-tokens');
const { insertIntoView } = await import('./helpers/compat-views');
const { BOOT_MODE_SETTING_KEY, bootModePolicy, refreshBootModePolicy } = await import('../platform/services/boot-mode-setting');
const { resolveVolumes } = await import('../platform/services/boot-mode');
const { resolveFeatureFlag } = await import('../feature-flags/registry');

const ACCOUNT = crypto.randomUUID();
const OTHER = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const OWNER = crypto.randomUUID();
const OPERATOR = crypto.randomUUID();

const minted: string[] = [];
let ownerSecret = '';
let operatorSecret = '';
let original: unknown;

async function storedPolicy(): Promise<Record<string, any> | undefined> {
  const rows = (await db.execute(
    sql`select value from kortix.platform_settings where key = ${BOOT_MODE_SETTING_KEY}`,
  )) as unknown as Array<{ value: Record<string, any> }>;
  return rows[0]?.value;
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
  await insertIntoView(db, accountMembers, [
    { userId: OWNER, accountId: ACCOUNT, accountRole: 'owner', isSuperAdmin: false },
    { userId: OPERATOR, accountId: ACCOUNT, accountRole: 'member', isSuperAdmin: false },
  ]);
  await insertIntoView(db, projectMembers, [
    { accountId: ACCOUNT, projectId: PROJECT, userId: OWNER, projectRole: 'manager' },
    { accountId: ACCOUNT, projectId: PROJECT, userId: OPERATOR, projectRole: 'manager' },
  ]);
  const owner = await createAccountToken({ accountId: ACCOUNT, userId: OWNER, name: 'volumes-flag-owner' });
  minted.push(owner.tokenId);
  ownerSecret = owner.secretKey;
  await db.insert(platformUserRoles).values({ accountId: OPERATOR, role: 'admin' });
  const operator = await createAccountToken({ accountId: ACCOUNT, userId: OPERATOR, name: 'volumes-flag-operator' });
  minted.push(operator.tokenId);
  operatorSecret = operator.secretKey;

  original = await storedPolicy();
  const seeded = { killSwitch: true, volumes: { enabled: false, percent: 0, orgs: { [OTHER]: true } } };
  await db.execute(sql`
    insert into kortix.platform_settings (key, value, updated_at)
    values (${BOOT_MODE_SETTING_KEY}, ${JSON.stringify(seeded)}::jsonb, now())
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
  await db.delete(platformUserRoles).where(eq(platformUserRoles.accountId, OPERATOR));
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

function setVolumes(enabled: boolean | null, bearer: string) {
  return app.request(`/v1/projects/${PROJECT}/features`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify({ feature: 'volumes', enabled }),
  });
}

describe('volumes feature flag ↔ organization Volumes switch', () => {
  test('an organization owner who is not a platform operator gets 403 and nothing changes', async () => {
    const before = await storedPolicy();
    for (const enabled of [true, false, null]) {
      const res = await setVolumes(enabled, ownerSecret);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'feature_operator_only', feature: 'volumes' });
    }
    expect(await storedPolicy()).toEqual(before);
    expect(resolveFeatureFlag({}, 'drives', ACCOUNT)).toBe(false);
  });

  test('a platform operator toggles it: resolveVolumes flips for that organization and the derived flags follow', async () => {
    const on = await setVolumes(true, operatorSecret);
    expect(on.status).toBe(200);
    const body = await on.json();
    expect(body.experimental).toMatchObject({ volumes: true, drives: true, ephemeral_sandboxes: true });
    expect(body.experimental_features.find((f: { key: string }) => f.key === 'volumes')).toMatchObject({
      enabled: true,
      overridden: true,
      operator_only: true,
      scope: 'organization',
    });
    expect(resolveVolumes(bootModePolicy().policy, ACCOUNT)).toEqual({ enabled: true, source: 'org' });
    // The same row Admin → Volumes edits; nothing else in it moved, and the project's metadata is untouched.
    const stored = await storedPolicy();
    expect(stored?.volumes.orgs).toEqual({ [OTHER]: true, [ACCOUNT]: true });
    expect(stored?.killSwitch).toBe(true);
    const [row] = await db.select({ metadata: projects.metadata }).from(projects).where(eq(projects.projectId, PROJECT));
    expect((row?.metadata as { experimental?: unknown } | null)?.experimental).toBeUndefined();

    const off = await setVolumes(false, operatorSecret);
    expect(off.status).toBe(200);
    expect(resolveVolumes(bootModePolicy().policy, ACCOUNT).enabled).toBe(false);
    expect(resolveFeatureFlag({}, 'drives', ACCOUNT)).toBe(false);
    expect(resolveFeatureFlag({ experimental: { ephemeral_sandboxes: true } }, 'ephemeral_sandboxes', ACCOUNT)).toBe(false);
    // Another organization is untouched.
    expect(resolveFeatureFlag({}, 'drives', OTHER)).toBe(true);

    // Clearing removes the entry: back to the global switch (off).
    const cleared = await setVolumes(null, operatorSecret);
    expect(cleared.status).toBe(200);
    expect((await storedPolicy())?.volumes.orgs).toEqual({ [OTHER]: true });
    expect((await cleared.json()).experimental_features.find((f: { key: string }) => f.key === 'volumes')).toMatchObject({
      enabled: false,
      overridden: false,
    });
  });
});
