/**
 * session-list — the mobile-only pieces of the project session list. Every
 * shared rule (title, status, last activity, `shortRelative`, activity
 * sections, the status filter, OpenCode sub-sessions) is the SDK's
 * (`@kortix/sdk`, `core/session/session-list.ts`); this module holds what only
 * this app shows: spoken times for the screen reader, the sub-session row
 * title, the thread's owner lookup, the count badge rule and the filter chip.
 *
 * Pure data and pure functions only: `bun test` cannot load native modules.
 */

import {
  SESSION_LIST_STATUS,
  SESSION_STATUS_FILTERS,
  type ProjectOpenCodeSession,
  type SessionListStatus,
  type SessionStatusFilter,
} from '@kortix/sdk';

import type { ProjectSession } from '@/lib/projects/projects-client';

/** Sentence-case name of a list status, for accessibility labels and the filter sheet. */
export function sessionStatusLabel(status: SessionListStatus): string {
  return SESSION_LIST_STATUS[status].label;
}

/** The picked statuses as the filter chip reads them, in sheet order: "Needs you, Failed". */
export function sessionStatusFilterSummary(statuses: ReadonlySet<SessionStatusFilter>): string {
  return SESSION_STATUS_FILTERS.filter((status) => statuses.has(status))
    .map(sessionStatusLabel)
    .join(', ');
}

// ── Spoken relative time ──────────────────────────────────────────────────

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MONTH_MS = 30 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;

function countOf(value: number, unit: string): string {
  return `${value} ${unit}${value === 1 ? '' : 's'} ago`;
}

/**
 * The spoken form of the SDK's `shortRelative`, for screen readers: "5m" reads
 * as "5 meters". Same buckets, words spelled out ("5 minutes ago"); under a
 * minute, or in the future, is "just now".
 */
export function spokenRelative(ms: number, now: number): string {
  const diff = now - ms;
  if (diff < MINUTE_MS) return 'just now';
  if (diff < HOUR_MS) return countOf(Math.floor(diff / MINUTE_MS), 'minute');
  if (diff < DAY_MS) return countOf(Math.floor(diff / HOUR_MS), 'hour');
  if (diff < MONTH_MS) return countOf(Math.floor(diff / DAY_MS), 'day');
  if (diff < YEAR_MS) return countOf(Math.floor(diff / MONTH_MS), 'month');
  return countOf(Math.floor(diff / YEAR_MS), 'year');
}

// ── OpenCode sub-sessions ──────────────────────────────────────────────────

/** What a sub-session row shows when OpenCode has not titled it (web: 'Sub-session'). */
export const SUB_SESSION_FALLBACK_TITLE = 'Sub-session';

/** A sub-session row's title: OpenCode's title, trimmed, else `SUB_SESSION_FALLBACK_TITLE`. */
export function subsessionTitle(child: ProjectOpenCodeSession): string {
  return child.title?.trim() || SUB_SESSION_FALLBACK_TITLE;
}

/**
 * The project session that owns an id the thread shows. The tab store's
 * active id is an OpenCode id: the root (a thread opened from a list), or a
 * sub-session (a drawer sub-session row, or a task tool's View). Match order:
 * a project session id or root pin first, then any entry of a row's
 * `opencode_sessions` snapshot — every sub-session runs in its parent's
 * sandbox, so the parent row owns it. Null for null or an unknown id.
 */
export function projectSessionForOpenCodeId(
  sessions: readonly ProjectSession[],
  openCodeId: string | null,
): ProjectSession | null {
  if (!openCodeId) return null;
  const direct = sessions.find(
    (session) => session.opencode_session_id === openCodeId || session.session_id === openCodeId,
  );
  if (direct) return direct;
  return (
    sessions.find((session) => (session.opencode_sessions ?? []).some((item) => item.id === openCodeId)) ??
    null
  );
}

/**
 * The count badge after a session title shows only above this many direct
 * sub-sessions (owner, 2026-09-26): a short list under the row already reads
 * its own length, a long one does not.
 */
export const SUBSESSION_COUNT_BADGE_THRESHOLD = 4;

/** True when a row shows its sub-session count badge: more than `SUBSESSION_COUNT_BADGE_THRESHOLD`. */
export function showSubsessionCountBadge(count: number): boolean {
  return Number.isFinite(count) && count > SUBSESSION_COUNT_BADGE_THRESHOLD;
}
