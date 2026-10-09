'use client';

import { useNotificationInbox } from '@kortix/sdk/react';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { sessionUnreadRowId } from './notification-rows';

function subscribeVisibility(onChange: () => void) {
  document.addEventListener('visibilitychange', onChange);
  return () => document.removeEventListener('visibilitychange', onChange);
}

const isVisible = () => document.visibilityState === 'visible';

/**
 * Opening a session marks its notifications read (KRTX-1742). The server does
 * it on the presence write, but this tab's inbox cache keeps the rows unread
 * until its next poll, up to 60 s. While the page is visible, this sends the
 * same write through the SDK, which marks the rows read in the cache at once.
 * A hidden tab marks nothing, as on the server.
 *
 * Each unread row is tried once: a failed write restores the same row and is
 * not sent again. A new unread row of the session, or opening it again, is.
 */
export function useOpenSessionRead(userId: string | null | undefined, sessionId: string) {
  // Disabled: the observer reads the inbox `NotificationHost` polls, and sends
  // no request and runs no poll of its own.
  const inbox = useNotificationInbox({ userId, enabled: false });
  const unreadRowId = sessionUnreadRowId(inbox.data?.notifications, sessionId);
  const visible = useSyncExternalStore(subscribeVisibility, isVisible, () => false);
  const markSessionRead = useRef(inbox.markSessionRead);
  useEffect(() => {
    markSessionRead.current = inbox.markSessionRead;
  });
  const tried = useRef<string | null>(null);
  useEffect(() => {
    if (!visible || !unreadRowId || tried.current === unreadRowId) return;
    tried.current = unreadRowId;
    markSessionRead.current(sessionId).catch(() => {});
  }, [visible, unreadRowId, sessionId]);
}
