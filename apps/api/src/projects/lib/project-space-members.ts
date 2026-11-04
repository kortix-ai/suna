/**
 * Channel membership, public channels : who is in a channel, for the
 * header roster and the Members tab. `kortix.project_space_members` holds the
 * rows. `#general` holds none: every project member is in it, implicitly, and
 * nobody adds or leaves. A row whose user lost project access is ignored on
 * read. A public channel is open to every project member, who can join it. A
 * private channel (`space-access.ts`) is open only to the people in this
 * table: every write here busts the access memo. Routes:
 * `routes/project-spaces.ts`.
 */
import type { SpaceMember, SpaceMemberList } from '@kortix/api-contract';
import { projectSpaceMembers, projectSpaces } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { db } from '../../shared/db';
import { resolveUserIdentities } from './access';
import { loadProjectRosterIds } from './project-access-view';
import type { SpaceViewer } from './project-spaces';
import { bustSpaceAccess, canSeeSpace } from '../../shared/space-access';

type SpaceRow = typeof projectSpaces.$inferSelect;
type ChannelFacts = Pick<SpaceRow, 'isDefault' | 'createdBy'>;
type ProjectRef = { accountId: string; projectId: string };

export type MembersError = { status: 400 | 403; body: { error: string; code: string; user_ids?: string[] } };

/** A member of the channel, its creator or a project manager adds people. Nobody in `#general`. */
export function canAddSpaceMembers(space: ChannelFacts, viewer: Pick<SpaceViewer, 'userId' | 'manager'>, viewerIsMember: boolean): boolean {
  if (space.isDefault) return false;
  return viewerIsMember || viewer.manager || space.createdBy === viewer.userId;
}

/**
 * A manager removes anyone. The creator removes anyone but themself. A member
 * removes only themself (Leave). So only a manager takes the creator out.
 * Nobody leaves `#general`.
 */
export function canRemoveSpaceMember(space: ChannelFacts, viewer: Pick<SpaceViewer, 'userId' | 'manager'>, target: string): boolean {
  if (space.isDefault) return false;
  if (viewer.manager) return true;
  if (target === space.createdBy) return false;
  return space.createdBy === viewer.userId || target === viewer.userId;
}

/** The display name, else the email's local part. Never the whole email. */
export function memberDisplayName(identity: { displayName: string | null; email: string | null }): string {
  const name = identity.displayName?.trim();
  if (name && !name.includes('@')) return name;
  return (identity.email ?? name ?? '').split('@')[0]!.trim();
}

/** The project's people with access who are real auth users, in a Set. */
async function projectPeople(project: ProjectRef): Promise<Set<string>> {
  return new Set((await loadProjectRosterIds({ row: project })).ids);
}

async function memberRows(spaceId: string) {
  return db
    .select({ userId: projectSpaceMembers.userId, addedAt: projectSpaceMembers.addedAt })
    .from(projectSpaceMembers)
    .where(eq(projectSpaceMembers.spaceId, spaceId));
}

/** The ids of the project's channels the user was added to or joined. `#general` is not among them: callers treat it as always joined. */
export async function joinedChannelIds(projectId: string, userId: string): Promise<Set<string>> {
  const rows = await db
    .select({ spaceId: projectSpaceMembers.spaceId })
    .from(projectSpaceMembers)
    .innerJoin(projectSpaces, eq(projectSpaces.spaceId, projectSpaceMembers.spaceId))
    .where(and(eq(projectSpaces.projectId, projectId), eq(projectSpaceMembers.userId, userId)));
  return new Set(rows.map((row) => row.spaceId));
}

/** The caller is in this space: `#general` and a DM always, another channel by its row. */
export async function isSpaceMember(space: SpaceRow, userId: string): Promise<boolean> {
  if (space.kind === 'dm' || space.isDefault) return true;
  const [row] = await db
    .select({ userId: projectSpaceMembers.userId })
    .from(projectSpaceMembers)
    .where(and(eq(projectSpaceMembers.spaceId, space.spaceId), eq(projectSpaceMembers.userId, userId)))
    .limit(1);
  return Boolean(row);
}

