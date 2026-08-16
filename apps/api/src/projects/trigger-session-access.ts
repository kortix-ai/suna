import type { TriggerSessionAccess } from '@kortix/api-contract';
import {
  accountGroups,
  accountMembers,
  projectSessionGrants,
  projectSessions,
  projectTriggerRuntime,
  projectTriggerSessionAccessGrants,
} from '@kortix/db';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { resolveAgentRunAttribution } from './session-lifecycle/actor';
import {
  PRIVATE_TRIGGER_SESSION_ACCESS,
  triggerSessionAccessToVisibility,
} from './trigger-session-access-policy';

export {
  PRIVATE_TRIGGER_SESSION_ACCESS,
  parseTriggerSessionAccess,
  triggerSessionAccessToVisibility,
} from './trigger-session-access-policy';

function publicMode(mode: string): TriggerSessionAccess['mode'] {
  if (mode === 'project') return 'project';
  if (mode === 'restricted') return 'members';
  return 'private';
}

function grantsFor(access: TriggerSessionAccess) {
  return [
    ...access.memberIds.map((principalId) => ({
      principalType: 'member' as const,
      principalId,
    })),
    ...access.groupIds.map((principalId) => ({
      principalType: 'group' as const,
      principalId,
    })),
  ];
}

export async function validateTriggerSessionAccessPrincipals(
  accountId: string,
  access: TriggerSessionAccess,
): Promise<string | null> {
  if (access.mode !== 'members') return null;
  const [members, groups] = await Promise.all([
    access.memberIds.length
      ? db
          .select({ id: accountMembers.userId })
          .from(accountMembers)
          .where(
            and(
              eq(accountMembers.accountId, accountId),
              inArray(accountMembers.userId, access.memberIds),
            ),
          )
      : [],
    access.groupIds.length
      ? db
          .select({ id: accountGroups.groupId })
          .from(accountGroups)
          .where(
            and(
              eq(accountGroups.accountId, accountId),
              inArray(accountGroups.groupId, access.groupIds),
            ),
          )
      : [],
  ]);
  const foundMembers = new Set(members.map((row) => row.id));
  const foundGroups = new Set(groups.map((row) => row.id));
  const unknownMember = access.memberIds.find((id) => !foundMembers.has(id));
  if (unknownMember)
    return `Session access member ${unknownMember} does not belong to this account`;
  const unknownGroup = access.groupIds.find((id) => !foundGroups.has(id));
  if (unknownGroup) return `Session access group ${unknownGroup} does not belong to this account`;
  return null;
}

export async function loadTriggerSessionAccess(
  projectId: string,
  slug: string,
): Promise<TriggerSessionAccess> {
  const [runtime] = await db
    .select({ sessionAccessMode: projectTriggerRuntime.sessionAccessMode })
    .from(projectTriggerRuntime)
    .where(
      and(eq(projectTriggerRuntime.projectId, projectId), eq(projectTriggerRuntime.slug, slug)),
    )
    .limit(1);
  if (!runtime) return PRIVATE_TRIGGER_SESSION_ACCESS;
  const grants = await db
    .select({
      principalType: projectTriggerSessionAccessGrants.principalType,
      principalId: projectTriggerSessionAccessGrants.principalId,
    })
    .from(projectTriggerSessionAccessGrants)
    .where(
      and(
        eq(projectTriggerSessionAccessGrants.projectId, projectId),
        eq(projectTriggerSessionAccessGrants.slug, slug),
      ),
    );
  const mode = publicMode(runtime.sessionAccessMode);
  if (mode !== 'members') return { mode, memberIds: [], groupIds: [] };
  return {
    mode,
    memberIds: grants
      .filter((grant) => grant.principalType === 'member')
      .map((grant) => grant.principalId),
    groupIds: grants
      .filter((grant) => grant.principalType === 'group')
      .map((grant) => grant.principalId),
  };
}

