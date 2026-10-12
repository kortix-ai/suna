/**
 * Pure helpers for inbox rows (KRTX-1742): where a row opens, which rows are
 * new since the last poll, the OS notification tag, and the badge count.
 */

import type { WebNotificationType } from '@/lib/web-notifications';
import type { InboxNotification } from '@kortix/sdk';
import { pushTypeOf } from '@kortix/shared/notification-kinds';

/** The query key a notification link carries so the opened page marks it read. */
export const NOTIFICATION_PARAM = 'notification';

/** The most new rows one poll announces. A wake from sleep can bring many more. */
export const MAX_ARRIVAL_ALERTS = 3;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Only a uuid reaches the API: anything else would answer 400. */
export function isNotificationId(value: string | null | undefined): value is string {
  return !!value && UUID.test(value);
}

/**
 * `url` without `?notification=<id>`. A row click marks the row read itself,
 * so the page it opens has nothing left to mark.
 */
export function withoutNotificationParam(url: string): string {
  const parsed = new URL(url, 'http://kortix.invalid');
  parsed.searchParams.delete(NOTIFICATION_PARAM);
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

/**
 * The unread rows of `rows` that `seen` does not hold yet, and the ids seen
 * after this poll. The first poll (`seen` null) announces nothing: those rows
 * were there before the page opened.
 */
export function newArrivals(
  seen: ReadonlySet<string> | null,
  rows: readonly InboxNotification[],
): { fresh: InboxNotification[]; seen: Set<string> } {
  const next = new Set(seen ?? []);
  for (const row of rows) next.add(row.id);
  if (!seen) return { fresh: [], seen: next };
  return { fresh: rows.filter((row) => !row.read && !seen.has(row.id)), seen: next };
}

/**
 * How new rows reach a person who is looking at this window: a toast for each
 * (at most `MAX_ARRIVAL_ALERTS`), or, when `os` (the window is in the
 * background, browser notifications are on and granted, and this renderer has
 * no Web Push), an OS notification instead. A row about the session on screen
 * is skipped. So is a finished turn the live stream already announced
 * (`unseen`); a later question, permission request or error in that session
 * is not.
 */
export function planArrivals(
  fresh: readonly InboxNotification[],
  context: { onScreen: (sessionId: string) => boolean; unseen: readonly string[]; os: boolean },
): { toast: InboxNotification[]; os: InboxNotification[] } {
  const announce = fresh
    .filter(
      (row) =>
        !row.session_id ||
        (!context.onScreen(row.session_id) &&
          !(row.kind === 'turn_done' && context.unseen.includes(row.session_id))),
    )
    .slice(0, MAX_ARRIVAL_ALERTS);
  return context.os ? { toast: [], os: announce } : { toast: announce, os: [] };
}

/** The in-page notification type: the push `type` of the kind. */
export function webNotificationType(row: InboxNotification): WebNotificationType {
  return pushTypeOf(row.kind) as WebNotificationType;
}

/**
 * `<type>:<sessionId|projectId:triggerSlug|id>`, the tag the Web Push message
 * for this row carries (`webPushMessageBody` in the API). A trigger slug is
 * unique per project only, so its tag carries the project too.
 */
export function notificationTag(row: InboxNotification): string {
  const subject = row.session_id ?? (row.trigger_slug ? `${row.project_id}:${row.trigger_slug}` : row.id);
  return `${pushTypeOf(row.kind)}:${subject}`;
}

/**
 * Where a row's open action goes, named by the page its `url` opens: its
 * session, the Reminders page (a reminder alert), or the Triggers page.
 */
export function rowDestination(row: InboxNotification): 'session' | 'reminders' | 'triggers' {
  if (row.session_id) return 'session';
  return new URL(row.url, 'http://kortix.invalid').pathname.endsWith('/reminders') ? 'reminders' : 'triggers';
}

/** The message `public/sw.js` posts to a tab already on a clicked notification's page. */
export const NOTIFICATION_OPEN_MESSAGE = 'kortix:notification-open';

/** The notification id a service-worker message says this tab opened, or null. */
export function openedNotificationId(data: unknown): string | null {
  const message = data as { type?: unknown; url?: unknown } | null;
  if (message?.type !== NOTIFICATION_OPEN_MESSAGE || typeof message.url !== 'string') return null;
  try {
    const id = new URL(message.url, 'http://kortix.invalid').searchParams.get(NOTIFICATION_PARAM);
    return isNotificationId(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * Whether a hidden window checks the inbox itself. The SDK poll stops while
 * the page is hidden. A renderer that Web Push does not reach (the desktop
 * app, a browser without Web Push) checks anyway, so its OS notifications
 * still fire while the window is minimized or covered.
 */
export function pollsWhileHidden(input: {
  hidden: boolean;
  subscribed: boolean;
  enabled: boolean;
  permission: NotificationPermission;
}): boolean {
  return input.hidden && !input.subscribed && input.enabled && input.permission === 'granted';
}

/** The id of the newest unread row of `sessionId` in `rows` (newest first), or null. */
export function sessionUnreadRowId(
  rows: readonly InboxNotification[] | undefined,
  sessionId: string,
): string | null {
  return rows?.find((row) => !row.read && row.session_id === sessionId)?.id ?? null;
}

/** The badge text: the count, clamped at 99+. */
export function badgeCount(count: number): string {
  return count > 99 ? '99+' : String(count);
}