/** The channel's people (the caller first, then by name), whether it is `#general`'s implicit list, and whether the caller may add. */
export async function listSpaceMembers(space: SpaceRow, project: ProjectRef, viewer: SpaceViewer): Promise<SpaceMemberList> {
  const people = await projectPeople(project);
  const rows = space.isDefault ? [...people].map((userId) => ({ userId, addedAt: null as Date | null })) : await memberRows(space.spaceId);
  const listed = rows.filter((row) => people.has(row.userId));
  const identities = await resolveUserIdentities(listed.map((row) => row.userId));
  const members: SpaceMember[] = listed
    // A shadow directory row (no auth user) is nobody to show.
    .filter((row) => identities.get(row.userId)?.exists !== false)
    .map((row) => {
      const identity = identities.get(row.userId);
      return {
        user_id: row.userId,
        name: memberDisplayName({ displayName: identity?.displayName ?? null, email: identity?.email ?? null }),
        avatar_url: identity?.avatarUrl ?? null,
        is_creator: row.userId === space.createdBy,
        is_viewer: row.userId === viewer.userId,
        added_at: row.addedAt?.toISOString() ?? null,
        can_remove: canRemoveSpaceMember(space, viewer, row.userId),
      };
    })
    .sort((a, b) => Number(b.is_viewer) - Number(a.is_viewer) || a.name.localeCompare(b.name));
  const viewerIsMember = space.isDefault || listed.some((row) => row.userId === viewer.userId);
  // A manager outside a private channel adds other people (so a channel its
  // last member left is never stuck), never themself: that would read it.
  const canAdd = canSeeSpace(space, viewer.access) ? canAddSpaceMembers(space, viewer, viewerIsMember) : viewer.manager;
  return { members, implicit: space.isDefault, can_add: canAdd };
}

function notProjectMembers(ids: string[]): { error: MembersError } {
  return {
    error: {
      status: 400,
      body: { error: 'Only members of the project can be added to a channel.', code: 'not_project_member', user_ids: ids },
    },
  };
}

/** Rows for `userIds`; one already in the channel stays as it was. The caller checked the ids. */
export async function insertSpaceMembers(spaceId: string, userIds: readonly string[], addedBy: string): Promise<void> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return;
  await db
    .insert(projectSpaceMembers)
    .values(unique.map((userId) => ({ spaceId, userId, addedBy })))
    .onConflictDoNothing();
}

/** The ids of `userIds` that are not people of the project; empty when all are. */
export async function nonProjectMembers(project: ProjectRef, userIds: readonly string[]): Promise<string[]> {
  if (userIds.length === 0) return [];
  const people = await projectPeople(project);
  return [...new Set(userIds)].filter((id) => !people.has(id));
}

/** Add people in one request. 400 `default_channel` in `#general`, 403 `forbidden` for a caller who may not add, 400 `not_project_member` naming every outsider (then nobody is added). */
export async function addSpaceMembers(
  space: SpaceRow,
  project: ProjectRef,
  viewer: SpaceViewer,
  userIds: readonly string[],
): Promise<{ error: MembersError } | { list: SpaceMemberList }> {
  if (space.isDefault) return defaultChannel();
  if (!canSeeSpace(space, viewer.access) && userIds.includes(viewer.userId)) {
    return {
      error: {
        status: 403,
        body: {
          error: 'A project manager outside a private channel can add other people, not themself. Ask a member to add you.',
          code: 'manager_self_add',
        },
      },
    };
  }
  if (!canAddSpaceMembers(space, viewer, await isSpaceMember(space, viewer.userId))) {
    return {
      error: {
        status: 403,
        body: { error: 'Join the channel to add people to it.', code: 'forbidden' },
      },
    };
  }
  const outsiders = await nonProjectMembers(project, userIds);
  if (outsiders.length > 0) return notProjectMembers(outsiders);
  await insertSpaceMembers(space.spaceId, userIds, viewer.userId);
  bustSpaceAccess(project.projectId);
  return { list: await listSpaceMembers(space, project, viewer) };
}

function defaultChannel(): { error: MembersError } {
  return {
    error: {
      status: 400,
      body: { error: 'Every project member is in #general. Nobody is added to it or leaves it.', code: 'default_channel' },
    },
  };
}

/** Remove one person; the caller themself is Leave. Removing someone not in the channel is a no-op. */
export async function removeSpaceMember(
  space: SpaceRow,
  project: ProjectRef,
  viewer: SpaceViewer,
  userId: string,
): Promise<{ error: MembersError } | { list: SpaceMemberList }> {
  if (space.isDefault) return defaultChannel();
  if (!canRemoveSpaceMember(space, viewer, userId)) {
    const creator = userId === space.createdBy;
    return {
      error: {
        status: 403,
        body: creator
          ? { error: 'Only a project manager can remove the channel’s creator.', code: 'creator_not_removable' }
          : { error: 'Only the channel’s creator or a project manager can remove other people.', code: 'forbidden' },
      },
    };
  }
  await db
    .delete(projectSpaceMembers)
    .where(and(eq(projectSpaceMembers.spaceId, space.spaceId), eq(projectSpaceMembers.userId, userId)));
  bustSpaceAccess(project.projectId);
  return { list: await listSpaceMembers(space, project, viewer) };
}

/** The caller joins a public channel (the route answers 404 for a private one they are not in). Idempotent. `#general` answers 400 `default_channel`. */
export async function joinSpace(
  space: SpaceRow,
  project: ProjectRef,
  viewer: SpaceViewer,
): Promise<{ error: MembersError } | { list: SpaceMemberList }> {
  if (space.isDefault) return defaultChannel();
  await insertSpaceMembers(space.spaceId, [viewer.userId], viewer.userId);
  bustSpaceAccess(project.projectId);
  return { list: await listSpaceMembers(space, project, viewer) };
}