export async function loadTriggerSessionAccessMap(
  projectId: string,
): Promise<Map<string, TriggerSessionAccess>> {
  const [runtimeRows, grantRows] = await Promise.all([
    db
      .select({
        slug: projectTriggerRuntime.slug,
        mode: projectTriggerRuntime.sessionAccessMode,
      })
      .from(projectTriggerRuntime)
      .where(eq(projectTriggerRuntime.projectId, projectId)),
    db
      .select({
        slug: projectTriggerSessionAccessGrants.slug,
        principalType: projectTriggerSessionAccessGrants.principalType,
        principalId: projectTriggerSessionAccessGrants.principalId,
      })
      .from(projectTriggerSessionAccessGrants)
      .where(eq(projectTriggerSessionAccessGrants.projectId, projectId)),
  ]);
  const grantsBySlug = new Map<string, typeof grantRows>();
  for (const grant of grantRows) {
    const list = grantsBySlug.get(grant.slug) ?? [];
    list.push(grant);
    grantsBySlug.set(grant.slug, list);
  }
  return new Map(
    runtimeRows.map((runtime) => {
      const mode = publicMode(runtime.mode);
      const grants = grantsBySlug.get(runtime.slug) ?? [];
      return [
        runtime.slug,
        mode === 'members'
          ? {
              mode,
              memberIds: grants
                .filter((grant) => grant.principalType === 'member')
                .map((grant) => grant.principalId),
              groupIds: grants
                .filter((grant) => grant.principalType === 'group')
                .map((grant) => grant.principalId),
            }
          : { mode, memberIds: [], groupIds: [] },
      ];
    }),
  );
}

/** Save a policy and propagate it to every non-pinned session this trigger created. */
export async function setTriggerSessionAccess(input: {
  projectId: string;
  accountId: string;
  slug: string;
  access: TriggerSessionAccess;
  /** The active pinned target keeps its own session-level sharing policy. */
  pinnedSessionId?: string | null;
}): Promise<void> {
  const validationError = await validateTriggerSessionAccessPrincipals(
    input.accountId,
    input.access,
  );
  if (validationError) throw new Error(validationError);

  const existingSessions = await db
    .select({
      sessionId: projectSessions.sessionId,
      agentName: projectSessions.agentName,
    })
    .from(projectSessions)
    .where(
      and(
        eq(projectSessions.projectId, input.projectId),
        sql`${projectSessions.metadata} ->> 'trigger_kind' = 'git'`,
        sql`${projectSessions.metadata} ->> 'trigger_slug' = ${input.slug}`,
        input.pinnedSessionId ? ne(projectSessions.sessionId, input.pinnedSessionId) : undefined,
      ),
    );
  const attributionByAgent = new Map<string, string>();
  const agentNames = new Set(
    existingSessions
      .map((row) => row.agentName)
      .filter((agentName): agentName is string => Boolean(agentName)),
  );
  for (const agentName of agentNames) {
    const serviceAccountId = await resolveAgentRunAttribution({
      accountId: input.accountId,
      projectId: input.projectId,
      agentName,
    });
    if (serviceAccountId) attributionByAgent.set(agentName, serviceAccountId);
  }
  const triggerGrants = grantsFor(input.access);
  await db.transaction(async (tx) => {
    // Updating the runtime row serializes policy edits with create-time
    // application. The action below locks this same row before it reads the
    // grants. A concurrent session therefore receives either the complete old
    // policy or the complete new policy, never a stale mix after propagation.
    await tx
      .update(projectTriggerRuntime)
      .set({
        sessionAccessMode: triggerSessionAccessToVisibility(input.access),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(projectTriggerRuntime.projectId, input.projectId),
          eq(projectTriggerRuntime.slug, input.slug),
        ),
      );
    await tx
      .delete(projectTriggerSessionAccessGrants)
      .where(
        and(
          eq(projectTriggerSessionAccessGrants.projectId, input.projectId),
          eq(projectTriggerSessionAccessGrants.slug, input.slug),
        ),
      );
    if (triggerGrants.length) {
      await tx.insert(projectTriggerSessionAccessGrants).values(
        triggerGrants.map((grant) => ({
          ...grant,
          projectId: input.projectId,
          slug: input.slug,
        })),
      );
    }
    const sessions = await tx
      .select({
        sessionId: projectSessions.sessionId,
        agentName: projectSessions.agentName,
      })
      .from(projectSessions)
      .where(
        and(
          eq(projectSessions.projectId, input.projectId),
          sql`${projectSessions.metadata} ->> 'trigger_kind' = 'git'`,
          sql`${projectSessions.metadata} ->> 'trigger_slug' = ${input.slug}`,
          input.pinnedSessionId ? ne(projectSessions.sessionId, input.pinnedSessionId) : undefined,
        ),
      );
    const sessionIds = sessions.map((session) => session.sessionId);
    if (sessionIds.length) {
      await tx
        .update(projectSessions)
        .set({
          visibility: triggerSessionAccessToVisibility(input.access),
          updatedAt: new Date(),
        })
        .where(inArray(projectSessions.sessionId, sessionIds));
      for (const session of sessions) {
        const serviceAccountId = session.agentName
          ? attributionByAgent.get(session.agentName)
          : undefined;
        if (serviceAccountId) {
          await tx
            .update(projectSessions)
            .set({ createdBy: serviceAccountId })
            .where(eq(projectSessions.sessionId, session.sessionId));
        }
      }
      await tx
        .delete(projectSessionGrants)
        .where(inArray(projectSessionGrants.sessionId, sessionIds));
      if (triggerGrants.length) {
        await tx.insert(projectSessionGrants).values(
          sessions.flatMap((session) =>
            triggerGrants.map((grant) => ({
              sessionId: session.sessionId,
              ...grant,
            })),
          ),
        );
      }
    }
  });
}

