import type { ProjectSession } from '@kortix/sdk';

import { sessionDisplayStatus, sessionSource } from '@/components/projects/session-label';

import { getSessionDisplayTitle, sessionLastActivityAt } from './project-session-list-helpers';

/**
 * General session grouper behind the sidebar's `Grouping ›` / `Ordering ›`
 * filter menu. Four grouping modes, three ordering modes, all composable.
 *
 * `status` mode is the sidebar's original three-section split: membership is
 * decided by display status, and `needs-you` wins outright over every other
 * signal.
 *
 * `activity` and `source` modes do NOT give review state that same veto —
 * review-pending sessions group by their date or their source like any other
 * session, and the review state itself shows on the row's status dot.
 */

export type SessionGroupMode = 'status' | 'activity' | 'source' | 'none';
export type SessionOrderMode = 'activity' | 'created' | 'name';

export const SESSION_GROUP_MODES: Array<{ value: SessionGroupMode; label: string }> = [
  { value: 'status', label: 'Status' },
  { value: 'activity', label: 'Activity' },
  { value: 'source', label: 'Source' },
  { value: 'none', label: 'None' },
];

export const SESSION_ORDER_MODES: Array<{ value: SessionOrderMode; label: string }> = [
  { value: 'activity', label: 'Last activity' },
  { value: 'created', label: 'Date created' },
  { value: 'name', label: 'Name' },
];

/** Status-mode section ids — kept as its own union for callers that only ever
 *  see status-mode sections. */
export type SessionSectionId = 'needs-you' | 'running' | 'recent';

export interface SessionSection {
  /** Stable across renders — the store keys collapsed/hidden state by it. */
  id: string;
  label: string;
  /** Open-ended tails (recent/older/all) don't get a count: it's noise. */
  showCount: boolean;
  sessions: ProjectSession[];
}

export interface GroupedSessions {
  sections: SessionSection[];
  /** False when at most one section is populated: a header divides, and one
   *  header divides nothing. Keeps a new project from looking like chrome. */
  showHeaders: boolean;
}

const STATUS_SECTION_ORDER: Array<{ id: SessionSectionId; label: string; showCount: boolean }> = [
  { id: 'needs-you', label: 'Needs you', showCount: true },
  { id: 'running', label: 'Running', showCount: true },
  { id: 'recent', label: 'Recent', showCount: false },
];

type ActivityBucketId = 'today' | 'yesterday' | 'week' | 'older';

const ACTIVITY_SECTION_ORDER: Array<{ id: ActivityBucketId; label: string; showCount: boolean }> = [
  { id: 'today', label: 'Today', showCount: true },
  { id: 'yesterday', label: 'Yesterday', showCount: true },
  { id: 'week', label: 'This week', showCount: true },
  { id: 'older', label: 'Older', showCount: false },
];

const SOURCE_SECTION_ORDER: Array<{ id: string; label: string; showCount: boolean }> = [
  { id: 'chat', label: 'Chat', showCount: true },
  { id: 'slack', label: 'Slack', showCount: true },
  { id: 'telegram', label: 'Telegram', showCount: true },
  { id: 'email', label: 'Email', showCount: true },
  { id: 'schedule', label: 'Scheduled', showCount: true },
  { id: 'webhook', label: 'Webhook', showCount: true },
];

const NONE_SECTION_ORDER: Array<{ id: string; label: string; showCount: boolean }> = [
  { id: 'all', label: 'All', showCount: false },
];

const DAY_MS = 24 * 60 * 60 * 1000;

/** Midnight, in the viewer's LOCAL timezone, of the calendar day containing
 *  `ms`. Local calendar components (`getFullYear`/`getMonth`/`getDate`), not
 *  UTC — a row labelled "Today" means today on the viewer's own clock, not a
 *  rolling 24h window from whatever instant they happened to look. */
function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Which activity bucket a timestamp falls into, against calendar-day
 *  boundaries computed ONCE by the caller (never inside a per-session
 *  predicate) from a caller-supplied `now` — never `Date.now()` — so grouping
 *  is deterministic and every session lands in exactly one bucket regardless
 *  of what time the viewer happens to look. A future/skewed timestamp is
 *  `>= todayStart` and lands in `today` rather than falling out of every
 *  bucket. */
