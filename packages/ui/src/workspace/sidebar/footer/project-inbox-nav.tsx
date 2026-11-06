'use client';

import { uiRoutes } from '../../../lib/routes';
import { ProjectNavRow } from '../../../internal/layout/project-nav-row';
import { tabUnreadCount } from '../../../internal/notifications/notification-rows';
import { useTranslations } from '../../../i18n';
import { CountBadge } from '../../../primitives/count-badge';
import { useUiPathname, useUiViewerId } from '../../../providers/ui-provider';
import { useNotificationInbox } from '@kortix/sdk/react';
import { BellIcon } from '@phosphor-icons/react';

/**
 * The Inbox row (KRTX-1742), under New session: the person's notifications
 * from every project, on their own page (`uiRoutes().inbox`). The count is the
 * server's unread count (99+ at most), in the "needs you" tint while an
 * unread question, permission request or failure waits. It reads the inbox
 * `NotificationHost` polls, so it sends no request of its own. Absent when
 * the host serves no Inbox page.
 */
export function ProjectInboxNavItem({ projectId }: { projectId: string }) {
  const t = useTranslations('notifications');
  const pathname = useUiPathname();
  const viewerId = useUiViewerId();
  const inbox = useNotificationInbox({ userId: viewerId });
  const href = uiRoutes().inbox?.(projectId) ?? null;
  if (!href) return null;
  const count = inbox.unreadCount;
  const needsYou = tabUnreadCount(inbox.data?.notifications ?? [], 'needs') > 0;
  // `endsWith` / `includes` tolerate the locale prefix the host may not strip.
  const active = !!pathname && (pathname.endsWith(href) || pathname.includes(`${href}/`));
  return (
    <ProjectNavRow active={active} label={t('inbox.title')} href={href} prefetch>
      <BellIcon />
      {t('inbox.title')}
      {count > 0 ? (
        <span className="ml-auto flex shrink-0 items-center">
          <CountBadge
            count={count}
            tone={needsYou ? 'waiting' : 'neutral'}
            aria-label={t('inbox.unreadCount', { count })}
          />
        </span>
      ) : null}
    </ProjectNavRow>
  );
}
