/**
 * session-list — pure helpers for the project Sessions page: display title,
 * display status, last-activity resolution, relative-time formatting,
 * activity-bucket grouping, and title search. Ported from the web sidebar
 * (`apps/web/src/features/workspace/project-sidebar/project-session-list-helpers.ts`,
 * `session-grouping.ts`, and `apps/web/src/components/projects/session-label.ts`)
 * so the mobile Sessions page renders the same title/status/grouping logic.
 *
 * Pure data and pure functions only. No React, no React Native, no expo, no
 * lucide, no zustand — this module is unit-tested under `bun test`, which
 * cannot load native modules.
 */

import type { ProjectSession } from '@/lib/projects/projects-client';

// ── Display title ────────────────────────────────────────────────────────

/** What a row shows before the server has written any name for the session. */
export const UNTITLED_SESSION_LABEL = 'New session';

/** The session's real name, or null while the server has not written one.
 *  Precedence: user rename (`custom_name`) → server name → legacy
 *  `metadata.session_name`. Mirrors `resolveSessionTitle` on web. */
function resolveSessionTitle(session: ProjectSession): string | null {
  const metadata = session.metadata as Record<string, unknown> | null | undefined;
  const legacyMetadataName = typeof metadata?.session_name === 'string' ? metadata.session_name : null;
  return session.custom_name?.trim() || session.name?.trim() || legacyMetadataName?.trim() || null;
}

/**
 * Display title for a session row. Precedence: user rename → server name →
 * legacy metadata.session_name → `UNTITLED_SESSION_LABEL`.
 */
export function sessionDisplayTitle(session: ProjectSession): string {
  return resolveSessionTitle(session) ?? UNTITLED_SESSION_LABEL;
}

// ── Display status ───────────────────────────────────────────────────────

export type SessionDisplayStatus = 'starting' | 'running' | 'stopped' | 'failed' | 'needs-you';

/**
 * Resolve a session to its display status. A pending review wins outright
 * over every lifecycle status, mirroring web's `sessionDisplayStatus`
 * precedence. `reviewCount` defaults to 0 for callers with no review-request
 * data available yet.
 *
 * Web additionally distinguishes `done` (completed) from `stopped`, and a
 * `legacy` migrated-session state. This task's `SessionDisplayStatus` union
 * (set by the brief) has neither, so `completed` and `stopped` both collapse
 * to `stopped` here, and legacy-migration status is not tracked. See the
 * task report for this difference.
 */
export function sessionDisplayStatus(
  session: ProjectSession,
  reviewCount = 0,
): SessionDisplayStatus {
  if (reviewCount > 0) return 'needs-you';
  switch (session.status) {
    case 'queued':
    case 'branching':
    case 'provisioning':
      return 'starting';
    case 'running':
      return 'running';
    case 'completed':
    case 'stopped':
      return 'stopped';
    case 'failed':
      return 'failed';
    default:
      return 'stopped';
  }
}

const SESSION_STATUS_LABELS: Record<SessionDisplayStatus, string> = {
  starting: 'Starting',
  running: 'Running',
  stopped: 'Stopped',
  failed: 'Failed',
  'needs-you': 'Needs you',
};

/** Sentence-case name of a display status, for accessibility labels. */
export function sessionStatusLabel(status: SessionDisplayStatus): string {
  return SESSION_STATUS_LABELS[status];
}

// ── Last activity ────────────────────────────────────────────────────────

/** Epoch ms from an ISO string or an epoch-ms number, or null. `metadata` is
 *  loosely typed, so its values arrive as `unknown` and must be proven, not
 *  asserted. */
function activityMs(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** When the API last accepted a prompt for this session
 *  (`metadata.last_activity_at`). */
function promptActivityMs(session: ProjectSession): number | null {
  const metadata = session.metadata as Record<string, unknown> | null | undefined;
  return activityMs(metadata?.last_activity_at);
}

/** Newest conversation update in OpenCode's scoped session snapshot
 *  (`opencode_sessions[].updated_at`, already epoch ms), or null when the
 *  session carries no usable snapshot. */
function conversationActivityMs(session: ProjectSession): number | null {
  let latest: number | null = null;
  for (const openCodeSession of session.opencode_sessions ?? []) {
    const parsed = activityMs(openCodeSession.updated_at);
    if (parsed === null) continue;
    latest = latest === null ? parsed : Math.max(latest, parsed);
  }
  return latest;
}

/**
 * The latest real activity for a session, in epoch ms. Newest evidence first:
 *
 *   1. `metadata.last_activity_at` — the API's prompt stamp.
 *   2. `opencode_sessions[].updated_at` — OpenCode's conversation snapshot.
 *   3. `updated_at` — row bookkeeping, reached only when neither signal
 *      above exists.
 *   4. `created_at` — last resort.
 *
 * Mirrors `sessionLastActivityAt` on web, except this returns epoch ms
 * directly instead of an ISO string (per the task brief), so mobile callers
 * never re-parse a string this module already parsed.
 */
export function sessionLastActivityAt(session: ProjectSession): number {
  const prompt = promptActivityMs(session);
  const conversation = conversationActivityMs(session);
  if (prompt !== null || conversation !== null) {
    return Math.max(prompt ?? -Infinity, conversation ?? -Infinity);
  }
  const fallback = activityMs(session.updated_at) ?? activityMs(session.created_at);
  return fallback ?? 0;
}

// ── Relative time ────────────────────────────────────────────────────────

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MONTH_MS = 30 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;

/**
 * Compresses the gap between `ms` and `now` down to the sidebar's
 * fixed-width form ("5m", "2h", "3d", "2mo", "1y") so the relative-time
 * column never reflows the row. Anything under a minute — including a
 * future/skewed timestamp — collapses to "now".
 */
export function shortRelative(ms: number, now: number): string {
  const diff = now - ms;
  if (diff < MINUTE_MS) return 'now';
  if (diff < HOUR_MS) return `${Math.floor(diff / MINUTE_MS)}m`;
  if (diff < DAY_MS) return `${Math.floor(diff / HOUR_MS)}h`;
  if (diff < MONTH_MS) return `${Math.floor(diff / DAY_MS)}d`;
  if (diff < YEAR_MS) return `${Math.floor(diff / MONTH_MS)}mo`;
  return `${Math.floor(diff / YEAR_MS)}y`;
}

function countOf(value: number, unit: string): string {
  return `${value} ${unit}${value === 1 ? '' : 's'} ago`;
}

/**
 * The spoken form of `shortRelative`, for screen readers: "5m" reads as
 * "5 meters". Same buckets, words spelled out ("5 minutes ago"); under a
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

// ── Activity grouping ────────────────────────────────────────────────────

export type SessionActivitySectionId = 'today' | 'yesterday' | 'week' | 'older';

export interface SessionActivitySection {
  id: SessionActivitySectionId;
  label: string;
  sessions: ProjectSession[];
}

export interface GroupedSessionsByActivity {
  sections: SessionActivitySection[];
  /** False when at most one section is populated: a header divides, and one
   *  header divides nothing. */
  showHeaders: boolean;
}

