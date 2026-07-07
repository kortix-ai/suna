/**
 * Integration test (real local DB): trigger-fired sessions are ATTRIBUTED to
 * the firing agent's own standing-identity service account, not the arbitrary
 * account-owner stand-in `resolveTriggerActor` provisions with — closing the
 * `triggers.ts` TODO (docs/specs/2026-07-05-agent-first-config-unification.md
 * §2.2 "runtime attribution").
 *
 * `attributeFiredTriggerSession` is exercised directly (rather than the full
 * `fireGitTrigger`, which needs a real git-backed manifest + sandbox
 * provisioning) — it's the exact post-creation fixup `fireGitTrigger` runs
 * right after `createSession` returns a fresh session row.
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { and, eq, sql } from 'drizzle-orm';
import { projectSessions, serviceAccounts } from '@kortix/db';
import { db } from '../shared/db';
import { attributeFiredTriggerSession } from '../projects/lib/triggers';
import type { ProjectRow } from '../projects/lib/serializers';

let ctx: { projectId: string; accountId: string } | null = null;
const SESSION_ID = `e2e-trigger-attr-${crypto.randomUUID()}`;
const HUMAN_STAND_IN = crypto.randomUUID();
const AGENT_NAME = `trigger-attr-agent-${crypto.randomUUID().slice(0, 8)}`;

beforeAll(async () => {
  const rows = (await db.execute(
    sql`select project_id, account_id from kortix.projects limit 1`,
  )) as unknown as Array<{ project_id: string; account_id: string }>;
  if (!rows[0]) return;
  ctx = { projectId: rows[0].project_id, accountId: rows[0].account_id };

  // Seed a session as `createProjectSession` would leave it right after insert:
  // created_by = the human stand-in `resolveTriggerActor` resolves to today.
  await db.insert(projectSessions).values({
    sessionId: SESSION_ID,
    accountId: ctx.accountId,
    projectId: ctx.projectId,
    branchName: SESSION_ID,
    agentName: AGENT_NAME,
    status: 'provisioning',
    createdBy: HUMAN_STAND_IN,
    visibility: 'project',
    updatedAt: new Date(),
  });
});

afterAll(async () => {
  if (!ctx) return;
  await db.delete(projectSessions).where(eq(projectSessions.sessionId, SESSION_ID));
  await db
    .delete(serviceAccounts)
    .where(
      and(
        eq(serviceAccounts.accountId, ctx.accountId),
        eq(serviceAccounts.projectId, ctx.projectId),
        eq(serviceAccounts.agentName, AGENT_NAME),
      ),
    );
});

describe('attributeFiredTriggerSession — trigger runs attributed to the agent SA', () => {
  test('created_by moves off the human stand-in onto the firing agent\'s service account; billing (account_id) untouched', async () => {
    if (!ctx) {
      console.warn('[integration] no project in local DB — skipping');
      return;
    }
    await attributeFiredTriggerSession({
      project: { projectId: ctx.projectId, accountId: ctx.accountId } as ProjectRow,
      sessionId: SESSION_ID,
      agentName: AGENT_NAME,
    });

    const [session] = await db
      .select()
      .from(projectSessions)
      .where(eq(projectSessions.sessionId, SESSION_ID))
      .limit(1);
    expect(session).toBeTruthy();
    // Attribution changed...
    expect(session!.createdBy).not.toBe(HUMAN_STAND_IN);
    // ...but billing/account attribution (accountId is what compute metering +
    // checkBillingActive key off) is completely untouched by this fixup.
    expect(session!.accountId).toBe(ctx.accountId);

    const [sa] = await db
      .select()
      .from(serviceAccounts)
      .where(
        and(
          eq(serviceAccounts.accountId, ctx.accountId),
          eq(serviceAccounts.projectId, ctx.projectId),
          eq(serviceAccounts.agentName, AGENT_NAME),
        ),
      )
      .limit(1);
    expect(sa).toBeTruthy();
    expect(session!.createdBy).toBe(sa!.serviceAccountId);
  });

  test('idempotent: firing the fixup again keeps the same attributed identity', async () => {
    if (!ctx) return;
    const [before] = await db
      .select({ createdBy: projectSessions.createdBy })
      .from(projectSessions)
      .where(eq(projectSessions.sessionId, SESSION_ID))
      .limit(1);

    await attributeFiredTriggerSession({
      project: { projectId: ctx.projectId, accountId: ctx.accountId } as ProjectRow,
      sessionId: SESSION_ID,
      agentName: AGENT_NAME,
    });

    const [after] = await db
      .select({ createdBy: projectSessions.createdBy })
      .from(projectSessions)
      .where(eq(projectSessions.sessionId, SESSION_ID))
      .limit(1);
    expect(after!.createdBy).toBe(before!.createdBy);
  });
});
