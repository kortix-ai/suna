'use client';

import { uiRoutes } from '../../lib/routes';
import { useUiViewerId } from '../../providers/ui-provider';
import { useNotificationInbox } from '@kortix/sdk/react';
import { tabUnreadCount } from './notification-rows';

/**
 * The Inbox entry point (KRTX-1742) in the workspace menu: the Inbox page's
 * href, the server's unread count (99+ at most), and whether an unread
 * question, permission request or failure waits ("needs you"). It reads the
 * inbox `NotificationHost` polls, so it sends no request of its own. `href` is
 * null when the host serves no Inbox page.
 */
export function useInboxSummary(projectId: string): {
  href: string | null;
  count: number;
  needsYou: boolean;
} {
  const viewerId = useUiViewerId();
  const inbox = useNotificationInbox({ userId: viewerId });
  const href = uiRoutes().inbox?.(projectId) ?? null;
  return {
    href,
    count: href ? inbox.unreadCount : 0,
    needsYou: !!href && tabUnreadCount(inbox.data?.notifications ?? [], 'needs') > 0,
  };
}