const ACTIVITY_SECTION_ORDER: Array<{ id: SessionActivitySectionId; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'week', label: 'This week' },
  { id: 'older', label: 'Older' },
];

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** Midnight, in the viewer's LOCAL timezone, of the calendar day containing
 *  `ms`. Local calendar components, not UTC — a row labelled "Today" means
 *  today on the viewer's own clock. */
function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Which activity bucket a timestamp falls into, against calendar-day
 *  boundaries computed once by the caller from a caller-supplied `now`. A
 *  future/skewed timestamp is `>= todayStart` and lands in `today`. */
function activityBucketFor(
  ms: number,
  todayStart: number,
  yesterdayStart: number,
  weekStart: number,
): SessionActivitySectionId {
  if (ms >= todayStart) return 'today';
  if (ms >= yesterdayStart) return 'yesterday';
  if (ms >= weekStart) return 'week';
  return 'older';
}

/**
 * Split `sessions` into Today / Yesterday / This week / Older sections,
 * newest-first within each section by `sessionLastActivityAt`. Never mutates
 * `sessions`. Empty sections are omitted; `showHeaders` is true only when
 * more than one section has sessions.
 */
export function groupSessionsByActivity(
  sessions: ProjectSession[],
  now: number,
): GroupedSessionsByActivity {
  const lastActivityBySession = new Map<string, number>();
  for (const session of sessions) {
    lastActivityBySession.set(session.session_id, sessionLastActivityAt(session));
  }

  const ordered = sessions.slice().sort((a, b) => {
    const aTime = lastActivityBySession.get(a.session_id) ?? 0;
    const bTime = lastActivityBySession.get(b.session_id) ?? 0;
    return bTime - aTime;
  });

  const todayStart = startOfLocalDay(now);
  const yesterdayStart = todayStart - ONE_DAY_MS;
  const weekStart = todayStart - 7 * ONE_DAY_MS;

  const buckets = new Map<SessionActivitySectionId, ProjectSession[]>(
    ACTIVITY_SECTION_ORDER.map((section) => [section.id, []]),
  );

  for (const session of ordered) {
    const bucketId = activityBucketFor(
      lastActivityBySession.get(session.session_id) ?? 0,
      todayStart,
      yesterdayStart,
      weekStart,
    );
    buckets.get(bucketId)?.push(session);
  }

  const sections: SessionActivitySection[] = [];
  for (const section of ACTIVITY_SECTION_ORDER) {
    const bucket = buckets.get(section.id) ?? [];
    if (bucket.length === 0) continue;
    sections.push({ ...section, sessions: bucket });
  }

  return { sections, showHeaders: sections.length > 1 };
}

// ── Search ────────────────────────────────────────────────────────────────

/**
 * Trimmed, case-insensitive substring match on `sessionDisplayTitle`. An
 * empty (or whitespace-only) query returns `sessions` unchanged.
 */
export function filterSessionsByTitle(
  sessions: ProjectSession[],
  query: string,
): ProjectSession[] {
  const trimmed = query.trim();
  if (!trimmed) return sessions;
  const needle = trimmed.toLowerCase();
  return sessions.filter((session) => sessionDisplayTitle(session).toLowerCase().includes(needle));
}

// ── Recent sessions ───────────────────────────────────────────────────────

/**
 * The newest `limit` sessions by `sessionLastActivityAt`, newest first. Never
 * mutates `sessions`. The project sidebar lists these; the Sessions page
 * lists every session.
 */
export function recentSessions(sessions: ProjectSession[], limit: number): ProjectSession[] {
  return sessions
    .map((session) => ({ session, at: sessionLastActivityAt(session) }))
    .sort((a, b) => b.at - a.at)
    .slice(0, limit)
    .map((entry) => entry.session);
}