/** Resolve the current policy at execution time and apply it to one new session. */
export async function applyTriggerSessionAccess(input: {
  projectId: string;
  sessionId: string;
  triggerSlug: string;
}): Promise<void> {
  const [row] = await db
    .select({
      accountId: projectSessions.accountId,
      agentName: projectSessions.agentName,
    })
    .from(projectSessions)
    .where(
      and(
        eq(projectSessions.projectId, input.projectId),
        eq(projectSessions.sessionId, input.sessionId),
      ),
    )
    .limit(1);
  if (!row?.agentName) throw new Error('Trigger-created session has no agent identity');
  const serviceAccountId = await resolveAgentRunAttribution({
    accountId: row.accountId,
    projectId: input.projectId,
    agentName: row.agentName,
  });
  if (!serviceAccountId) throw new Error('Trigger agent service account is unavailable');
  await db.transaction(async (tx) => {
    const [runtime] = await tx
      .select({ sessionAccessMode: projectTriggerRuntime.sessionAccessMode })
      .from(projectTriggerRuntime)
      .where(
        and(
          eq(projectTriggerRuntime.projectId, input.projectId),
          eq(projectTriggerRuntime.slug, input.triggerSlug),
        ),
      )
      .for('update')
      .limit(1);
    const mode = publicMode(runtime?.sessionAccessMode ?? 'private');
    const triggerGrantRows = runtime
      ? await tx
          .select({
            principalType: projectTriggerSessionAccessGrants.principalType,
            principalId: projectTriggerSessionAccessGrants.principalId,
          })
          .from(projectTriggerSessionAccessGrants)
          .where(
            and(
              eq(projectTriggerSessionAccessGrants.projectId, input.projectId),
              eq(projectTriggerSessionAccessGrants.slug, input.triggerSlug),
            ),
          )
      : [];
    const access: TriggerSessionAccess =
      mode === 'members'
        ? {
            mode,
            memberIds: triggerGrantRows
              .filter((grant) => grant.principalType === 'member')
              .map((grant) => grant.principalId),
            groupIds: triggerGrantRows
              .filter((grant) => grant.principalType === 'group')
              .map((grant) => grant.principalId),
          }
        : { mode, memberIds: [], groupIds: [] };
    const grants = grantsFor(access);
    await tx
      .update(projectSessions)
      .set({
        createdBy: serviceAccountId,
        visibility: triggerSessionAccessToVisibility(access),
        updatedAt: new Date(),
      })
      .where(eq(projectSessions.sessionId, input.sessionId));
    await tx
      .delete(projectSessionGrants)
      .where(eq(projectSessionGrants.sessionId, input.sessionId));
    if (grants.length) {
      await tx
        .insert(projectSessionGrants)
        .values(grants.map((grant) => ({ sessionId: input.sessionId, ...grant })));
    }
  });
}
