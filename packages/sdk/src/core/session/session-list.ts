/**
 * The project session LIST model — every pure decision a session list makes,
 * once, for both Kortix apps.
 *
 * After the server started nesting and attributing sessions (`parent`,
 * `initiator`, `started_by`, `q`), `apps/web` and `apps/mobile` still each kept
 * their own copy of the row rules, and the copies disagreed: only web stripped
 * Teams mention markup from titles, last activity was an ISO string on one and
 * epoch ms on the other, only mobile offered Needs you as a status filter,
 * only mobile capped the search at the 200 characters the API accepts, and the
 * two read the starter differently (mobile never used `is_owner`, so an
 * unclassified row of the viewer read "Member"). This module is the one copy.
 *
 * Framework-free and host-free: no React, no i18n, no globals. Labels are
 * English defaults a host can replace (`sessionStarter`'s `labels`) or key by a
 * stable id (`groupSessionsByActivity` section ids).
 */

import {
  PROJECT_SESSION_SEARCH_MAX_LENGTH,
  sessionParentId,
  type ListProjectSessionsOptions,
  type ProjectOpenCodeSession,
  type ProjectSession,
  type ProjectSessionInitiatorType,
} from '../rest/projects-client/sessions';
import { sessionListStatus, type SessionListStatus } from './status-vocabulary';

// ── Title ──────────────────────────────────────────────────────────────────

/** What a row shows before the server has written any name for the session. */
export const UNTITLED_SESSION_LABEL = 'New session';

/** Teams wraps a channel @-mention of the bot in `<at>…</at>`; sessions titled
 *  from such a message before the API stripped it still carry the tag. */