function activityBucketFor(
  activityMs: number,
  todayStart: number,
  yesterdayStart: number,
  weekStart: number,
): ActivityBucketId {
  if (activityMs >= todayStart) return 'today';
  if (activityMs >= yesterdayStart) return 'yesterday';
  if (activityMs >= weekStart) return 'week';
  return 'older';
}

function statusBucketFor(session: ProjectSession, reviewCount: number): SessionSectionId {
  const display = sessionDisplayStatus(session, reviewCount);
  if (display === 'needs-you') return 'needs-you';
  if (display === 'running' || display === 'starting') return 'running';
  return 'recent';
}

function orderComparator(
  order: SessionOrderMode,
  lastActivityMsBySession: Map<string, number>,
): (a: ProjectSession, b: ProjectSession) => number {
  if (order === 'created') {
    return (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  }
  if (order === 'name') {
    return (a, b) =>
      getSessionDisplayTitle(a).localeCompare(getSessionDisplayTitle(b), undefined, {
        sensitivity: 'base',
      });
  }
  // Mirrors sortSessionsByLastActivity's guard: an unparseable date sorts as
  // 0 rather than NaN, which would otherwise produce an unstable order.
  return (a, b) =>
    (lastActivityMsBySession.get(b.session_id) ?? 0) -
    (lastActivityMsBySession.get(a.session_id) ?? 0);
}

/**
 * Split `sessions` into sections per `options.mode`, ordered within each
 * section per `options.order`. Never mutates `sessions`.
 *
 * Section order always comes from a declared constant for the mode — never
 * from iteration order over the data — so the sidebar renders sections in a
 * stable, predictable sequence regardless of which sessions happen to exist.
 */
export function groupSessions(
  sessions: ProjectSession[],
  options: {
    mode: SessionGroupMode;
    order: SessionOrderMode;
    reviewCountBySession: Record<string, number>;
    hiddenSections?: readonly string[];
    now?: number;
  },
): GroupedSessions {
  const { mode, order, reviewCountBySession, hiddenSections, now = Date.now() } = options;
  const hidden = new Set(hiddenSections ?? []);

  // Precompute last-activity once per session (decorate-sort-undecorate):
  // sessionLastActivityAt re-scans opencode_sessions, so calling it inside a
  // comparator would repeat that scan O(n log n) times instead of O(n).
  // Same NaN guard as sortSessionsByLastActivity — an unparseable date reads
  // as 0, not NaN.
  const lastActivityMsBySession = new Map<string, number>();
  for (const session of sessions) {
    const parsed = new Date(sessionLastActivityAt(session)).getTime();
    lastActivityMsBySession.set(session.session_id, Number.isFinite(parsed) ? parsed : 0);
  }

  const ordered = sessions.slice().sort(orderComparator(order, lastActivityMsBySession));

  // Calendar-day boundaries, resolved once against `now` — never inside the
  // per-session bucket function below.
  const todayStart = startOfLocalDay(now);
  const yesterdayStart = todayStart - DAY_MS;
  const weekStart = todayStart - 7 * DAY_MS;

  const declared =
    mode === 'status'
      ? STATUS_SECTION_ORDER
      : mode === 'activity'
        ? ACTIVITY_SECTION_ORDER
        : mode === 'source'
          ? SOURCE_SECTION_ORDER
          : NONE_SECTION_ORDER;

  const buckets = new Map<string, ProjectSession[]>(declared.map((section) => [section.id, []]));

  for (const session of ordered) {
    const bucketId: string =
      mode === 'status'
        ? statusBucketFor(session, reviewCountBySession[session.session_id] ?? 0)
        : mode === 'activity'
          ? activityBucketFor(
              lastActivityMsBySession.get(session.session_id) ?? 0,
              todayStart,
              yesterdayStart,
              weekStart,
            )
          : mode === 'source'
            ? sessionSource(session).kind
            : 'all';
    buckets.get(bucketId)?.push(session);
  }

  const sections = declared
    .filter((section) => !hidden.has(section.id) && (buckets.get(section.id)?.length ?? 0) > 0)
    .map((section) => ({ ...section, sessions: buckets.get(section.id) ?? [] }));

  return { sections, showHeaders: sections.length > 1 };
}
