import { accountScimUsers } from '@kortix/db';
import { and, eq, or } from 'drizzle-orm';
import { db } from '../shared/db';
import { buildInviteUser, type UserShape } from './app';

export type DirectoryUser = typeof accountScimUsers.$inferSelect;

export async function directoryUserById(accountId: string, id: string): Promise<DirectoryUser | null> {
  const [row] = await db.select().from(accountScimUsers).where(and(
    eq(accountScimUsers.accountId, accountId),
    or(eq(accountScimUsers.scimId, id), eq(accountScimUsers.userId, id), eq(accountScimUsers.invitationId, id)),
  )).limit(1);
  return row ?? null;
}

export async function directoryUserByEmail(accountId: string, email: string): Promise<DirectoryUser | null> {
  const [row] = await db.select().from(accountScimUsers).where(and(
    eq(accountScimUsers.accountId, accountId), eq(accountScimUsers.userName, email.trim().toLowerCase()),
  )).limit(1);
  return row ?? null;
}

export function buildDirectoryUser(user: DirectoryUser): UserShape {
  const resource = buildInviteUser(user.accountId, {
    inviteId: user.scimId, email: user.userName, createdAt: user.createdAt, externalId: user.externalId,
  }, user.active);
  return { ...user.profile, ...resource, emails: user.profile.emails as UserShape['emails'] ?? resource.emails, meta: { ...resource.meta, lastModified: user.updatedAt.toISOString() } };
}

export async function saveDirectoryUser(user: typeof accountScimUsers.$inferInsert): Promise<DirectoryUser> {
  const { scimId, createdAt, ...changes } = user;
  const [updated] = await db.update(accountScimUsers).set({ ...changes, updatedAt: new Date() })
    .where(and(eq(accountScimUsers.accountId, user.accountId), eq(accountScimUsers.scimId, scimId)))
    .returning();
  if (updated) return updated;
  const [row] = await db.insert(accountScimUsers).values(user).onConflictDoUpdate({
    target: [accountScimUsers.accountId, accountScimUsers.userName],
    set: { ...changes, updatedAt: new Date() },
  }).returning();
  return row!;
}

export function directoryGroupIds(user: DirectoryUser): string[] {
  const groups = user.profile.groups;
  return Array.isArray(groups)
    ? groups.filter(g => g && typeof g.value === 'string').map(g => g.value as string)
    : [];
}

export async function saveDirectoryGroups(user: DirectoryUser, groupIds: string[]) {
  return saveDirectoryUser({ ...user, profile: { ...user.profile, groups: [...new Set(groupIds)].map(value => ({ value })) } });
}
