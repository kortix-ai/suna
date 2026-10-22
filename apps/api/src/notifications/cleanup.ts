// Offboarding for notification data (KRTX-1742). The inbox, watcher, Web
// Push and conversation-membership rows key a person by `user_id` with no
// foreign key to auth.users, so nothing cascades when a person leaves an
// account or erases their account.
import { and, eq, inArray } from 'drizzle-orm';
import { notificationPreferences, notificationWatchers, notifications, projects, roomMembers, rooms, triggerWatchers } from '@kortix/db';
import { db } from '../shared/db';
import { deleteWebPushSubscriptionsForUser } from './web-push-subscriptions';

/**
 * A member left, was removed, or was deprovisioned by SCIM: their inbox rows
 * of the account, their session and trigger watcher rows in its projects, and
 * their conversation memberships in it go. Their rows in other accounts stay.
 */
export async function deleteMemberNotificationData(accountId: string, userId: string): Promise<void> {
  const accountProjects = db.select({ id: projects.projectId }).from(projects).where(eq(projects.accountId, accountId));
  await db.delete(notifications).where(and(eq(notifications.userId, userId), eq(notifications.accountId, accountId)));
  await db
    .delete(notificationWatchers)
    .where(and(eq(notificationWatchers.userId, userId), inArray(notificationWatchers.projectId, accountProjects)));
  await db
    .delete(triggerWatchers)
    .where(and(eq(triggerWatchers.userId, userId), inArray(triggerWatchers.projectId, accountProjects)));
  await db
    .delete(roomMembers)
    .where(and(eq(roomMembers.userId, userId), inArray(roomMembers.roomId, db.select({ id: rooms.roomId }).from(rooms).where(eq(rooms.accountId, accountId)))));
}

/** Account erasure: every notification row of the person, in every account. */
export async function deleteUserNotificationData(userId: string): Promise<void> {
  await db.delete(notifications).where(eq(notifications.userId, userId));
  await db.delete(notificationWatchers).where(eq(notificationWatchers.userId, userId));
  await db.delete(triggerWatchers).where(eq(triggerWatchers.userId, userId));
  await db.delete(roomMembers).where(eq(roomMembers.userId, userId));
  await db.delete(notificationPreferences).where(eq(notificationPreferences.userId, userId));
  await deleteWebPushSubscriptionsForUser(userId);
}
