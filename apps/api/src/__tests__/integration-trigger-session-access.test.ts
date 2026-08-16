import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  accounts,
  accountGroups,
  accountMembers,
  projectSessionGrants,
  projectSessions,
  projectTriggerRuntime,
  projectTriggerSessionAccessGrants,
  projects,
} from '@kortix/db';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../shared/db';
import {
  applyTriggerSessionAccess,
  setTriggerSessionAccess,
} from '../projects/trigger-session-access';

const context = {
  projectId: crypto.randomUUID(),
  accountId: crypto.randomUUID(),
  memberId: crypto.randomUUID(),
  groupId: crypto.randomUUID(),
};
const slug = `e2e-access-${crypto.randomUUID().slice(0, 8)}`;
const agentName = `access-agent-${crypto.randomUUID().slice(0, 8)}`;
const createdSessionIds = [
  `e2e-trigger-access-${crypto.randomUUID()}`,
  `e2e-trigger-access-${crypto.randomUUID()}`,
];
const pinnedSessionId = `e2e-trigger-access-pinned-${crypto.randomUUID()}`;
const freshSessionId = `e2e-trigger-access-fresh-${crypto.randomUUID()}`;
const humanStandIn = crypto.randomUUID();

beforeAll(async () => {
  await db.insert(accounts).values({
    accountId: context.accountId,
    name: 'Trigger access test',
  });
  await db.insert(accountMembers).values({
    accountId: context.accountId,
    userId: context.memberId,
    accountRole: 'owner',
  });
  await db.insert(projects).values({
    projectId: context.projectId,
    accountId: context.accountId,
    name: 'Trigger access test',
    repoUrl: `https://example.test/${context.projectId}.git`,
  });
  await db.insert(accountGroups).values({
    groupId: context.groupId,
    accountId: context.accountId,
    name: `Trigger access ${context.groupId.slice(0, 8)}`,
  });
  await db.insert(projectTriggerRuntime).values({
    projectId: context.projectId,
    slug,
    updatedAt: new Date(),
  });
  await db.insert(projectSessions).values([
    ...createdSessionIds.map((sessionId) => ({
      sessionId,
      accountId: context.accountId,
      projectId: context.projectId,
      branchName: sessionId,
      agentName,
      status: 'provisioning' as const,
      createdBy: humanStandIn,
      visibility: 'project' as const,
      metadata: { trigger_kind: 'git', trigger_slug: slug },
      updatedAt: new Date(),
    })),
    {
      sessionId: pinnedSessionId,
      accountId: context.accountId,
      projectId: context.projectId,
      branchName: pinnedSessionId,
      agentName,
      status: 'provisioning',
      createdBy: context.memberId,
      visibility: 'project',
      metadata: {},
      updatedAt: new Date(),
    },
  ]);
});

afterAll(async () => {
  await db.delete(accounts).where(eq(accounts.accountId, context.accountId));
});

describe('trigger session access — migrated database', () => {
  test('persists, propagates, applies at create time, excludes pins, and cascades grants', async () => {
    await setTriggerSessionAccess({
      projectId: context.projectId,
      accountId: context.accountId,
      slug,
      access: {
        mode: 'members',
        memberIds: [context.memberId],
        groupIds: [context.groupId],
      },
    });

    const [runtime] = await db
      .select({ mode: projectTriggerRuntime.sessionAccessMode })
      .from(projectTriggerRuntime)
      .where(
        and(
          eq(projectTriggerRuntime.projectId, context.projectId),
          eq(projectTriggerRuntime.slug, slug),
        ),
      );
    expect(runtime?.mode).toBe('restricted');
    const triggerGrants = await db
      .select()
      .from(projectTriggerSessionAccessGrants)
      .where(
        and(
          eq(projectTriggerSessionAccessGrants.projectId, context.projectId),
          eq(projectTriggerSessionAccessGrants.slug, slug),
        ),
      );
    expect(triggerGrants).toHaveLength(2);

    const propagated = await db
      .select({
        sessionId: projectSessions.sessionId,
        visibility: projectSessions.visibility,
      })
      .from(projectSessions)
      .where(inArray(projectSessions.sessionId, [...createdSessionIds, pinnedSessionId]));
    expect(
      propagated
        .filter((row) => createdSessionIds.includes(row.sessionId))
        .map((row) => row.visibility),
    ).toEqual(['restricted', 'restricted']);
    expect(propagated.find((row) => row.sessionId === pinnedSessionId)?.visibility).toBe('project');
    const propagatedGrants = await db
      .select()
      .from(projectSessionGrants)
      .where(inArray(projectSessionGrants.sessionId, [...createdSessionIds, pinnedSessionId]));
    expect(propagatedGrants).toHaveLength(4);
    expect(propagatedGrants.some((grant) => grant.sessionId === pinnedSessionId)).toBe(false);

    await db.insert(projectSessions).values({
      sessionId: freshSessionId,
      accountId: context.accountId,
      projectId: context.projectId,
      branchName: freshSessionId,
      agentName,
      status: 'provisioning',
      createdBy: humanStandIn,
      visibility: 'private',
      metadata: { trigger_kind: 'git', trigger_slug: slug },
      updatedAt: new Date(),
    });
    await applyTriggerSessionAccess({
      projectId: context.projectId,
      sessionId: freshSessionId,
      triggerSlug: slug,
    });
    const [fresh] = await db
      .select({
        createdBy: projectSessions.createdBy,
        visibility: projectSessions.visibility,
      })
      .from(projectSessions)
      .where(eq(projectSessions.sessionId, freshSessionId));
    expect(fresh?.visibility).toBe('restricted');
    expect(fresh?.createdBy).not.toBe(humanStandIn);
    expect(
      await db
        .select()
        .from(projectSessionGrants)
        .where(eq(projectSessionGrants.sessionId, freshSessionId)),
    ).toHaveLength(2);

    await db
      .delete(projectTriggerRuntime)
      .where(
        and(
          eq(projectTriggerRuntime.projectId, context.projectId),
          eq(projectTriggerRuntime.slug, slug),
        ),
      );
    expect(
      await db
        .select()
        .from(projectTriggerSessionAccessGrants)
        .where(
          and(
            eq(projectTriggerSessionAccessGrants.projectId, context.projectId),
            eq(projectTriggerSessionAccessGrants.slug, slug),
          ),
        ),
    ).toHaveLength(0);
  });
});