export function stripChatMentionMarkup(value: string): string {
  return value
    .replace(/<at[^>]*>.*?<\/at>/gi, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

type TitleFields = Pick<ProjectSession, 'custom_name' | 'name' | 'metadata'>;

function resolvedTitle(session: TitleFields): string | null {
  const legacy = typeof session.metadata?.session_name === 'string' ? session.metadata.session_name : '';
  return (
    stripChatMentionMarkup(session.custom_name ?? '') ||
    stripChatMentionMarkup(session.name ?? '') ||
    stripChatMentionMarkup(legacy) ||
    null
  );
}

/** Has the server written a name yet? The title generator runs seconds after
 *  the first prompt and announces nothing, so this is the only signal. */
export function sessionHasTitle(session: TitleFields): boolean {
  return resolvedTitle(session) !== null;
}

/** Row title: user rename → server name → legacy `metadata.session_name` →
 *  `UNTITLED_SESSION_LABEL`. */
export function sessionDisplayTitle(session: TitleFields): string {
  return resolvedTitle(session) ?? UNTITLED_SESSION_LABEL;
}

// ── Time ───────────────────────────────────────────────────────────────────

function epochMs(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The latest real activity, in epoch ms: the newer of the API's prompt stamp
 * (`metadata.last_activity_at`) and OpenCode's conversation snapshot
 * (`opencode_sessions[].updated_at`). Only when neither exists: `updated_at`
 * (row bookkeeping, which must never outrank real activity), then
 * `created_at`, then 0.
 */
export function sessionLastActivityAt(
  session: Pick<ProjectSession, 'metadata' | 'opencode_sessions' | 'updated_at' | 'created_at'>,
): number {
  const prompt = epochMs(session.metadata?.last_activity_at);
  let conversation: number | null = null;
  for (const entry of session.opencode_sessions ?? []) {
    const at = epochMs(entry.updated_at);
    if (at !== null) conversation = conversation === null ? at : Math.max(conversation, at);
  }
  if (prompt !== null || conversation !== null) return Math.max(prompt ?? -Infinity, conversation ?? -Infinity);
  return epochMs(session.updated_at) ?? epochMs(session.created_at) ?? 0;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Fixed-width relative time ("now", "5m", "2h", "3d", "2mo", "1y"). A future
 *  or skewed timestamp reads "now". */
export function shortRelative(ms: number, now: number): string {
  const diff = now - ms;
  if (diff < MINUTE_MS) return 'now';
  if (diff < HOUR_MS) return `${Math.floor(diff / MINUTE_MS)}m`;
  if (diff < DAY_MS) return `${Math.floor(diff / HOUR_MS)}h`;
  if (diff < 30 * DAY_MS) return `${Math.floor(diff / DAY_MS)}d`;
  if (diff < 365 * DAY_MS) return `${Math.floor(diff / (30 * DAY_MS))}mo`;
  return `${Math.floor(diff / (365 * DAY_MS))}y`;
}

// ── Source and starter ─────────────────────────────────────────────────────

/** The surface a session came in through. */
export type SessionSourceKind = 'chat' | 'slack' | 'telegram' | 'teams' | 'email' | 'schedule' | 'webhook';

export interface SessionSource {
  kind: SessionSourceKind;
  /** For a trigger fire: the kortix.yaml trigger slug. */
  triggerSlug: string | null;
}

const CHANNEL_SOURCES = new Set(['slack', 'telegram', 'teams', 'email']);

export function sessionSource(session: Pick<ProjectSession, 'metadata'>): SessionSource {
  const meta = session.metadata ?? {};
  const source = typeof meta.source === 'string' ? meta.source : null;
  if (source && CHANNEL_SOURCES.has(source)) return { kind: source as SessionSourceKind, triggerSlug: null };
  if (typeof meta.trigger_source === 'string') {
    const triggerSlug = typeof meta.trigger_slug === 'string' ? meta.trigger_slug : null;
    // A manual "run now" fire groups under its trigger's own kind.
    const type = typeof meta.trigger_type === 'string' ? meta.trigger_type : meta.trigger_source;
    return { kind: type === 'cron' ? 'schedule' : 'webhook', triggerSlug };
  }
  return { kind: 'chat', triggerSlug: null };
}

/** Which glyph an automated starter shows; a member shows its name only. */
export type SessionStarterIcon =
  | 'schedule'
  | 'webhook'
  | 'trigger'
  | 'slack'
  | 'teams'
  | 'telegram'
  | 'email'
  | 'channel'
  | 'api'
  | null;

export interface SessionStarter {
  type: ProjectSessionInitiatorType;
  /** "You", a member name, a trigger slug, a channel, an API key name, "Kortix". */
  label: string;
  isViewer: boolean;
  /** Member: user id · trigger: slug · channel: channel id · api: service account. */
  id: string | null;
  icon: SessionStarterIcon;
}

export interface SessionStarterLabels {
  you: string;
  /** A member with no name the viewer may see. */
  member: string;
  /** An unlabeled platform run. */
  system: string;
}

const DEFAULT_STARTER_LABELS: SessionStarterLabels = { you: 'You', member: 'Member', system: 'Kortix' };

/**
 * Who started the RUN a session belongs to, from the server-derived
 * `initiator` — never from `created_by`: a spawned worker keeps its creator's
 * ownership but shows its run's starter. A row the backfill could not classify
 * has no initiator and reads as a member, the viewer through `is_owner`.
 */
export function sessionStarter(
  session: Pick<ProjectSession, 'initiator' | 'is_owner' | 'owner_name' | 'owner_email' | 'created_by' | 'metadata'>,
  viewerId: string | null | undefined,
  labels: SessionStarterLabels = DEFAULT_STARTER_LABELS,
): SessionStarter {
  const initiator = session.initiator ?? null;
  if (!initiator || initiator.type === 'member') {
    const id = initiator?.id ?? session.created_by ?? null;
    const isViewer = initiator?.id && viewerId ? initiator.id === viewerId : session.is_owner !== false;
    const name = initiator?.label?.trim() || session.owner_name || session.owner_email || null;
    return { type: 'member', id, isViewer, icon: null, label: isViewer ? labels.you : (name ?? labels.member) };
  }
  const label = initiator.label?.trim() || initiator.id || labels.system;
  const base = { type: initiator.type, id: initiator.id, isViewer: false, label };
  switch (initiator.type) {
    case 'trigger': {
      const kind = sessionSource(session).kind;
      return { ...base, icon: kind === 'schedule' ? 'schedule' : kind === 'webhook' ? 'webhook' : 'trigger' };
    }
    case 'channel': {
      const channel = initiator.id ?? '';
      return { ...base, icon: CHANNEL_SOURCES.has(channel) ? (channel as SessionStarterIcon) : 'channel' };
    }
    case 'api':
      return { ...base, icon: 'api' };
    default:
      return { ...base, icon: null };
  }
}

/** The list section a session's run lives in, other than the viewer's own. */
export type SessionStarterSection = 'shared' | 'automated';

/** Another member's run is Shared, an automated run is Automated, the viewer's
 *  own run (or an unclassified row of theirs) is neither. */
export function starterSectionOf(
  session: Pick<ProjectSession, 'initiator' | 'is_owner'>,
  viewerId: string | null | undefined,
): SessionStarterSection | null {
  const initiator = session.initiator;
  if (!initiator) return session.is_owner === false ? 'shared' : null;
  if (initiator.type !== 'member') return 'automated';
  return initiator.id && viewerId && initiator.id !== viewerId ? 'shared' : null;
}

// ── Server filters: scope and search ───────────────────────────────────────

/** A list's starter scope, as a filter chip names it. */
export type SessionListScope = 'all' | 'mine' | 'shared' | 'automated';

/** The `started_by` a scope sends; `all` sends none. */
export function startedByForScope(scope: SessionListScope): ListProjectSessionsOptions['startedBy'] {
  if (scope === 'mine') return 'me';
  if (scope === 'shared') return 'others';
  if (scope === 'automated') return 'automated';
  return undefined;
}

/** The `q` to send for typed text: trimmed, at most the API's 200
 *  characters, and absent when blank. */
export function sessionSearchParam(text: string): string | undefined {
  const q = text.trim().slice(0, PROJECT_SESSION_SEARCH_MAX_LENGTH);
  return q || undefined;
}

// ── Status filter (client-side) ─────────────────────────────────────────────

/** A status a filter offers. No Starting option: Running covers it, so a
 *  booting session never falls between two options. */
export type SessionStatusFilter = Exclude<SessionListStatus, 'starting'>;

/** Every status filter, in display order. */
export const SESSION_STATUS_FILTERS: readonly SessionStatusFilter[] = [
  'needs-you',
  'running',
  'done',
  'stopped',
  'failed',
  'legacy',
];

/**
 * Selected statuses OR; none selected lets everything through. Needs you
 * matches a session with pending review items. Every other status matches the
 * LIFECYCLE, ignoring the review: someone filtering to Running still wants
 * their review-pending running session.
 */
export function matchesSessionStatusFilters(
  session: Pick<ProjectSession, 'status' | 'metadata'>,
  filters: readonly SessionStatusFilter[],
  reviewCount = 0,
): boolean {
  if (filters.length === 0) return true;
  const lifecycle = sessionListStatus(session);
  return filters.some((filter) =>
    filter === 'needs-you'
      ? reviewCount > 0
      : filter === 'running'
        ? lifecycle === 'running' || lifecycle === 'starting'
        : lifecycle === filter,
  );
}

// ── Tree (server-nested lists) ───────────────────────────────────────────────

/** Top-level rows only. The server returns roots for `parent: 'root'`; this
 *  also drops a row that names a parent (a stale cache, a server regression),
 *  so a child never renders without its parent. */
export function rootRowsOnly(rows: readonly ProjectSession[]): ProjectSession[] {
  return rows.filter((row) => sessionParentId(row) === null);
}

/** A root row's visible children: `child_count`, 0 when absent or garbage. */
export function childCountOf(session: Pick<ProjectSession, 'child_count'>): number {
  const count = session.child_count;
  return typeof count === 'number' && Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

/** Whether a parent row shows its children. The user's explicit choice wins;
 *  otherwise it opens for the active session's parent, or when a search
 *  matched it through a child (`search_match: 'child'`). */
export function isParentExpanded(input: {
  explicit: boolean | undefined;
  isActiveParent: boolean;
  searchMatch: ProjectSession['search_match'];
}): boolean {
  if (input.explicit !== undefined) return input.explicit;
  return input.isActiveParent || input.searchMatch === 'child';
}

// ── OpenCode sub-sessions (inside one sandbox) ───────────────────────────────

/** The root OpenCode session a project session is pinned to, else the first
 *  parentless entry; a pin missing from the snapshot yields null. */
export function rootOpenCodeSession(
  session: Pick<ProjectSession, 'opencode_session_id' | 'opencode_sessions'>,
): ProjectOpenCodeSession | null {
  const entries = session.opencode_sessions ?? [];
  if (session.opencode_session_id) return entries.find((item) => item.id === session.opencode_session_id) ?? null;
  return entries.find((item) => !item.parent_id) ?? null;
}

/** Direct, non-archived children of the root, newest first; ties break on id
 *  so the order never churns between refetches. */
export function directSubsessions(
  session: Pick<ProjectSession, 'opencode_session_id' | 'opencode_sessions'>,
): ProjectOpenCodeSession[] {
  const root = rootOpenCodeSession(session);
  if (!root) return [];
  return (session.opencode_sessions ?? [])
    .filter((item) => item.parent_id === root.id && !item.archived_at)
    .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0) || a.id.localeCompare(b.id));
}

// ── Activity sections ────────────────────────────────────────────────────────

export type SessionActivitySectionId = 'today' | 'yesterday' | 'week' | 'older';

export interface SessionActivitySection {
  id: SessionActivitySectionId;
  /** English default; hosts localize by `id`. */
  label: string;
  sessions: ProjectSession[];
}

export interface GroupedSessionsByActivity {
  sections: SessionActivitySection[];
  /** False when at most one section is populated: one header divides nothing. */
  showHeaders: boolean;
}

export const SESSION_ACTIVITY_SECTIONS: ReadonlyArray<{ id: SessionActivitySectionId; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'week', label: 'This week' },
  { id: 'older', label: 'Older' },
];

/** The activity section a timestamp falls in, against LOCAL calendar days of
 *  `now` (injected, so grouping is deterministic). A future timestamp is today. */
export function sessionActivitySectionOf(activityMs: number, now: number): SessionActivitySectionId {
  const d = new Date(now);
  const todayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  if (activityMs >= todayStart) return 'today';
  if (activityMs >= todayStart - DAY_MS) return 'yesterday';
  if (activityMs >= todayStart - 7 * DAY_MS) return 'week';
  return 'older';
}

/** Today / Yesterday / This week / Older, newest activity first within each;
 *  empty sections dropped. Never mutates `sessions`. */
export function groupSessionsByActivity(sessions: readonly ProjectSession[], now: number): GroupedSessionsByActivity {
  const at = new Map(sessions.map((session) => [session.session_id, sessionLastActivityAt(session)]));
  const ordered = sessions.slice().sort((a, b) => at.get(b.session_id)! - at.get(a.session_id)!);
  const buckets = new Map<SessionActivitySectionId, ProjectSession[]>(
    SESSION_ACTIVITY_SECTIONS.map((section) => [section.id, []]),
  );
  for (const session of ordered) buckets.get(sessionActivitySectionOf(at.get(session.session_id)!, now))!.push(session);
  const sections = SESSION_ACTIVITY_SECTIONS.filter((section) => buckets.get(section.id)!.length > 0).map((section) => ({
    ...section,
    sessions: buckets.get(section.id)!,
  }));
  return { sections, showHeaders: sections.length > 1 };
}

// ── View state and paging ────────────────────────────────────────────────────

/** Which of a session list's mutually exclusive render states applies. */
export type SessionListViewState = 'loading' | 'error' | 'empty' | 'no-matches' | 'content';

/**
 * Data wins: a failed refetch keeps its rows, so an error decides the view only
 * while there is nothing to show, and no data without an error is still
 * loading (a paused offline first load is not "no sessions"). With data, "no
 * sessions at all" wins over "none match" — unless the server already filtered
 * (a search, a starter scope), where zero rows means "none match".
 */
export function sessionListViewState(params: {
  hasData: boolean;
  isError: boolean;
  totalCount: number;
  visibleCount: number;
  serverFiltered?: boolean;
}): SessionListViewState {
  if (!params.hasData) return params.isError ? 'error' : 'loading';
  if (params.totalCount === 0) return params.serverFiltered ? 'no-matches' : 'empty';
  if (params.visibleCount === 0) return 'no-matches';
  return 'content';
}

export function shouldLoadMoreSessions(params: {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isRefreshing: boolean;
}): boolean {
  return params.hasNextPage && !params.isFetchingNextPage && !params.isRefreshing;
}
