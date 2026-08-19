/**
 * Integration test (real local DB): an OBJECT grant round-trips through
 * `kortix.role_assignments` and the engine's object rule gates off it.
 *
 * Proves the whole stack below the HTTP layer — `upsertResourceGrant` ->
 * `loadObjectGrants` memo -> `objectUsable` -> cache bust on mutate — over the
 * canonical store. Before the cutover this exercised `iam_resource_grants` and
 * a second copy of the fold that lived in `iam/resource-grants.ts`; both are
 * gone, and `kortix.iam_resource_grants` is a compatibility view over the rows
 * this test writes.
 *
 * Runs against the local Postgres (DATABASE_URL) and seeds its own account,
 * project, users and group, because `assignRole` validates that a principal
 * exists — a random uuid is a 404 now, not a silent row.
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { deleteResourceGrant, upsertResourceGrant } from '../iam/resource-grants';
import { loadObjectGrants, objectUsable } from '../iam/authorize';
import { invalidateIamCacheForProjectResources } from '../iam/cache-invalidation';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const GRANTED_USER = crypto.randomUUID();
const OTHER_USER = crypto.randomUUID();
const GROUP = crypto.randomUUID();

/** THE object rule, asked the way `authorize` asks it. */
async function usable(
  objectType: string,
  objectId: string,
  userId: string,
  groupIds: string[],
  managerTier = false,
): Promise<boolean> {
  const grants = await loadObjectGrants(PROJECT, objectType);
  return objectUsable(objectType, grants.get(objectId), userId, groupIds, managerTier);
}

beforeAll(async () => {
  await db.execute(sql`
    insert into auth.users (id, email) values
      (${GRANTED_USER}::uuid, ${`granted-${GRANTED_USER}@example.com`}),
      (${OTHER_USER}::uuid, ${`other-${OTHER_USER}@example.com`})
    on conflict do nothing`);
  await db.execute(sql`insert into kortix.accounts (account_id, name) values (${ACCOUNT}::uuid, 'object-grant-test')`);
  await db.execute(sql`
    insert into kortix.projects (project_id, account_id, name, repo_url)
    values (${PROJECT}::uuid, ${ACCOUNT}::uuid, 'p', 'https://example.com/p.git')`);
  await db.execute(sql`
    insert into kortix.account_groups (group_id, account_id, name)
    values (${GROUP}::uuid, ${ACCOUNT}::uuid, 'marketing')`);
  await db.execute(sql`
    insert into kortix.account_members (user_id, account_id, account_role) values
      (${GRANTED_USER}::uuid, ${ACCOUNT}::uuid, 'member'),
      (${OTHER_USER}::uuid, ${ACCOUNT}::uuid, 'member')`);
  invalidateIamCacheForProjectResources(PROJECT);
});

afterAll(async () => {
  // accounts cascades to projects, groups, memberships and — as of the cutover —
  // to role_assignments, so one delete is the whole cleanup.
  await db.execute(sql`delete from kortix.accounts where account_id = ${ACCOUNT}::uuid`);
  await db.execute(sql`delete from auth.users where id in (${GRANTED_USER}::uuid, ${OTHER_USER}::uuid)`);
});

