'use client';

/**
 * The caller's notifications (KRTX-1742): the inbox, the preference record,
 * and the caller's watch on one session.
 *
 * Every hook takes the signed-in user's `userId`: each response answers for
 * the caller, so the id is part of the cache key (`qk.notifications`). Without
 * a user id a hook sends nothing.
 *
 * Writes are optimistic: the cache changes at once, a rejected write restores
 * it, and the returned promise rejects so the host can say so.
 */

import { useMutation, useQuery, useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';
import {
  getNotificationPreferences,
  getSessionWatch,
  listNotifications,
  markNotificationsRead,
  setSessionWatch,
  updateNotificationPreferences,
  type InboxNotification,
  type InboxNotificationPage,
  type NotificationPreferences,
  type NotificationPreferencesPatch,
} from '../core/rest/projects-client';
import { contract } from './query-contracts';
import { qk } from './query-keys';

const DEFAULT_INBOX_LIMIT = 20;

/**
 * The key, gate and freshness `useNotificationInbox` reads, without React.
 * The inbox polls every 60 s while the page is visible and refetches when the
 * window regains focus. A hidden page does not poll here: every request writes
 * an audit row, and Web Push reaches a browser that holds a subscription. A
 * host without Web Push (the desktop app, a browser without it) runs its own
 * hidden-page check with `refetch` (the web `NotificationHost` does).
 */
export function notificationInboxQueryOptions(
  userId: string | null | undefined,
  limit: number = DEFAULT_INBOX_LIMIT,
  enabled = true,
) {
  return {
    queryKey: qk.notifications.inbox(userId, limit),
    enabled: enabled && !!userId,
    ...contract('inventory'),
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  };
}

/** Write `next` at `key` now; the returned function puts the previous value back. */
async function writeOptimistic<T>(client: QueryClient, key: QueryKey, next: (previous: T) => T) {
  await client.cancelQueries({ queryKey: key });
  const previous = client.getQueryData<T>(key);
  if (previous !== undefined) client.setQueryData<T>(key, next(previous));
  return () => client.setQueryData<T>(key, previous);
}

type MarkReadInput = Parameters<typeof markNotificationsRead>[0];

/** The page with the rows `input` names marked read, and the count lowered by the rows that changed. */
function markedRead(page: InboxNotificationPage, input: MarkReadInput): InboxNotificationPage {
  if ('all' in input) {
    return { ...page, unread_count: 0, notifications: page.notifications.map((n) => ({ ...n, read: true })) };
  }
  const hit = (n: InboxNotification) => ('ids' in input ? input.ids.includes(n.id) : n.session_id === input.sessionId);
  let changed = 0;
  const notifications = page.notifications.map((n) => {
    if (n.read || !hit(n)) return n;
    changed += 1;
    return { ...n, read: true };
  });
  return { ...page, notifications, unread_count: Math.max(0, page.unread_count - changed) };
}

export interface UseNotificationInboxOptions {
  /** The signed-in user's id. Part of the cache key; no request without it. */
  userId: string | null | undefined;
  /** Rows per page, 1 to 50. Default 20. */
  limit?: number;
  /** The caller's own gate, ANDed with `userId`. */
  enabled?: boolean;
}

/**
 * The newest page of the caller's inbox, its unread count, and the read
 * writes. After a write settles, every inbox entry refetches.
 */
export function useNotificationInbox(options: UseNotificationInboxOptions) {
  const client = useQueryClient();
  const limit = options.limit ?? DEFAULT_INBOX_LIMIT;
  const key = qk.notifications.inbox(options.userId, limit);
  const query = useQuery<InboxNotificationPage>({
    ...notificationInboxQueryOptions(options.userId, limit, options.enabled ?? true),
    queryFn: ({ signal }) => listNotifications({ limit }, { signal }),
  });
  const mark = useMutation({
    mutationFn: markNotificationsRead,
    onMutate: (input: MarkReadInput) =>
      writeOptimistic<InboxNotificationPage>(client, key, (page) => markedRead(page, input)),
    onError: (_error, _input, restore) => restore?.(),
    // Not returned: the write's promise settles with the write, not the refetch.
    onSettled: () => {
      void client.invalidateQueries({ queryKey: qk.notifications.scope() });
    },
  });
  return {
    ...query,
    /** Unread rows the caller may see, counted over the newest 100. 0 until loaded. */
    unreadCount: query.data?.unread_count ?? 0,
    markRead: (ids: string[]) => mark.mutateAsync({ ids }),
    markAllRead: () => mark.mutateAsync({ all: true }),
    markSessionRead: (sessionId: string) => mark.mutateAsync({ sessionId }),
  };
}

export interface UseNotificationPreferencesOptions {
  /** The signed-in user's id. Part of the cache key; no request without it. */
  userId: string | null | undefined;
  enabled?: boolean;
}

/** The caller's push and email choices per kind, and `update(patch)`. */
export function useNotificationPreferences(options: UseNotificationPreferencesOptions) {
  const client = useQueryClient();
  const key = qk.notifications.preferences(options.userId);
  const query = useQuery<NotificationPreferences>({
    queryKey: key,
    queryFn: getNotificationPreferences,
    enabled: (options.enabled ?? true) && !!options.userId,
    ...contract('config'),
  });
  const save = useMutation({
    mutationFn: updateNotificationPreferences,
    onMutate: (patch: NotificationPreferencesPatch) =>
      writeOptimistic<NotificationPreferences>(client, key, (record) => {
        const kinds = { ...record.kinds };
        for (const [kind, channels] of Object.entries(patch.kinds) as Array<
          [keyof NotificationPreferences['kinds'], Partial<{ push: boolean; email: boolean }> | undefined]
        >) {
          if (channels) kinds[kind] = { ...kinds[kind], ...channels };
        }
        return { ...record, kinds };
      }),
    onError: (_error, _patch, restore) => restore?.(),
    onSuccess: (record) => client.setQueryData(key, record),
  });
  return { ...query, update: (patch: NotificationPreferencesPatch) => save.mutateAsync(patch) };
}

export interface UseSessionWatchOptions {
  /** The signed-in user's id. Part of the cache key; no request without it. */
  userId: string | null | undefined;
  projectId: string | null | undefined;
  sessionId: string | null | undefined;
  enabled?: boolean;
}

/** Is the caller notified about this session, and `setWatching(watching)` to mute or watch it. */
export function useSessionWatch(options: UseSessionWatchOptions) {
  const client = useQueryClient();
  const projectId = options.projectId ?? '';
  const sessionId = options.sessionId ?? '';
  const key = qk.notifications.sessionWatch(options.userId, projectId, sessionId);
  const query = useQuery<{ watching: boolean }>({
    queryKey: key,
    queryFn: () => getSessionWatch(projectId, sessionId),
    enabled: (options.enabled ?? true) && !!options.userId && !!projectId && !!sessionId,
    ...contract('config'),
  });
  const save = useMutation({
    mutationFn: (watching: boolean) => setSessionWatch(projectId, sessionId, watching),
    onMutate: (watching: boolean) => writeOptimistic<{ watching: boolean }>(client, key, () => ({ watching })),
    onError: (_error, _watching, restore) => restore?.(),
    onSuccess: (state) => client.setQueryData(key, state),
  });
  return { ...query, setWatching: (watching: boolean) => save.mutateAsync(watching) };
}
