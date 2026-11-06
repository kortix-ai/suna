/**
 * The inbox's data: the flag gate, the user key, and the unread count.
 *
 * Both `InboxScreen` and the sidebar badge read `useNotificationInbox` with
 * the same `INBOX_LIMIT`, so they share ONE cache entry and one poll.
 */

import { useFeatureFlag, useNotificationInbox } from '@kortix/sdk/react';

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
 * The inbox gate, as on the web (`useNotificationCenter`): the project's
 * `notification_center` flag. It reads the shared project-detail entry.
 * Fail-closed.
 */
export function useInboxEnabled(projectId: string | null | undefined): {
  enabled: boolean;
  isLoading: boolean;
} {
  const center = useFeatureFlag(projectId, 'notification_center');
  return {
    enabled: center.enabled,
    isLoading: center.isLoading,
  };
}

/** The inbox query for the active project's gate. Sends nothing while the gate is off. */
export function useInbox(projectId: string | null | undefined) {
  const gate = useInboxEnabled(projectId);
  const inbox = useNotificationInbox({
    userId: inboxUserId(),
    limit: INBOX_LIMIT,
    enabled: gate.enabled,
  });
  return { ...gate, inbox };
}

/** The unread count for the sidebar. 0 while the gate is off or the first read is in flight. */
export function useInboxUnread(projectId: string | null | undefined): number {
  const { enabled, inbox } = useInbox(projectId);
  return enabled ? inbox.unreadCount : 0;
}
