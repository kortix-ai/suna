'use client';

/**
 * Notification behavior that does not depend on the page (KRTX-1742). Mounted
 * once by `RootQueryHosts`; does nothing while signed out.
 *
 * 1. Web Push: this browser subscribes while "Enable notifications" is on and
 *    the browser allows it, and unsubscribes when it is turned off. The switch
 *    never waits for it.
 * 2. The Push choice per kind, mirrored into `web-notifications.ts`, so an
 *    in-page OS notification obeys the same choice as the phone.
 * 3. Arrivals: a new unread row toasts, and becomes an OS notification where
 *    nothing else would deliver it (the desktop app, a browser without Web Push).
 * 4. `?notification=<id>` on any page marks that row read and leaves the URL.
 */

import { Button } from '@/components/ui/button';
import { dismissToast, infoToast } from '@/components/ui/toast';
import { useAuth } from '@/features/providers/auth-provider';
import { useTranslations } from '@/i18n/use-translations';
import { softNavigate } from '@/lib/navigation/router-bridge';
import {
  isTabHidden,
  isViewingSession,
  sendWebNotification,
  setServerPushPreferences,
} from '@/lib/web-notifications';
import { useTurnAttentionStore } from '@/stores/turn-attention-store';
import { useWebNotificationStore } from '@/stores/web-notification-store';
import type { InboxNotification } from '@kortix/sdk';
import { useNotificationInbox, useNotificationPreferences } from '@kortix/sdk/react';
import { useSearchParams } from 'next/navigation';
import { createElement, useEffect, useRef } from 'react';
import {
  NOTIFICATION_PARAM,
  isNotificationId,
  newArrivals,
  notificationTag,
  planArrivals,
  webNotificationType,
  withoutNotificationParam,
} from './notification-rows';
import { hasWebPushSubscription, syncWebPush, wantsWebPush, webPushSupported } from './web-push';

export function NotificationHost() {
  const { user } = useAuth();
  // Keyed by the user: a new person starts with nothing seen.
  return user ? <SignedInNotificationHost key={user.id} userId={user.id} /> : null;
}

function SignedInNotificationHost({ userId }: { userId: string }) {
  const t = useTranslations('notifications');
  const enabled = useWebNotificationStore((s) => s.preferences.enabled);
  const permission = useWebNotificationStore((s) => s.permission);
  const inbox = useNotificationInbox({ userId });
  const { data: preferences } = useNotificationPreferences({ userId });
  // The latest `markRead`, for callbacks that outlive this render.
  const markRead = useRef(inbox.markRead);
  useEffect(() => {
    markRead.current = inbox.markRead;
  });

  useEffect(() => {
    if (!webPushSupported()) return;
    void syncWebPush(wantsWebPush({ supported: true, enabled, permission }));
  }, [enabled, permission, userId]);

  useEffect(() => {
    setServerPushPreferences(preferences?.kinds);
  }, [preferences]);

  const seen = useRef<Set<string> | null>(null);
  const rows = inbox.data?.notifications;
  useEffect(() => {
    if (!rows) return;
    const arrivals = newArrivals(seen.current, rows);
    seen.current = arrivals.seen;
    if (arrivals.fresh.length === 0) return;
    const plan = planArrivals(arrivals.fresh, {
      onScreen: (sessionId) => !isTabHidden() && isViewingSession(sessionId),
      unseen: useTurnAttentionStore.getState().unseen,
      os:
        typeof document !== 'undefined' &&
        !document.hasFocus() &&
        useWebNotificationStore.getState().preferences.enabled &&
        typeof Notification !== 'undefined' &&
        Notification.permission === 'granted' &&
        !hasWebPushSubscription(),
    });
    const open = (row: InboxNotification) => {
      markRead.current([row.id]).catch(() => {});
      softNavigate(withoutNotificationParam(row.url));
    };
    const label = (row: InboxNotification) =>
      row.session_id ? t('arrival.openSession') : t('arrival.openTriggers');
    const kindLine = (row: InboxNotification) =>
      row.project_name
        ? t('arrival.inProject', { kind: t(`kind.${row.kind}`), project: row.project_name })
        : t(`kind.${row.kind}`);

    for (const row of plan.toast) {
      const id = `notification-${row.id}`;
      infoToast(row.title, {
        id,
        description: kindLine(row),
        button: createElement(
          Button,
          {
            size: 'sm',
            variant: 'outline',
            onClick: () => {
              dismissToast(id);
              open(row);
            },
          },
          label(row),
        ),
      });
    }
    // The OS path toasts and plays the sound itself (`sendWebNotification`).
    for (const row of plan.os) {
      sendWebNotification({
        type: webNotificationType(row),
        title: row.title,
        body: row.body || kindLine(row),
        tag: notificationTag(row),
        sessionId: row.session_id ?? undefined,
        projectId: row.project_id,
        href: row.session_id ? undefined : withoutNotificationParam(row.url),
        actionLabel: label(row),
        onClick: () => {
          markRead.current([row.id]).catch(() => {});
        },
      });
    }
  }, [rows, t]);

  const params = useSearchParams();
  const fromUrl = params?.get(NOTIFICATION_PARAM) ?? null;
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (!fromUrl || handled.current === fromUrl) return;
    handled.current = fromUrl;
    if (isNotificationId(fromUrl)) markRead.current([fromUrl]).catch(() => {});
    // `history.replaceState`, not `router.replace`: dropping a query key needs
    // no server render, and Next keeps `useSearchParams` in step with it.
    const { pathname, search, hash } = window.location;
    window.history.replaceState(null, '', withoutNotificationParam(`${pathname}${search}${hash}`));
  }, [fromUrl]);

  return null;
}