describe('object grants — real DB round-trip + the engine object rule', () => {
  test('member grant: only the granted user reaches the scoped agent', async () => {
    const { grantId } = await upsertResourceGrant({
      accountId: ACCOUNT,
      projectId: PROJECT,
      resourceType: 'agent',
      resourceId: 'release-bot',
      principalType: 'member',
      principalId: GRANTED_USER,
      grantedBy: GRANTED_USER,
    });
    expect(grantId).toMatch(/^[0-9a-f-]{36}$/);

    expect(await usable('agent', 'release-bot', GRANTED_USER, [])).toBe(true);
    expect(await usable('agent', 'release-bot', OTHER_USER, [])).toBe(false);
    // A manager is NOT exempt from an explicit grant — that is what makes
    // "scope this agent to one group" mean anything.
    expect(await usable('agent', 'release-bot', OTHER_USER, [], true)).toBe(false);
  });

  test('agents are deny-by-default for a member and open for a manager', async () => {
    // 'free-agent' has no grant row at all: object_policies says agent = closed.
    expect(await usable('agent', 'free-agent', OTHER_USER, [])).toBe(false);
    expect(await usable('agent', 'free-agent', GRANTED_USER, [])).toBe(false);
    expect(await usable('agent', 'free-agent', OTHER_USER, [], true)).toBe(true);
  });

  test('group grant: any member of the granted group reaches the skill', async () => {
    const { grantId } = await upsertResourceGrant({
      accountId: ACCOUNT,
      projectId: PROJECT,
      resourceType: 'skill',
      resourceId: 'lead-research',
      principalType: 'group',
      principalId: GROUP,
      grantedBy: GRANTED_USER,
    });
    expect(grantId).toBeTruthy();

    expect(await usable('skill', 'lead-research', OTHER_USER, [GROUP])).toBe(true);
    expect(await usable('skill', 'lead-research', OTHER_USER, [])).toBe(false);
  });

  test('skills keep the unscoped-is-open rule — only agents flipped', async () => {
    expect(await usable('skill', 'unscoped-skill', OTHER_USER, [])).toBe(true);
  });

  test('secret grant: scoping a secret restricts it; unscoped secrets stay open', async () => {
    await upsertResourceGrant({
      accountId: ACCOUNT,
      projectId: PROJECT,
      resourceType: 'secret',
      resourceId: 'STRIPE_KEY', // grant resource_id = the secret NAME
      principalType: 'member',
      principalId: GRANTED_USER,
      grantedBy: GRANTED_USER,
    });
    expect(await usable('secret', 'STRIPE_KEY', GRANTED_USER, [])).toBe(true);
    expect(await usable('secret', 'STRIPE_KEY', OTHER_USER, [])).toBe(false);
    expect(await usable('secret', 'OPENAI_KEY', OTHER_USER, [])).toBe(true);
  });

  test('re-granting the same object is idempotent, not a duplicate', async () => {
    const a = await upsertResourceGrant({
      accountId: ACCOUNT, projectId: PROJECT, resourceType: 'agent', resourceId: 'release-bot',
      principalType: 'member', principalId: GRANTED_USER, grantedBy: GRANTED_USER,
    });
    const b = await upsertResourceGrant({
      accountId: ACCOUNT, projectId: PROJECT, resourceType: 'agent', resourceId: 'release-bot',
      principalType: 'member', principalId: GRANTED_USER, grantedBy: GRANTED_USER,
    });
    expect(b.grantId).toBe(a.grantId);
  });

  test('delete reverts the object to unscoped and busts the cache', async () => {
    const { grantId } = await upsertResourceGrant({
      accountId: ACCOUNT,
      projectId: PROJECT,
      resourceType: 'agent',
      resourceId: 'temp-bot',
      principalType: 'member',
      principalId: GRANTED_USER,
      grantedBy: GRANTED_USER,
    });
    expect(await usable('agent', 'temp-bot', GRANTED_USER, [])).toBe(true);

    expect(await deleteResourceGrant(grantId, PROJECT, ACCOUNT)).toBe(true);
    // Cache busted on delete → no grant rows → the agent default applies again.
    expect(await usable('agent', 'temp-bot', GRANTED_USER, [])).toBe(false);
    expect(await usable('agent', 'temp-bot', GRANTED_USER, [], true)).toBe(true);
    // An id that names nothing is a false, not a throw.
    expect(await deleteResourceGrant(grantId, PROJECT, ACCOUNT)).toBe(false);
  });

  test('the compatibility view renders the same grants under the legacy shape', async () => {
    const rows = (await db.execute(sql`
      select resource_type, resource_id, principal_type, effect
        from kortix.iam_resource_grants
       where project_id = ${PROJECT}::uuid
       order by resource_type, resource_id`)) as unknown as Array<Record<string, string>>;
    const list = (rows as unknown as { rows?: Array<Record<string, string>> }).rows ?? rows;
    expect(list.map((r) => `${r.resource_type}:${r.resource_id}:${r.principal_type}`)).toEqual([
      'agent:release-bot:member',
      'secret:STRIPE_KEY:member',
      'skill:lead-research:group',
    ]);
    // `effect` is a rendered constant now — 'deny' was reserved and never written.
    expect(new Set(list.map((r) => r.effect))).toEqual(new Set(['allow']));
  });
});
