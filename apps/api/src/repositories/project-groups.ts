// Data access for project groups + their project memberships.
// Pure CRUD — route handlers gate with assertAuthorized() before calling.

import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { projectGroupMembers, projectGroups, projects } from '@kortix/db';
import { db } from '../shared/db';

export type ProjectGroup = {
  groupId: string;
  accountId: string;
  name: string;
  description: string | null;
  projectCount: number;
  createdAt: Date;
  updatedAt: Date;
};

export async function listProjectGroups(accountId: string): Promise<ProjectGroup[]> {
  const rows = await db
    .select({
      groupId: projectGroups.groupId,
      accountId: projectGroups.accountId,
      name: projectGroups.name,
      description: projectGroups.description,
      createdAt: projectGroups.createdAt,
      updatedAt: projectGroups.updatedAt,
      projectCount: sql<number>`(
        SELECT COUNT(*)::int FROM kortix.project_group_members
        WHERE group_id = ${projectGroups.groupId}
      )`,
    })
    .from(projectGroups)
    .where(eq(projectGroups.accountId, accountId))
    .orderBy(asc(projectGroups.name));
  return rows;
}

export async function getProjectGroup(
  accountId: string,
  groupId: string,
): Promise<ProjectGroup | null> {
  const [row] = await db
    .select({
      groupId: projectGroups.groupId,
      accountId: projectGroups.accountId,
      name: projectGroups.name,
      description: projectGroups.description,
      createdAt: projectGroups.createdAt,
      updatedAt: projectGroups.updatedAt,
      projectCount: sql<number>`(
        SELECT COUNT(*)::int FROM kortix.project_group_members
        WHERE group_id = ${projectGroups.groupId}
      )`,
    })
    .from(projectGroups)
    .where(
      and(eq(projectGroups.accountId, accountId), eq(projectGroups.groupId, groupId)),
    )
    .limit(1);
  return row ?? null;
}

export async function createProjectGroup(args: {
  accountId: string;
  name: string;
  description?: string | null;
  createdBy: string;
}): Promise<ProjectGroup> {
  const [row] = await db
    .insert(projectGroups)
    .values({
      accountId: args.accountId,
      name: args.name,
      description: args.description ?? null,
      createdBy: args.createdBy,
    })
    .returning();
  return {
    ...row,
    projectCount: 0,
  };
}

export async function updateProjectGroup(
  accountId: string,
  groupId: string,
  patch: { name?: string; description?: string | null },
): Promise<ProjectGroup | null> {
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.name !== undefined) updates.name = patch.name;
  if (patch.description !== undefined) updates.description = patch.description;
  const [row] = await db
    .update(projectGroups)
    .set(updates)
    .where(
      and(eq(projectGroups.accountId, accountId), eq(projectGroups.groupId, groupId)),
    )
    .returning();
  if (!row) return null;
  const [{ projectCount }] = await db
    .select({
      projectCount: sql<number>`COUNT(*)::int`,
    })
    .from(projectGroupMembers)
    .where(eq(projectGroupMembers.groupId, groupId));
  return { ...row, projectCount };
}

export async function deleteProjectGroup(
  accountId: string,
  groupId: string,
): Promise<boolean> {
  const rows = await db
    .delete(projectGroups)
    .where(
      and(eq(projectGroups.accountId, accountId), eq(projectGroups.groupId, groupId)),
    )
    .returning({ groupId: projectGroups.groupId });
  return rows.length > 0;
}

// ─── Members ──────────────────────────────────────────────────────────────

export type ProjectGroupMemberRow = {
  projectId: string;
  projectName: string;
  addedAt: Date;
};

export async function listGroupProjects(
  accountId: string,
  groupId: string,
): Promise<ProjectGroupMemberRow[]> {
  // Verify group belongs to account
  const [g] = await db
    .select({ groupId: projectGroups.groupId })
    .from(projectGroups)
    .where(
      and(eq(projectGroups.accountId, accountId), eq(projectGroups.groupId, groupId)),
    )
    .limit(1);
  if (!g) return [];

  return db
    .select({
      projectId: projectGroupMembers.projectId,
      projectName: projects.name,
      addedAt: projectGroupMembers.addedAt,
    })
    .from(projectGroupMembers)
    .innerJoin(projects, eq(projects.projectId, projectGroupMembers.projectId))
    .where(eq(projectGroupMembers.groupId, groupId))
    .orderBy(asc(projects.name));
}

export async function addGroupProjects(args: {
  accountId: string;
  groupId: string;
  projectIds: string[];
  addedBy: string;
}): Promise<{ added: number }> {
  if (args.projectIds.length === 0) return { added: 0 };
  // Only allow projects that belong to this account — guard against
  // attaching a project from a different tenant via a tampered request.
  const validRows = await db
    .select({ projectId: projects.projectId })
    .from(projects)
    .where(
      and(
        eq(projects.accountId, args.accountId),
        inArray(projects.projectId, args.projectIds),
      ),
    );
  const valid = new Set(validRows.map((r) => r.projectId));
  const filtered = args.projectIds.filter((p) => valid.has(p));
  if (filtered.length === 0) return { added: 0 };

  const inserted = await db
    .insert(projectGroupMembers)
    .values(
      filtered.map((projectId) => ({
        groupId: args.groupId,
        projectId,
        addedBy: args.addedBy,
      })),
    )
    .onConflictDoNothing()
    .returning({ projectId: projectGroupMembers.projectId });
  return { added: inserted.length };
}

export async function removeGroupProject(
  groupId: string,
  projectId: string,
): Promise<boolean> {
  const rows = await db
    .delete(projectGroupMembers)
    .where(
      and(
        eq(projectGroupMembers.groupId, groupId),
        eq(projectGroupMembers.projectId, projectId),
      ),
    )
    .returning({ projectId: projectGroupMembers.projectId });
  return rows.length > 0;
}
