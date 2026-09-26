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

import { sessionParentId } from '@kortix/sdk';

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
 * What a search matches (KRTX-250): the display title, the agent name, and
 * the session id, lowercased. Web's haystack (`sessionSearchText`) adds owner,
 * branch and source fields the mobile row never shows; a match on a field
 * the user cannot see reads as a wrong result, so mobile keeps these three.
 */
export function sessionSearchText(session: ProjectSession): string {
  return [sessionDisplayTitle(session), session.agent_name, session.session_id]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(' ')
    .toLowerCase();
}

/**
 * Trimmed, case-insensitive substring match on `sessionSearchText`. An empty
 * (or whitespace-only) query returns `sessions` unchanged.
 */
export function filterSessionsBySearch(
  sessions: ProjectSession[],
  query: string,
): ProjectSession[] {
  const trimmed = query.trim();
  if (!trimmed) return sessions;
  const needle = trimmed.toLowerCase();
  return sessions.filter((session) => sessionSearchText(session).includes(needle));
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
  'stopped',
  'failed',
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

/** True when a search or a status filter hides some sessions. */
export function isSessionFilterActive(
  query: string,
  statuses: ReadonlySet<SessionStatusFilter>,
): boolean {
  return query.trim().length > 0 || statuses.size > 0;
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

// ── Sub-agent (coordinator) grouping ────────────────────────────────────────

/** A coordinator (parent agent) session plus the sub-agent sessions it spawned. */
export interface SessionGroup {
  session: ProjectSession;
  children: ProjectSession[];
}

/**
 * Fold a flat, already-ordered session list into coordinator groups: a
 * session spawned by another session in `sessions`
 * (`metadata.spawned_by_session`, read through `sessionParentId` from
 * `@kortix/sdk`) nests under it as a sub-agent session — the drawer and the
 * Sessions page render the coordinator as a parent row and its children
 * indented beneath it.
 *
 * Ported from web's `groupSessionsByCoordinator`
 * (`apps/web/src/features/workspace/project-sidebar/project-session-list-helpers.ts`),
 * with one deliberate improvement: web's version only nests ONE level —
 * `groups` is built solely from top-level (parentless) sessions, so a
 * grandchild (a session spawned by a session that is itself a child) has no
 * entry to nest under and silently vanishes from the list. This port instead
 * resolves every session to its topmost ancestor STILL PRESENT in `sessions`
 * (`rootIdOf`, cycle-safe) and nests it there, so a deeper chain flattens
 * under its real root instead of disappearing. Behaviour is identical to web
 * for the common one-level case (a coordinator with direct children).
 *
 * A child whose coordinator is absent from `sessions` — deleted, a different
 * project, or simply not loaded onto this page yet, since the Sessions page
 * and the drawer both load sessions a page at a time and a parent can land on
 * a LATER page than its child — stays top-level rather than disappearing.
 * Membership is recomputed fresh from `sessions` on every call, so a session
 * that was an orphan on one render re-nests automatically once its
 * coordinator's page has loaded.
 *
 * Order is preserved: top-level groups appear in the order their session
 * first appears in `sessions`; a group's children appear in that same overall
 * order too. Never mutates `sessions`.
 */
export function groupSessionsByCoordinator(sessions: ProjectSession[]): SessionGroup[] {
  const present = new Set(sessions.map((session) => session.session_id));
  const parentBySessionId = new Map<string, string | null>();
  for (const session of sessions) {
    const parent = sessionParentId(session);
    parentBySessionId.set(session.session_id, parent && present.has(parent) ? parent : null);
  }

  // Walk the parent chain to the topmost ancestor still present in
  // `sessions`. `seen` stops a cycle (metadata pointing back into its own
  // chain) at the first repeat instead of looping forever.
  const rootIdOf = (sessionId: string): string => {
    let current = sessionId;
    const seen = new Set<string>([current]);
    for (;;) {
      const parent = parentBySessionId.get(current) ?? null;
      if (!parent || seen.has(parent)) return current;
      seen.add(parent);
      current = parent;
    }
  };

  const groups = new Map<string, SessionGroup>();
  const order: SessionGroup[] = [];
  for (const session of sessions) {
    if (parentBySessionId.get(session.session_id)) continue;
    const group: SessionGroup = { session, children: [] };
    groups.set(session.session_id, group);
    order.push(group);
  }
  for (const session of sessions) {
    if (!parentBySessionId.get(session.session_id)) continue;
    groups.get(rootIdOf(session.session_id))?.children.push(session);
  }
  return order;
}

/** One row of a flattened coordinator tree: a session plus whether it renders
 *  indented under its coordinator, with the sub-agent mark. */
export interface SessionListRow {
  session: ProjectSession;
  /** True for a sub-agent session rendered under its coordinator. */
  nested: boolean;
}

/**
 * Flattens `groupSessionsByCoordinator`'s tree into one linear list — a
 * coordinator row immediately followed by its sub-agent sessions' rows — for
 * a flat-list UI with no tree renderer (the project drawer's `FlatList`).
 * Preserves `groupSessionsByCoordinator`'s order.
 */
export function flattenSessionGroups(sessions: ProjectSession[]): SessionListRow[] {
  const rows: SessionListRow[] = [];
  for (const group of groupSessionsByCoordinator(sessions)) {
    rows.push({ session: group.session, nested: false });
    for (const child of group.children) rows.push({ session: child, nested: true });
  }
  return rows;
}

// ── OpenCode sub-sessions ──────────────────────────────────────────────────

/** One entry of a project session's OpenCode snapshot (`opencode_sessions[]`). */
export type ProjectRuntimeSession = ProjectSession['opencode_sessions'][number];

/** What a sub-session row shows when OpenCode has not titled it (web: 'Sub-session'). */
export const SUB_SESSION_FALLBACK_TITLE = 'Sub-session';

/**
 * The root OpenCode session a project session is pinned to: the entry whose
 * id is `opencode_session_id`, else (no pin yet) the first parentless entry.
 * A pin that is not in the snapshot yields null. Port of web's
 * `rootOpenCodeSession` (`apps/web/src/components/projects/session-label.ts`).
 */
export function rootOpenCodeSession(session: ProjectSession): ProjectRuntimeSession | null {
  const openCodeSessions = session.opencode_sessions ?? [];
  const rootId = session.opencode_session_id;
  if (rootId) return openCodeSessions.find((item) => item.id === rootId) ?? null;
  return openCodeSessions.find((item) => !item.parent_id) ?? null;
}

/**
 * Direct, non-archived children of the root OpenCode session (the agent's
 * sub-agents), newest `updated_at` first; a missing time counts as 0 and ties
 * break on id, so the order never churns between refetches. A child of a
 * child is not included. Port of web's `directSubsessions`. Never mutates
 * `opencode_sessions`.
 */
export function directSubsessions(session: ProjectSession): ProjectRuntimeSession[] {
  const root = rootOpenCodeSession(session);
  if (!root) return [];
  return (session.opencode_sessions ?? [])
    .filter((item) => item.parent_id === root.id && !item.archived_at)
    .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0) || a.id.localeCompare(b.id));
}

/** A sub-session row's title: OpenCode's title, trimmed, else `SUB_SESSION_FALLBACK_TITLE`. */
export function subsessionTitle(child: ProjectRuntimeSession): string {
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
