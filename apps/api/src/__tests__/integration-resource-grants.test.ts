/**
 * Integration test (real local DB): per-resource scoping round-trips through
 * iam_resource_grants and the engine gates correctly off it. Proves the full
 * stack below the HTTP layer — upsert → memo load → isProjectResourceAccessible
 * → cache invalidation on mutate.
 *
 * Runs against the local Postgres (DATABASE_URL). Ensures the table exists in
 * beforeAll (the local DB may be behind on migrations).
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { sql } from 'drizzle-orm';
import { db } from '../shared/db';
import {
  upsertResourceGrant,
  deleteResourceGrant,
  isProjectResourceAccessible,
  filterAccessibleResourceIds,
} from '../iam/resource-grants';

let ctx: { projectId: string; accountId: string } | null = null;
const cleanup: string[] = [];
const GRANTED_USER = crypto.randomUUID();
const OTHER_USER = crypto.randomUUID();
const GROUP = crypto.randomUUID();

beforeAll(async () => {
  await db.execute(sql`create table if not exists kortix.iam_resource_grants (
    grant_id uuid primary key default gen_random_uuid(),
    account_id uuid not null,
    project_id uuid not null,
    resource_type varchar(32) not null,
    resource_id text not null,
    principal_type varchar(16) not null,
    principal_id uuid not null,
    effect varchar(8) not null default 'allow',
    expires_at timestamptz,
    granted_by uuid,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`);
  await db.execute(
    sql`create unique index if not exists uq_iam_resource_grants on kortix.iam_resource_grants (project_id, resource_type, resource_id, principal_type, principal_id)`,
  );
  const rows = (await db.execute(
    sql`select project_id, account_id from kortix.projects limit 1`,
  )) as unknown as Array<{ project_id: string; account_id: string }>;
  if (rows[0]) ctx = { projectId: rows[0].project_id, accountId: rows[0].account_id };
});

afterAll(async () => {
  for (const id of cleanup) {
    await db.execute(sql`delete from kortix.iam_resource_grants where grant_id = ${id}`);
  }
});

describe('iam_resource_grants — real DB round-trip + engine fold', () => {
  test('member grant: only the granted user can access; unscoped agent stays open', async () => {
    if (!ctx) { console.warn('[integration] no project in local DB — skipping'); return; }
    const { grantId } = await upsertResourceGrant({
      accountId: ctx.accountId,
      projectId: ctx.projectId,
      resourceType: 'agent',
      resourceId: 'release-bot',
      principalType: 'member',
      principalId: GRANTED_USER,
      grantedBy: GRANTED_USER,
    });
    cleanup.push(grantId);

    // Scoped agent: granted member yes, everyone else no.
    expect(await isProjectResourceAccessible(ctx.projectId, 'agent', 'release-bot', GRANTED_USER, [])).toBe(true);
    expect(await isProjectResourceAccessible(ctx.projectId, 'agent', 'release-bot', OTHER_USER, [])).toBe(false);
    // A DIFFERENT agent has no grants → unscoped → open to anyone.
    expect(await isProjectResourceAccessible(ctx.projectId, 'agent', 'some-other-agent', OTHER_USER, [])).toBe(true);
  });

  test('group grant: any member of the granted group can access', async () => {
    if (!ctx) return;
    const { grantId } = await upsertResourceGrant({
      accountId: ctx.accountId,
      projectId: ctx.projectId,
      resourceType: 'skill',
      resourceId: 'lead-research',
      principalType: 'group',
      principalId: GROUP,
      grantedBy: GRANTED_USER,
    });
    cleanup.push(grantId);

    expect(await isProjectResourceAccessible(ctx.projectId, 'skill', 'lead-research', OTHER_USER, [GROUP])).toBe(true);
    expect(await isProjectResourceAccessible(ctx.projectId, 'skill', 'lead-research', OTHER_USER, [])).toBe(false);
  });

  test('secret grant: scoping a secret restricts it; unscoped secrets stay open', async () => {
    if (!ctx) return;
    const { grantId } = await upsertResourceGrant({
      accountId: ctx.accountId,
      projectId: ctx.projectId,
      resourceType: 'secret',
      resourceId: 'STRIPE_KEY', // grant resource_id = the secret NAME
      principalType: 'member',
      principalId: GRANTED_USER,
      grantedBy: GRANTED_USER,
    });
    cleanup.push(grantId);

    // The scoped secret: only the granted member sees it.
    expect(await isProjectResourceAccessible(ctx.projectId, 'secret', 'STRIPE_KEY', GRANTED_USER, [])).toBe(true);
    expect(await isProjectResourceAccessible(ctx.projectId, 'secret', 'STRIPE_KEY', OTHER_USER, [])).toBe(false);
    // A DIFFERENT, ungranted secret stays unscoped → open to everyone.
    expect(await isProjectResourceAccessible(ctx.projectId, 'secret', 'OPENAI_KEY', OTHER_USER, [])).toBe(true);
  });

  test('filterAccessibleResourceIds hides ungranted resources, keeps unscoped ones', async () => {
    if (!ctx) return;
    // 'release-bot' is member-scoped to GRANTED_USER; 'free-agent' is unscoped.
    const ids = ['release-bot', 'free-agent'];
    expect(await filterAccessibleResourceIds(ctx.projectId, 'agent', ids, GRANTED_USER, [])).toEqual(['release-bot', 'free-agent']);
    expect(await filterAccessibleResourceIds(ctx.projectId, 'agent', ids, OTHER_USER, [])).toEqual(['free-agent']);
  });

  test('delete reverts the resource to unscoped (open) and busts the cache', async () => {
    if (!ctx) return;
    const { grantId } = await upsertResourceGrant({
      accountId: ctx.accountId,
      projectId: ctx.projectId,
      resourceType: 'agent',
      resourceId: 'temp-bot',
      principalType: 'member',
      principalId: GRANTED_USER,
      grantedBy: GRANTED_USER,
    });
    expect(await isProjectResourceAccessible(ctx.projectId, 'agent', 'temp-bot', OTHER_USER, [])).toBe(false);
    const removed = await deleteResourceGrant(grantId, ctx.projectId);
    expect(removed).toBe(true);
    // Cache busted on delete → now unscoped → open again.
    expect(await isProjectResourceAccessible(ctx.projectId, 'agent', 'temp-bot', OTHER_USER, [])).toBe(true);
  });
});
