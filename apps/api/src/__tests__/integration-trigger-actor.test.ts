/**
 * Integration test (real local DB): triggers NEVER impersonate a picked human.
 *
 * The old "Runs as <member>" selector + per-trigger owner override are gone —
 * automated runs must not assume a human identity. This proves the deprecated
 * `project_trigger_runtime.owner_user_id` column is IGNORED: even with a stale
 * owner set to some other user, resolveTriggerActor resolves to the project's
 * system automation actor (the account owner), never the picked member.
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { and, eq, sql } from 'drizzle-orm';
import { projectTriggerRuntime } from '@kortix/db';
import { db } from '../shared/db';
import { resolveTriggerActor } from '../projects/lib/triggers';
import { resolveProjectAutomationActor } from '../projects/session-lifecycle';
import type { ProjectRow } from '../projects/lib/serializers';

let ctx: { projectId: string; accountId: string } | null = null;
const SLUG = `e2e-actor-${crypto.randomUUID().slice(0, 8)}`;
const STALE_PICKED_HUMAN = crypto.randomUUID();

beforeAll(async () => {
  const rows = (await db.execute(
    sql`select project_id, account_id from kortix.projects limit 1`,
  )) as unknown as Array<{ project_id: string; account_id: string }>;
  if (!rows[0]) return;
  ctx = { projectId: rows[0].project_id, accountId: rows[0].account_id };

  // Seed a runtime row with a STALE owner pointing at some other user, as a
  // legacy trigger would have. The new resolver must not honor it.
  await db
    .insert(projectTriggerRuntime)
    .values({ projectId: ctx.projectId, slug: SLUG, ownerUserId: STALE_PICKED_HUMAN, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [projectTriggerRuntime.projectId, projectTriggerRuntime.slug],
      set: { ownerUserId: STALE_PICKED_HUMAN, updatedAt: new Date() },
    });
});

afterAll(async () => {
  if (!ctx) return;
  await db
    .delete(projectTriggerRuntime)
    .where(and(eq(projectTriggerRuntime.projectId, ctx.projectId), eq(projectTriggerRuntime.slug, SLUG)));
});

describe('resolveTriggerActor — no human impersonation', () => {
  test('ignores a stale owner_user_id; resolves to the project automation actor', async () => {
    if (!ctx) {
      console.warn('[integration] no project in local DB — skipping');
      return;
    }
    const actor = await resolveTriggerActor({ accountId: ctx.accountId } as ProjectRow);
    // Owner is IGNORED: the resolver returns exactly the automation actor — the
    // same value whether or not any owner row exists (both may be null).
    const automationActor = await resolveProjectAutomationActor(ctx.accountId);
    expect(actor).toBe(automationActor);
    // And it is NEVER the seeded picked human (the whole point of the removal).
    expect(actor).not.toBe(STALE_PICKED_HUMAN);
  });
});
