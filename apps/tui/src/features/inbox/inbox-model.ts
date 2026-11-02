/**
 * Inbox rows as the screen shows them: pure functions from the SDK's
 * `InboxNotification`. No React, no SDK calls.
 *
 * The kind words and the "needs you" kinds are the web's
 * (`packages/ui/src/internal/notifications/notification-rows.ts`, `en.ts`
 * `notifications.kind`), so one notification reads the same in both clients.
 */

import type { InboxNotification, InboxNotificationKind } from '@kortix/sdk';

export type InboxFilter = 'all' | 'unread' | 'needs';
export type InboxTone = 'ok' | 'idle' | 'busy' | 'bad';

export const FILTER_ORDER: readonly InboxFilter[] = ['all', 'unread', 'needs'];

export const FILTER_LABEL: Record<InboxFilter, string> = {
  all: 'All',
  unread: 'Unread',
  needs: 'Needs you',
};

export const KIND_LABEL: Record<InboxNotificationKind, string> = {
  turn_done: 'Turn finished',
  turn_error: 'Turn failed',
  question: 'Question',
  permission: 'Permission request',
  shared: 'Shared with you',
  automation_failed: 'Failure alert',
  automation_recovered: 'Recovery alert',
  capture_device_down: 'Capture computer stopped',
  capture_device_recovered: 'Capture computer recording again',
  message: 'Message',
  artifact_comment: 'Artifact comment',
};

/** Kinds that wait on the person: an answer, an approval, a failure to look at. */
const NEEDS_YOU: ReadonlySet<InboxNotificationKind> = new Set([
  'question',
  'permission',
  'turn_error',
  'automation_failed',
  'capture_device_down',
]);

/** One-column glyph by kind. Color is for the glyph only; the shape names the kind. */
const KIND_MARK: Record<InboxNotificationKind, { glyph: string; tone: InboxTone }> = {
  turn_done: { glyph: '✓', tone: 'ok' },
  turn_error: { glyph: '!', tone: 'bad' },
  question: { glyph: '?', tone: 'busy' },
  permission: { glyph: '?', tone: 'busy' },
  shared: { glyph: '+', tone: 'idle' },
  automation_failed: { glyph: '!', tone: 'bad' },
  automation_recovered: { glyph: '✓', tone: 'ok' },
  capture_device_down: { glyph: '!', tone: 'bad' },
  capture_device_recovered: { glyph: '✓', tone: 'ok' },
  message: { glyph: '"', tone: 'idle' },
  artifact_comment: { glyph: '"', tone: 'idle' },
};

export interface InboxRow {
  id: string;
  title: string;
  /** The kind's word: `Question`. */
  kind: string;
  glyph: string;
  tone: InboxTone;
  projectName: string | null;
  projectId: string | null;
  sessionId: string | null;
  /** The notification's body: the question text, the error. May be empty. */
  body: string;
  /** The web path that opens the subject. */
  url: string;
  read: boolean;
  needsYou: boolean;
  createdMs: number;
}

export function toInboxRow(n: InboxNotification): InboxRow {
  const mark = KIND_MARK[n.kind] ?? { glyph: '·', tone: 'idle' as const };
  return {
    id: n.id,
    title: n.title || KIND_LABEL[n.kind] || n.kind,
    kind: KIND_LABEL[n.kind] ?? n.kind,
    glyph: mark.glyph,
    tone: mark.tone,
    projectName: n.project_name,
    projectId: n.project_id,
    sessionId: n.session_id,
    body: n.body ?? '',
    url: n.url,
    read: n.read,
    needsYou: NEEDS_YOU.has(n.kind),
    createdMs: Date.parse(n.created_at),
  };
}

/** The rows a filter shows, in the inbox order (newest first). Unread first inside `needs`, as the web does. */
export function filterRows(rows: readonly InboxRow[], filter: InboxFilter): InboxRow[] {
  if (filter === 'unread') return rows.filter((row) => !row.read);
  if (filter === 'needs') {
    return rows.filter((row) => row.needsYou).sort((a, b) => Number(a.read) - Number(b.read));
  }
  return [...rows];
}

export function nextFilter(filter: InboxFilter): InboxFilter {
  const at = FILTER_ORDER.indexOf(filter);
  return FILTER_ORDER[(at + 1) % FILTER_ORDER.length] ?? 'all';
}

/** The badge text: the count, clamped at `99+`. */
export function badgeCount(count: number): string {
  return count > 99 ? '99+' : String(count);
}

/**
 * `url` without `?notification=<id>`. The row is marked read through the API,
 * so the page it opens has nothing left to mark.
 */
export function withoutNotificationParam(url: string): string {
  try {
    const parsed = new URL(url, 'http://kortix.invalid');
    parsed.searchParams.delete('notification');
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return url;
  }
}

export type InboxTarget = { kind: 'session'; sessionId: string } | { kind: 'web'; url: string };

/**
 * Where Enter goes. A session of the current project opens inside the TUI.
 * Anything else (another project, an automation alert, an artifact) opens on
 * the web: `onOpenSession` can only switch within the active project.
 */
export function targetOf(
  row: Pick<InboxRow, 'sessionId' | 'projectId' | 'url'>,
  currentProjectId: string | null,
  webBaseUrl: string,
): InboxTarget {
  if (row.sessionId && row.projectId && row.projectId === currentProjectId) {
    return { kind: 'session', sessionId: row.sessionId };
  }
  return { kind: 'web', url: webUrlOf(row.url, webBaseUrl) };
}

export function webUrlOf(url: string, webBaseUrl: string): string {
  return `${webBaseUrl.replace(/\/+$/, '')}${withoutNotificationParam(url)}`;
}
