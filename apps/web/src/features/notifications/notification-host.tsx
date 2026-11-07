'use client';

/**
 * Notification behavior that does not depend on the page (KRTX-1742). Mounted
 * once by `RootQueryHosts`; does nothing while signed out. While signed in,
 * on every page:
 *
 * 1. Web Push: this browser subscribes while "Enable notifications" is on and
 *    the browser allows it, once per person and page load. The switch never
 *    waits for it. When the switch is off, or the browser blocks it, the
 *    subscription is removed. Until the subscription answers, this tab reads
 *    from the browser whether one exists, so its copy of a notification goes
 *    to the service worker. The MFA step-up registers an existing
 *    subscription again, at aal2.
 * 2. The Push choice per kind, mirrored into `web-notifications.ts`, so an
 *    in-page OS notification obeys the same choice as the phone. Sign-out or
 *    a change of person clears the mirror.
 * 3. Arrivals: a new unread row toasts, unless it is about the session on screen
 *    or another project. It becomes an OS notification instead where nothing
 *    else would deliver it (the desktop app, a browser without Web Push).
 *    There, a hidden window keeps checking the inbox once a minute.
 * 4. `?notification=<id>` on any page, or the service worker's message for a
 *    clicked notification, marks that row read.
 *
 * The inbox this host polls is the one the sidebar's Inbox row and the Inbox
 * page read: one cache entry, one poll.
 */

import { useAuth } from '@/features/providers/auth-provider';
import { useTranslations } from '@/i18n/use-translations';
import {
  dismissStaleNotificationToasts,
  isOtherProject,
  isViewingSession,
  sendWebNotification,
  setServerPushPreferences,
  showInAppNotification,
} from '@kortix/ui/internal/lib/web-notifications';
import { canonicalAppPath } from '@kortix/ui/internal/lib/onboarding/landing-destination';
import { useTurnAttentionStore } from '@kortix/ui/internal/stores/turn-attention-store';
import { useWebNotificationStore } from '@kortix/ui/internal/stores/web-notification-store';
import type { InboxNotification } from '@kortix/sdk';
import { useNotificationInbox, useNotificationPreferences } from '@kortix/sdk/react';
import { useSearchParams } from 'next/navigation';
import { useEffect, useRef } from 'react';
import {
  NOTIFICATION_PARAM,
  isNotificationId,
  newArrivals,
  notificationTag,
  openedNotificationId,
  planArrivals,
  pollsWhileHidden,
  rowDestination,
  webNotificationType,
  withoutNotificationParam,
} from '@kortix/ui/internal/notifications/notification-rows';
import {
  detectWebPush,
  ensureWebPush,
  hasWebPushSubscription,
  reregisterWebPush,
  syncWebPush,
  wantsWebPush,
  webPushSupported,
} from '@kortix/ui/internal/notifications/web-push';

/** The inbox check of a hidden window, the SDK poll's interval. */
const HIDDEN_POLL_MS = 60_000;

const ARRIVAL_LABEL = {
  session: 'arrival.openSession',
  reminders: 'arrival.openReminders',
  triggers: 'arrival.openTriggers',
} as const;

export function NotificationHost() {
  const { user } = useAuth();
  // Keyed by the user: a new person starts with nothing seen.
  return user ? <SignedInNotificationHost key={user.id} userId={user.id} /> : null;
}

