// The reads and writes the Files routes need beyond service.ts: folder grants
// that follow a move, the names a grant shows, who a folder can be shared
// with, and conflict notices. Routes call these; they hold no queries.

import { accountGroups, accountMembers, driveConflicts, projectSessions, roleAssignments, serviceAccounts } from '@kortix/db';
import { and, eq, inArray, isNotNull, like, or, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import type { DriveRow } from './service';

/** Grants on `from` or below it follow a moved folder. True when one moved. */
export async function moveFolderGrants(drive: DriveRow, from: string, to: string): Promise<boolean> {
  const rows = await db
    .update(roleAssignments)
    .set({
      objectId: sql`${to} || substr(${roleAssignments.objectId}, ${from.length + 1})`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(roleAssignments.scopeType, 'project'),
        eq(roleAssignments.scopeId, drive.projectId!),
        eq(roleAssignments.objectType, 'folder'),
        or(eq(roleAssignments.objectId, from), like(roleAssignments.objectId, `${from.replace(/[\\%_]/g, '\\$&')}/%`)),
      ),
    )
    .returning({ id: roleAssignments.assignmentId });
  return rows.length > 0;
}

/** Team names and agent names for the grants a folder shows. */
export async function principalNames(
  groupIds: string[],
  serviceAccountIds: string[],
): Promise<{ groups: Array<{ id: string; name: string }>; agents: Array<{ id: string; name: string | null }> }> {
  const [groups, agents] = await Promise.all([
    groupIds.length
      ? db.select({ id: accountGroups.groupId, name: accountGroups.name }).from(accountGroups).where(inArray(accountGroups.groupId, groupIds))
      : Promise.resolve([] as Array<{ id: string; name: string }>),
    serviceAccountIds.length
      ? db
          .select({ id: serviceAccounts.serviceAccountId, name: serviceAccounts.agentName })
          .from(serviceAccounts)
          .where(inArray(serviceAccounts.serviceAccountId, serviceAccountIds))
      : Promise.resolve([] as Array<{ id: string; name: string | null }>),
  ]);
  return { groups, agents };
}

/** The agent's service account in the project, when it has one. */
export async function projectAgentServiceAccount(projectId: string, agentName: string): Promise<string | null> {
  const [row] = await db
    .select({ id: serviceAccounts.serviceAccountId })
    .from(serviceAccounts)
    .where(and(eq(serviceAccounts.projectId, projectId), eq(serviceAccounts.agentName, agentName)))
    .limit(1);
  return row?.id ?? null;
}

export async function isAccountMember(accountId: string, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ userId: accountMembers.userId })
    .from(accountMembers)
    .where(and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, userId)))
    .limit(1);
  return !!row;
}

/** People, teams and agents a folder of this drive can be shared with. */
export async function shareablePrincipals(drive: DriveRow): Promise<{
  members: string[];
  teams: Array<{ id: string; name: string }>;
  agentNames: string[];
}> {
  const [members, teams, sessionAgents, serviceAgents] = await Promise.all([
    db.select({ userId: accountMembers.userId }).from(accountMembers).where(eq(accountMembers.accountId, drive.accountId)),
    db.select({ id: accountGroups.groupId, name: accountGroups.name }).from(accountGroups).where(eq(accountGroups.accountId, drive.accountId)),
    db.selectDistinct({ name: projectSessions.agentName }).from(projectSessions).where(eq(projectSessions.projectId, drive.projectId!)),
    db
      .select({ name: serviceAccounts.agentName })
      .from(serviceAccounts)
      .where(and(eq(serviceAccounts.projectId, drive.projectId!), isNotNull(serviceAccounts.agentName))),
  ]);
  return {
    members: members.map((m) => m.userId),
    teams,
    agentNames: [...sessionAgents.map((a) => a.name), ...serviceAgents.map((a) => a.name ?? '')].filter(Boolean),
  };
}

/** One conflict notice of the drive, or null. */
export async function driveConflict(driveId: string, conflictId: string): Promise<{ path: string } | null> {
  const [row] = await db
    .select({ path: driveConflicts.path })
    .from(driveConflicts)
    .where(and(eq(driveConflicts.driveId, driveId), eq(driveConflicts.conflictId, conflictId)))
    .limit(1);
  return row ?? null;
}

export async function dismissConflict(conflictId: string, userId: string): Promise<void> {
  await db.update(driveConflicts).set({ dismissedAt: new Date(), dismissedBy: userId }).where(eq(driveConflicts.conflictId, conflictId));
}
