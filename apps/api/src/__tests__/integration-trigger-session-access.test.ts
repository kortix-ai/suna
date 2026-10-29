import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  accountGroups,
  accountMembers,
  accounts,
  projectSessionGrants,
  projectSessions,
  projectSpaces,
  projectTriggerRuntime,
  projectTriggerSessionAccessGrants,
  projects,
} from '@kortix/db';
import { and, eq, inArray } from 'drizzle-orm';
import {
  applyTriggerSessionAccess,
  setTriggerSessionAccess,
} from '../projects/trigger-session-access';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';

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
  await insertIntoView(db, accountMembers, {
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
      // A session created by this trigger can later become its pinned target.
      // Matching trigger metadata must not make policy propagation overwrite it.
      metadata: { trigger_kind: 'git', trigger_slug: slug },
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
      pinnedSessionId,
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

    await Promise.all([
      setTriggerSessionAccess({
        projectId: context.projectId,
        accountId: context.accountId,
        slug,
        access: { mode: 'project', memberIds: [], groupIds: [] },
        pinnedSessionId,
      }),
      applyTriggerSessionAccess({
        projectId: context.projectId,
        sessionId: freshSessionId,
        triggerSlug: slug,
      }),
    ]);
    const [concurrentFinal] = await db
      .select({ visibility: projectSessions.visibility })
      .from(projectSessions)
      .where(eq(projectSessions.sessionId, freshSessionId));
    expect(concurrentFinal?.visibility).toBe('project');
    expect(
      await db
        .select()
        .from(projectSessionGrants)
        .where(eq(projectSessionGrants.sessionId, freshSessionId)),
    ).toHaveLength(0);

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

  test('a run filed in a DM gets DM-only sharing whatever the trigger stores; a space change re-shares nothing', async () => {
    const dmSlug = `e2e-dm-${crypto.randomUUID().slice(0, 8)}`;
    const [dm] = await db
      .insert(projectSpaces)
      .values({
        accountId: context.accountId,
        projectId: context.projectId,
        kind: 'dm',
        name: agentName,
        dmUserId: context.memberId,
        dmAgentName: agentName,
      })
      .returning();
    const [channel] = await db
      .insert(projectSpaces)
      .values({ accountId: context.accountId, projectId: context.projectId, kind: 'channel', slug: dmSlug, name: dmSlug })
      .returning();
    // A flag-off write left `project` on a trigger that posts to the DM.
    await db.insert(projectTriggerRuntime).values({
      projectId: context.projectId,
      slug: dmSlug,
      spaceId: dm!.spaceId,
      sessionAccessMode: 'project',
      updatedAt: new Date(),
    });
    const run = (sessionId: string, spaceId: string, visibility: 'private' | 'project') => ({
      sessionId,
      accountId: context.accountId,
      projectId: context.projectId,
      branchName: sessionId,
      agentName,
      status: 'provisioning' as const,
      createdBy: humanStandIn,
      visibility,
      spaceId,
      metadata: { trigger_kind: 'git', trigger_slug: dmSlug },
      updatedAt: new Date(),
    });
    const dmRun = `e2e-trigger-dm-${crypto.randomUUID()}`;
    const channelRun = `e2e-trigger-channel-${crypto.randomUUID()}`;
    await db.insert(projectSessions).values([run(dmRun, dm!.spaceId, 'private'), run(channelRun, channel!.spaceId, 'project')]);

    await applyTriggerSessionAccess({ projectId: context.projectId, sessionId: dmRun, triggerSlug: dmSlug });
    const visibilityOf = async (sessionId: string) =>
      (await db.select({ v: projectSessions.visibility }).from(projectSessions).where(eq(projectSessions.sessionId, sessionId)))[0]?.v;
    const grantsOf = async (sessionId: string) =>
      (await db.select().from(projectSessionGrants).where(eq(projectSessionGrants.sessionId, sessionId))).map((g) => g.principalId);
    expect(await visibilityOf(dmRun)).toBe('restricted');
    expect(await grantsOf(dmRun)).toEqual([context.memberId]);

    // A move (propagate: false) narrows nothing: the old channel thread stays project-visible.
    await setTriggerSessionAccess({
      projectId: context.projectId,
      accountId: context.accountId,
      slug: dmSlug,
      access: { mode: 'members', memberIds: [context.memberId], groupIds: [] },
      propagate: false,
    });
    expect(await visibilityOf(channelRun)).toBe('project');
    expect(await grantsOf(channelRun)).toEqual([]);

    // An explicit `project` save re-shares earlier runs, but never a DM thread.
    await setTriggerSessionAccess({
      projectId: context.projectId,
      accountId: context.accountId,
      slug: dmSlug,
      access: { mode: 'project', memberIds: [], groupIds: [] },
    });
    expect(await visibilityOf(dmRun)).toBe('restricted');
    expect(await grantsOf(dmRun)).toEqual([context.memberId]);
  });
});
