/**
 * session-list — pure helpers for the project Sessions page: display title,
 * display status, last-activity resolution, relative-time formatting,
 * activity-bucket grouping, search, and status filtering. Ported from the web sidebar
 * (`apps/web/src/features/workspace/project-sidebar/project-session-list-helpers.ts`,
 * `session-grouping.ts`, and `apps/web/src/components/projects/session-label.ts`)
 * so the mobile Sessions page renders the same title/status/grouping logic.
 *
 * Pure data and pure functions only. No React, no React Native, no expo, no
 * icons, no zustand — this module is unit-tested under `bun test`, which
 * cannot load native modules.
 */

import {
  SESSION_LIST_STATUS,
  sessionListStatus,
  sessionParentId,
  type SessionListStatus,
} from '@kortix/sdk';

import type { ProjectSession } from '@/lib/projects/projects-client';

// ── Display title ────────────────────────────────────────────────────────

/** What a row shows before the server has written any name for the session. */
export const UNTITLED_SESSION_LABEL = 'New session';

/** The session's real name, or null while the server has not written one.
 *  Precedence: user rename (`custom_name`) → server name → legacy
 *  `metadata.session_name`. Mirrors `resolveSessionTitle` on web. */
export function resolveSessionTitle(session: ProjectSession): string | null {
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

/**
 * What a list shows for a session. The resolution and the words are the SDK's
 * (`sessionListStatus`, `SESSION_LIST_STATUS`), the ones web shows: a finished
 * session reads "Done" on both, never "Stopped", and a migrated session that
 * has not run reads "Legacy". A pending review wins outright.
 */
export type SessionDisplayStatus = SessionListStatus;

/** Resolve a session to its display status (`sessionListStatus`). */
export function sessionDisplayStatus(
  session: ProjectSession,
  reviewCount = 0,
): SessionDisplayStatus {
  return sessionListStatus(session, reviewCount);
}

/** Sentence-case name of a display status, for accessibility labels and the filter sheet. */
export function sessionStatusLabel(status: SessionDisplayStatus): string {
  return SESSION_LIST_STATUS[status].label;
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

/** Newest conversation update in the runtime's scoped session snapshot
 *  (`runtime_sessions[].updated_at`, already epoch ms), or null when the
 *  session carries no usable snapshot. */
function conversationActivityMs(session: ProjectSession): number | null {
  let latest: number | null = null;
  for (const runtimeSession of session.runtime_sessions ?? session.opencode_sessions ?? []) {
    const parsed = activityMs(runtimeSession.updated_at);
    if (parsed === null) continue;
    latest = latest === null ? parsed : Math.max(latest, parsed);
  }
  return latest;
}

/**
 * The latest real activity for a session, in epoch ms. Newest evidence first:
 *
 *   1. `metadata.last_activity_at` — the API's prompt stamp.
 *   2. `runtime_sessions[].updated_at` — the runtime's conversation snapshot.
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

// ── Status filter ─────────────────────────────────────────────────────────

/** A status the filter sheet offers. `starting` is not one: Running covers it. */
export type SessionStatusFilter = Exclude<SessionDisplayStatus, 'starting'>;

/**
 * Every status the Sessions page's filter sheet offers, in display order.
 * No Starting option (KRTX-250, web parity): Running matches starting
 * sessions too, so a session that is still booting never falls between two
 * options.
 */
export const SESSION_STATUS_FILTERS: SessionStatusFilter[] = [
  'needs-you',
  'running',
  'done',
  'stopped',
  'failed',
  'legacy',
];

/**
 * Keeps only sessions whose display status is in `statuses`. An empty set
 * means "no filter": every session passes, same as an untouched filter sheet.
 * `running` also matches `starting` (web's `matchesStatusFilters`).
 * `needsYou` (session id → pending inbox items, `needsYouBySession`) resolves
 * the sessions that wait on the user to `needs-you`; such a session matches
 * Needs you only, the same mark its row shows.
 */
export function filterSessionsByStatus(
  sessions: ProjectSession[],
  statuses: ReadonlySet<SessionStatusFilter>,
  needsYou?: ReadonlyMap<string, { count: number }>,
): ProjectSession[] {
  if (statuses.size === 0) return sessions;
  return sessions.filter((session) => {
    const display = sessionDisplayStatus(session, needsYou?.get(session.session_id)?.count ?? 0);
    return display === 'starting' ? statuses.has('running') : statuses.has(display);
  });
}

/** The picked statuses as the filter chip reads them, in sheet order: "Needs you, Failed". */
export function sessionStatusFilterSummary(statuses: ReadonlySet<SessionStatusFilter>): string {
  return SESSION_STATUS_FILTERS.filter((status) => statuses.has(status))
    .map(sessionStatusLabel)
    .join(', ');
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

// ── Sub-sessions ───────────────────────────────────────────────────────────
// The tree itself (`rootRuntimeSession`, `directSubsessions`,
// `projectSessionForRuntimeId`) is the SDK's, shared with web.

/** One conversation of a project session's runtime tree (`runtime_sessions[]`). */
export type ProjectRuntimeSession = NonNullable<ProjectSession['runtime_sessions']>[number];

/** What a sub-session row shows when the runtime has not titled it (web: 'Sub-session'). */
export const SUB_SESSION_FALLBACK_TITLE = 'Sub-session';

/** A sub-session row's title: the runtime's title, trimmed, else `SUB_SESSION_FALLBACK_TITLE`. */
export function subsessionTitle(child: ProjectRuntimeSession): string {
  return child.title?.trim() || SUB_SESSION_FALLBACK_TITLE;
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
