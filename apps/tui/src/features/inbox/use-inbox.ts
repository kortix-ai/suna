/**
 * The inbox's data: the user key, the query, and the unread count.
 *
 * Both `InboxScreen` and the sidebar badge read `useNotificationInbox` with
 * the same `INBOX_LIMIT`, so they share ONE cache entry and one poll.
 */

import { useNotificationInbox } from '@kortix/sdk/react';

import { hostInfo } from '../../kortix.ts';

/** Rows per page, 1 to 50. The most the SDK hook loads. */
export const INBOX_LIMIT = 50;

/**
 * The cache key's user part. A TUI process holds one token for its whole
 * lifetime, so the host name is a stable identity; the API answers for the
 * caller whatever this string is.
 */
export function inboxUserId(): string {
  return hostInfo()?.name || 'me';
}

/**
 * The inbox query. Notifications are on for every project (the
 * `notification_center` flag graduated on 2026-11-06), so no flag is read.
 * Sends nothing while no project is open: the screen then shows "No project
 * selected."
 */
export function useInbox(projectId: string | null | undefined) {
  return useNotificationInbox({
    userId: inboxUserId(),
    limit: INBOX_LIMIT,
    enabled: !!projectId,
  });
}

/** The unread count for the sidebar. 0 with no project open or while the first read is in flight. */
export function useInboxUnread(projectId: string | null | undefined): number {
  const inbox = useInbox(projectId);
  return projectId ? inbox.unreadCount : 0;
}
