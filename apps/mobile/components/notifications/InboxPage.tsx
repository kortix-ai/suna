/**
 * InboxPage — the caller's notifications across every project (KRTX-1742),
 * at `/projects/[id]/inbox`: the drawer's Notifications pill. Layout rules:
 * apps/mobile/design.md → Notifications page.
 *
 *   header  `SettingsHeader` with the hamburger, "Notifications", and
 *           "Mark all as read" while a notification is unread.
 *   list    One `SettingsGroup`, newest first (the newest 50): unread dot ·
 *           title over "kind · project" · time. Pull to refresh.
 *   tap     Marks the row read and opens its session, or its project for an
 *           automation alert, through the push store's open: the path a push
 *           tap takes. A session of this project replaces this page with the
 *           view (useCoveringRoute); another project replaces this one.
 */

import * as React from 'react';
import { RefreshControl, View } from 'react-native';
import { useColorScheme } from 'nativewind';
import type { InboxNotification } from '@kortix/sdk';
import { useNotificationInbox } from '@kortix/sdk/react';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import { SettingsGroup, SettingsHeader, SettingsPage, SettingsRow } from '@/components/kortix/settings-list';
import { useToast } from '@/components/kortix/toast-provider';
import { useCoveringRoute, useProjectRoute } from '@/components/session/ProjectRoutes';
import { useAuthContext } from '@/contexts';
import { haptics } from '@/lib/haptics';
import {
  NOTIFICATION_INBOX_LIMIT,
  inboxOpenTarget,
  inboxRowDetail,
  inboxRowLabel,
  inboxRowTitle,
} from '@/lib/notifications/inbox';
import { shortRelative } from '@/lib/session/session-list';
import { cn } from '@/lib/utils/index';
import { THEME } from '@/lib/utils/theme';
import { usePushStore } from '@/stores/push-store';

/** The unread marker, the "needs-you" blue (`SessionStatusMark`). A read row keeps the slot, so titles align. */
function UnreadDot({ unread }: { unread: boolean }) {
  return <View className={cn('size-2 rounded-full', unread && 'bg-kortix-blue')} />;
}

export function InboxPage() {
  const { openDrawer, isDrawerOpen } = useProjectRoute();
  // A session opened from the drawer or from a row replaces this page with the view.
  useCoveringRoute();
  const { user } = useAuthContext();
  const inbox = useNotificationInbox({ userId: user?.id, limit: NOTIFICATION_INBOX_LIMIT });
  const toast = useToast();
  const { colorScheme } = useColorScheme();

  const [refreshing, setRefreshing] = React.useState(false);
  // `refetch` is stable; the query object is new on every render.
  const refetch = inbox.refetch;
  const onRefresh = React.useCallback(async () => {
    setRefreshing(true);
    try {
      await refetch();
    } finally {
      setRefreshing(false);
    }
  }, [refetch]);

  const markAllRead = () => {
    haptics.tap();
    inbox.markAllRead().catch(() => toast.error('Unable to mark notifications as read. Try again.'));
  };

  const open = (row: InboxNotification) => {
    haptics.tap();
    // Fire and forget: a failed write leaves the row unread, and opening a session marks it read too.
    if (!row.read) inbox.markRead([row.id]).catch(() => {});
    const target = inboxOpenTarget(row);
    if (target) usePushStore.getState().requestOpen(target.projectId, target.sessionId);
  };

  const rows = inbox.data?.notifications ?? [];
  // The page re-renders on every inbox poll (60 s), which keeps the times current.
  const now = Date.now();

  return (
    <View className="flex-1 bg-background">
      <SettingsHeader
        title="Notifications"
        onOpenMenu={openDrawer}
        right={
          inbox.unreadCount > 0 ? (
            <Button variant="ghost" size="sm" className="rounded-full" onPress={markAllRead}>
              <Text>Mark all as read</Text>
            </Button>
          ) : null
        }
      />
      {rows.length > 0 ? (
        <SettingsPage
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colorScheme === 'dark' ? THEME.dark.mutedForeground : THEME.light.mutedForeground}
            />
          }>
          <SettingsGroup>
            {rows.map((row) => (
              <SettingsRow
                key={row.id}
                leading={<UnreadDot unread={!row.read} />}
                label={inboxRowTitle(row)}
                description={inboxRowDetail(row)}
                value={shortRelative(Date.parse(row.created_at), now)}
                right={null}
                onPress={() => open(row)}
                accessibilityLabel={inboxRowLabel(row, now)}
                accessibilityHint={row.session_id ? 'Opens the session' : 'Opens the project'}
              />
            ))}
          </SettingsGroup>
        </SettingsPage>
      ) : (
        <View className="flex-1 items-center justify-center gap-3 px-8">
          {inbox.isPending ? (
            // One loader at a time: none under the open drawer.
            isDrawerOpen ? null : <KortixLoader />
          ) : inbox.isError ? (
            <>
              <Text variant="muted" className="text-center">
                Unable to load notifications.
              </Text>
              <Button variant="secondary" size="sm" className="rounded-full" onPress={() => void refetch()}>
                <Text>Try again</Text>
              </Button>
            </>
          ) : (
            <Text variant="muted" className="text-center">
              No notifications yet
            </Text>
          )}
        </View>
      )}
    </View>
  );
}
