'use client';

import { useNotificationInbox } from '@kortix/sdk/react';
import { Button } from '@kortix/ui/button';
import Hint from '@kortix/ui/hint';
import { BellMark } from '@kortix/ui/internal/notifications/notification-bell';
import { tabUnreadCount } from '@kortix/ui/internal/notifications/notification-rows';
import Link from 'next/link';

import { useAuth } from '@/features/providers/auth-provider';
import { useTranslations } from '@/i18n/use-translations';

/** The account-level Inbox page: the pages outside a project link here. */
export const ACCOUNT_INBOX_HREF = '/inbox';

/**
 * The Inbox button of the account pages (KRTX-1742): the bell with the
 * server's unread count, 99+ at most, yellow while an unread question,
 * permission request or failure waits, blue otherwise. It opens `/inbox`. It
 * reads the inbox `NotificationHost` polls. Nothing while signed out.
 */
export function InboxButton() {
  const t = useTranslations('notifications');
  const { user } = useAuth();
  const inbox = useNotificationInbox({ userId: user?.id });
  if (!user) return null;
  const count = inbox.unreadCount;
  const needsYou = tabUnreadCount(inbox.data?.notifications ?? [], 'needs') > 0;
  return (
    <Hint side="bottom" label={t('inbox.title')}>
      <Button asChild variant="ghost" size="icon" className="relative shrink-0">
        <Link
          href={ACCOUNT_INBOX_HREF}
          prefetch
          aria-label={count > 0 ? t('inbox.unreadLabel', { count }) : t('inbox.title')}
        >
          <BellMark count={count} needsYou={needsYou} />
        </Link>
      </Button>
    </Hint>
  );
}