function SignedInNotificationHost({ userId }: { userId: string }) {
  const { supabase } = useAuth();
  const t = useTranslations('notifications');
  const enabled = useWebNotificationStore((s) => s.preferences.enabled);
  const permission = useWebNotificationStore((s) => s.permission);
  const search = useSearchParams();
  const inbox = useNotificationInbox({ userId });
  const { data: preferences } = useNotificationPreferences({ userId });
  // The latest `markRead`, for callbacks that outlive this render.
  const markRead = useRef(inbox.markRead);
  useEffect(() => {
    markRead.current = inbox.markRead;
  });

  // `?thread=` opens a session with no pathname change: the session on screen
  // loses its toast there too.
  useEffect(() => {
    dismissStaleNotificationToasts();
  }, [search]);

  useEffect(() => {
    if (!webPushSupported()) return;
    if (!wantsWebPush({ supported: true, enabled, permission })) {
      void syncWebPush(false);
      return;
    }
    void detectWebPush();
    void ensureWebPush(userId);
  }, [enabled, permission, userId]);

  // The MFA step-up upgrades this sign-in to aal2 in place, with no reload.
  // The API stores the level at registration and sends Web Push for an
  // account that requires MFA only to an aal2 subscription: register the
  // existing one again, on any page. The auth provider caches the aal2 token
  // before this listener runs.
  useEffect(() => {
    if (!webPushSupported()) return;
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event !== 'MFA_CHALLENGE_VERIFIED') return;
      const state = useWebNotificationStore.getState();
      if (wantsWebPush({ supported: true, enabled: state.preferences.enabled, permission: state.permission })) {
        void reregisterWebPush();
      }
    });
    return () => data.subscription.unsubscribe();
  }, [supabase]);

  // The SDK poll stops while the page is hidden. Where Web Push does not
  // reach this renderer, a hidden window keeps checking, so its OS
  // notifications fire while it is minimized or covered.
  const refetch = inbox.refetch;
  useEffect(() => {
    const timer = window.setInterval(() => {
      const state = useWebNotificationStore.getState();
      const hidden = document.visibilityState === 'hidden';
      if (
        pollsWhileHidden({
          hidden,
          subscribed: hasWebPushSubscription(),
          enabled: state.preferences.enabled,
          permission: state.permission,
        })
      ) {
        void refetch();
      }
    }, HIDDEN_POLL_MS);
    return () => window.clearInterval(timer);
  }, [refetch]);

  // A click on a notification whose page is already open focuses that tab
  // and posts its url here (`public/sw.js`): mark that row read.
  useEffect(() => {
    const container = typeof navigator === 'undefined' ? undefined : navigator.serviceWorker;
    if (!container) return;
    const onMessage = (event: MessageEvent) => {
      const id = openedNotificationId(event.data);
      if (id) markRead.current([id]).catch(() => {});
    };
    container.addEventListener('message', onMessage);
    return () => container.removeEventListener('message', onMessage);
  }, []);

  // The Push mirror belongs to this person: cleared on sign-out or a change of person.
  useEffect(() => {
    if (preferences) setServerPushPreferences(preferences.kinds);
  }, [preferences]);
  useEffect(() => () => setServerPushPreferences(undefined), []);

  const seen = useRef<Set<string> | null>(null);
  const rows = inbox.data?.notifications;
  useEffect(() => {
    if (!rows) return;
    const arrivals = newArrivals(seen.current, rows);
    seen.current = arrivals.seen;
    if (arrivals.fresh.length === 0) return;
    const plan = planArrivals(arrivals.fresh, {
      onScreen: isViewingSession,
      otherProject: isOtherProject,
      unseen: useTurnAttentionStore.getState().unseen,
      os:
        typeof document !== 'undefined' &&
        !document.hasFocus() &&
        useWebNotificationStore.getState().preferences.enabled &&
        typeof Notification !== 'undefined' &&
        Notification.permission === 'granted' &&
        !hasWebPushSubscription(),
    });
    const label = (row: InboxNotification) => t(ARRIVAL_LABEL[rowDestination(row)]);
    const kindLine = (row: InboxNotification) =>
      row.project_name
        ? t('arrival.inProject', { kind: t(`kind.${row.kind}`), project: row.project_name })
        : t(`kind.${row.kind}`);

    // One payload for both paths. The OS notification shows title + body; the
    // in-app toast leads with the kind line and names the subject in its entity
    // row (a session, or a trigger with its clock).
    const payloadOf = (row: InboxNotification) => ({
      type: webNotificationType(row),
      title: row.title,
      body: row.body || kindLine(row),
      inAppTitle: kindLine(row),
      entityLabel: row.title,
      preview: row.body || undefined,
      tag: notificationTag(row),
      sessionId: row.session_id ?? undefined,
      projectId: row.project_id,
      href: row.session_id ? undefined : canonicalAppPath(withoutNotificationParam(row.url)),
      actionLabel: label(row),
      onClick: () => {
        markRead.current([row.id]).catch(() => {});
      },
    });
    for (const row of plan.toast) showInAppNotification(payloadOf(row));
    // The OS path applies the channel policy itself (`sendWebNotification`).
    for (const row of plan.os) sendWebNotification(payloadOf(row));
  }, [rows, t]);

  const fromUrl = search?.get(NOTIFICATION_PARAM) ?? null;
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (!fromUrl || handled.current === fromUrl) return;
    handled.current = fromUrl;
    if (isNotificationId(fromUrl)) markRead.current([fromUrl]).catch(() => {});
    // `history.replaceState`, not `router.replace`: dropping a query key needs
    // no server render, and Next keeps `useSearchParams` in step with it.
    const { pathname, search: query, hash } = window.location;
    window.history.replaceState(null, '', withoutNotificationParam(`${pathname}${query}${hash}`));
  }, [fromUrl]);

  return null;
}
