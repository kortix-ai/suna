/**
 * inbox — the rules of the Notifications page (components/notifications/
 * InboxPage.tsx) and the push switches of Settings → Notifications
 * (app/(settings)/notifications.tsx), KRTX-1742: the words for each kind, a
 * row's title, detail line and spoken label, and where a row opens.
 *
 * Pure: no React, React Native, or expo imports (unit-tested under bun test).
 */

import type { InboxNotification, InboxNotificationKind } from '@kortix/sdk';
import { spokenRelative, UNTITLED_SESSION_LABEL } from '@/lib/session/session-list';

/**
 * Rows the inbox reads: the API's largest page. ProjectScreen (the drawer's
 * unread count) and the Notifications page pass the same limit, so they share
 * one query and one poll.
 */
export const NOTIFICATION_INBOX_LIMIT = 50;

/**
 * The word for each kind: an inbox row's detail line and its Push switch in
 * Settings → Notifications. The web app's words (`notifications.kind.*` in
 * apps/web/translations/en.json), which its bell and settings use.
 */
export const KIND_LABEL: Record<InboxNotificationKind, string> = {
  turn_done: 'Turn finished',
  turn_error: 'Turn failed',
  question: 'Question',
  permission: 'Permission request',
  shared: 'Shared with you',
  automation_failed: 'Failure alert',
  automation_recovered: 'Recovery alert',
};

/** A kind a newer server sends that this app does not know yet. */
const UNKNOWN_KIND_LABEL = 'Notification';

function kindLabel(kind: InboxNotificationKind): string {
  return KIND_LABEL[kind] ?? UNKNOWN_KIND_LABEL;
}

/** The row's title: the session or automation name, else the session's untitled label or the trigger. */
export function inboxRowTitle(row: InboxNotification): string {
  const title = row.title.trim();
  if (title) return title;
  return row.session_id || !row.trigger_slug ? UNTITLED_SESSION_LABEL : row.trigger_slug;
}

/** The muted line under the title: the kind, then the project ("Question · Website"). */
export function inboxRowDetail(row: InboxNotification): string {
  const kind = kindLabel(row.kind);
  return row.project_name ? `${kind} · ${row.project_name}` : kind;
}

/** The row's spoken label: "Question, Fix the login page, Website, 5 minutes ago, unread". */
export function inboxRowLabel(row: InboxNotification, now: number): string {
  return [
    kindLabel(row.kind),
    inboxRowTitle(row),
    row.project_name,
    spokenRelative(Date.parse(row.created_at), now),
    row.read ? null : 'unread',
  ]
    .filter(Boolean)
    .join(', ');
}

/** Where a row opens: its session, else its project (an automation alert), else nowhere. */
export function inboxOpenTarget(row: InboxNotification): { projectId: string; sessionId: string | null } | null {
  if (!row.project_id) return null;
  return { projectId: row.project_id, sessionId: row.session_id };
}
