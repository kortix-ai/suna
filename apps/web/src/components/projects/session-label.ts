import type { ProjectRuntimeSession, ProjectSession } from '@kortix/sdk';

/**
 * Canonical, framework-free helpers for reading a project session the way the
 * UI reads it. Single source of truth for four things:
 *
 * - the display LABEL and the opencode session tree (`sessionDisplayLabel`,
 *   `rootOpenCodeSession`, `directSubsessions`) — the sidebar, the session
 *   list, and the tab bar must all render the SAME name for a session;
 * - the SOURCE a session came from, and the source filter over it;
 * - the DISPLAY STATUS — the five user-facing states the seven-value sandbox
 *   lifecycle collapses to — and the status filter over it;
 * - the two-dimension filter MENU (`resolveSessionFilterMenu`), which resolves
 *   both filters and both option lists together so the counts a menu promises
 *   always match what the list renders.
 */

/** The root opencode session a project session is pinned to (if synced). */
export function rootOpenCodeSession(session: ProjectSession): ProjectRuntimeSession | null {
  const opencodeSessions = session.opencode_sessions ?? [];
  const rootId = session.opencode_session_id;
  if (rootId) return opencodeSessions.find((item) => item.id === rootId) ?? null;
  return opencodeSessions.find((item) => !item.parent_id) ?? null;
}

/** Direct, non-archived children of the root opencode session, newest first. */
export function directSubsessions(session: ProjectSession): ProjectRuntimeSession[] {
  const root = rootOpenCodeSession(session);
  if (!root) return [];
  return (session.opencode_sessions ?? [])
    .filter((item) => item.parent_id === root.id && !item.archived_at)
    .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
}

/**
 * Where a session came from, derived from the creation metadata stamped by
 * the API: channel sessions carry `metadata.source` ('slack' | 'telegram' |
 * 'email'),
 * trigger fires carry `metadata.trigger_source` ('cron' | 'webhook' |
 * 'manual') + `trigger_type`/`trigger_slug`. Everything else is a regular
 * chat the user started.
 */
export type SessionSourceKind = 'chat' | 'slack' | 'telegram' | 'email' | 'schedule' | 'webhook';

export interface SessionSource {
  kind: SessionSourceKind;
  /** Human label, e.g. "Slack", "Scheduled". */
  label: string;
  /** For trigger-fired sessions: the kortix.yaml trigger slug. */
  triggerSlug: string | null;
}

export function sessionSource(session: ProjectSession): SessionSource {
  const meta = (session.metadata ?? {}) as Record<string, unknown>;
  const source = typeof meta.source === 'string' ? meta.source : null;
  if (source === 'slack') return { kind: 'slack', label: 'Slack', triggerSlug: null };
  if (source === 'telegram') return { kind: 'telegram', label: 'Telegram', triggerSlug: null };
  if (source === 'email') return { kind: 'email', label: 'Email', triggerSlug: null };
  if (typeof meta.trigger_source === 'string') {
    const triggerSlug = typeof meta.trigger_slug === 'string' ? meta.trigger_slug : null;
    // Classify by the trigger's kind (cron|webhook) when present so a manual
    // "run now" fire groups under its trigger; fall back to the fire source.
    const type = typeof meta.trigger_type === 'string' ? meta.trigger_type : meta.trigger_source;
    if (type === 'cron') return { kind: 'schedule', label: 'Scheduled', triggerSlug };
    return { kind: 'webhook', label: 'Webhook', triggerSlug };
  }
  return { kind: 'chat', label: 'Chat', triggerSlug: null };
}

/**
 * Session-list filter. "All" (default) shows everything; chats split into
 * "mine" and "shared" (chats someone else owns that are visible to me);
 * automation sources match sessionSource(). Which of these a project actually
 * offers is decided by availableSessionFilterOptions().
 */
export type SessionFilterValue =
  | 'all'
  | 'mine'
  | 'shared'
  | 'slack'
  | 'email'
  | 'schedule'
  | 'webhook';

export const SESSION_FILTER_OPTIONS: Array<{ value: SessionFilterValue; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'mine', label: 'My Chats' },
  { value: 'shared', label: 'Shared' },
  { value: 'slack', label: 'Slack' },
  { value: 'email', label: 'Email' },
  { value: 'schedule', label: 'Scheduled' },
  { value: 'webhook', label: 'Webhook' },
];

export function matchesSessionFilter(session: ProjectSession, filter: SessionFilterValue): boolean {
  if (filter === 'all') return true;
  const kind = sessionSource(session).kind;
  // `is_owner` is viewer-relative; older payloads may omit it — treat unknown
  // ownership as "mine" so the default view never silently hides sessions.
  if (filter === 'mine') return kind === 'chat' && session.is_owner !== false;
  if (filter === 'shared') return kind === 'chat' && session.is_owner === false;
  return kind === filter;
}

export interface SessionFilterOption {
  value: SessionFilterValue;
  label: string;
  count: number;
}

/**
 * The one option-list builder both filter dimensions use.
 *
 * Three rules, identical for source and status:
 *
 * 1. An option earns a slot only when it matches at least one session — an
 *    "Email 0" row is a dead end.
 * 2. …unless it is the ACTIVE option. A menu that drops the option the user is
 *    currently filtered to leaves no way back, so the active option is always
 *    listed, at its true count, even when that count is 0.
 * 3. The group as a whole earns its place only at two or more listed options:
 *    below that every option renders the exact same list as "All". `[]` is the
 *    signal to drop the group entirely. Rule 3 is skipped whenever a non-"all"
 *    option is active — again, the user needs the way back.
 *
 * "All" is prepended (never counted as an option itself) and counts every
 * session in `sessions`, including kinds no option covers (e.g. telegram).
 */
function buildFilterOptions<V extends string>(
  declared: Array<{ value: V; label: string }>,
  sessions: ProjectSession[],
  matches: (session: ProjectSession, value: V) => boolean,
  active: V,
): Array<{ value: V; label: string; count: number }> {
  const [allOption, ...rest] = declared;
  const present = rest
    .map((option) => ({
      ...option,
      count: sessions.filter((session) => matches(session, option.value)).length,
    }))
    .filter((option) => option.count > 0 || option.value === active);

  if (active === allOption.value && present.length < 2) return [];
  return [{ ...allOption, count: sessions.length }, ...present];
}

/** Which source filters a session set is worth offering, with their counts.
 *  See `buildFilterOptions` for the rules. Counts the whole set — for the
 *  faceted, ANDed-with-status counts the menu actually renders, use
 *  `resolveSessionFilterMenu`. */
export function availableSessionFilterOptions(sessions: ProjectSession[]): SessionFilterOption[] {
  return buildFilterOptions(SESSION_FILTER_OPTIONS, sessions, matchesSessionFilter, 'all');
}

/**
 * Human display label for a session. Precedence: the user-set rename
 * (custom_name) is AUTHORITATIVE and always wins. Then: server-resolved
 * session.name (OpenCode auto-title mirrored during session reads) → legacy
 * metadata.session_name → branch slice → short id.
 */
export function sessionDisplayLabel(session: ProjectSession): string {
  const metadataName =
    typeof session.metadata?.session_name === 'string'
      ? (session.metadata.session_name as string)
      : null;
  const fallback = session.branch_name
    ? session.branch_name.slice(0, 14)
    : session.session_id.slice(0, 8);
  return session.custom_name?.trim() || session.name?.trim() || metadataName?.trim() || fallback;
}

/**
 * What the user sees, as opposed to what the sandbox is doing.
 *
 * `ProjectSessionStatus` is a seven-value SANDBOX lifecycle. Users get five
 * states plus one override. The collapse is deliberate: `queued`, `branching`
 * and `provisioning` are one idea ("starting") to anyone who is not debugging
 * the provisioner.
 *
 * The governing rule is that green means live or actionable and nothing else,
 * so `completed` maps to `done` and is rendered muted — never green.
 */
export type SessionDisplayStatus =
  | 'needs-you'
  | 'starting'
  | 'running'
  | 'done'
  | 'stopped'
  | 'failed';

/** Tooltip + section copy. Never "Active": `running` means the sandbox is up,
 *  not that the agent is working, and the payload carries no signal for that. */
export const SESSION_DISPLAY_STATUS_LABELS: Record<SessionDisplayStatus, string> = {
  'needs-you': 'Needs you',
  starting: 'Starting',
  running: 'Running',
  done: 'Done',
  stopped: 'Stopped',
  failed: 'Failed',
};

/**
 * Resolve a session to its display status.
 *
 * A pending review wins outright: a finished session with items awaiting the
 * human is ACTIONABLE, and actionable outranks finished.
 *
 * The `default` is load-bearing, not defensive noise. `ProjectSessionStatus`
 * is a published SDK union, so an API that grows an eighth member ships a
 * value this build has never seen. Without the default the function returns
 * `undefined`, `STATUS_DOT_STYLE[undefined]` throws, and the whole sidebar
 * unmounts. `stopped` is the safe answer: muted (never green, per the
 * governing rule) and honest — "not live" is true of any value that is not
 * one of the four live ones, whereas `failed` would invent a failure.
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
      return 'done';
    case 'stopped':
      return 'stopped';
    case 'failed':
      return 'failed';
    default:
      return 'stopped';
  }
}

/**
 * Session-list STATUS filter — independent of, and ANDed with, the source
 * filter (`SessionFilterValue`). Two dimensions, not one union: folding status
 * into the source union would make "Slack AND Running" unexpressible.
 *
 * `running` deliberately covers the whole starting family. The user filters by
 * what the list shows them, not by the sandbox lifecycle underneath it.
 */
export type SessionStatusFilterValue = 'all' | 'running' | 'done' | 'stopped' | 'failed';

export interface SessionStatusFilterOption {
  value: SessionStatusFilterValue;
  label: string;
  count: number;
}

/** Declared order — the menu renders these top-to-bottom regardless of which
 *  statuses the project happens to contain. */
export const SESSION_STATUS_FILTER_OPTIONS: Array<{
  value: SessionStatusFilterValue;
  label: string;
}> = [
  { value: 'all', label: 'All' },
  { value: 'running', label: 'Running' },
  { value: 'done', label: 'Done' },
  { value: 'stopped', label: 'Stopped' },
  { value: 'failed', label: 'Failed' },
];

export function matchesSessionStatusFilter(
  session: ProjectSession,
  filter: SessionStatusFilterValue,
): boolean {
  if (filter === 'all') return true;
  // Read the lifecycle, never the review overlay: someone filtering to
  // "Running" still wants their review-pending running session.
  const display = sessionDisplayStatus(session);
  if (filter === 'running') return display === 'running' || display === 'starting';
  return display === filter;
}

/** Which status filters this session set is worth offering, with their counts.
 *  Same three rules as the source dimension — see `buildFilterOptions`. Counts
 *  the whole set; for the faceted, ANDed-with-source counts the menu actually
 *  renders, use `resolveSessionFilterMenu`. */
export function availableSessionStatusFilterOptions(
  sessions: ProjectSession[],
): SessionStatusFilterOption[] {
  return buildFilterOptions(
    SESSION_STATUS_FILTER_OPTIONS,
    sessions,
    matchesSessionStatusFilter,
    'all',
  );
}

/** Both filter dimensions, resolved together: the two option lists the menu
 *  renders and the two values the list is actually filtered by. */
export interface SessionFilterMenu {
  filterOptions: SessionFilterOption[];
  statusOptions: SessionStatusFilterOption[];
  activeFilter: SessionFilterValue;
  activeStatus: SessionStatusFilterValue;
}

/**
 * Resolve the whole SESSIONS filter menu — both dimensions at once.
 *
 * The list ANDs the two filters. Counting each dimension over the raw session
 * set therefore lies: with Source=Slack and every Slack session `completed`,
 * a status menu counted over all sessions still offers "Running 2", and
 * clicking it renders the no-matches empty state. So each dimension is counted
 * over the sessions that already pass the OTHER dimension's active filter.
 *
 * That cross-dependency is what makes this one function rather than two.
 *
 * **Why it cannot oscillate.** Recovery — resetting a filter whose sessions
 * have all vanished — reads the UNFACETED session set (steps 1 and 2 below).
 * It is therefore independent of the other dimension's value, so a reset in
 * one dimension can never trigger a reset in the other, and there is no
 * feedback edge to loop over. Faceting (step 3) only reads the resolved
 * values; it never writes them. The whole function is straight-line — no
 * fixpoint iteration, no convergence to argue about.
 *
 * **Why the active option never disappears.** The faceted list can legitimately
 * count the active option at 0 (Source=Slack, Status=Running, no Slack session
 * running). Rather than silently resetting the user's choice — a filter
 * changing itself under the cursor is the more confusing failure — the active
 * option stays listed at its true count of 0, alongside "All". The count is
 * honest, it matches the empty list the user is looking at, and "All" is one
 * click away. See rules 2 and 3 in `buildFilterOptions`.
 */
export function resolveSessionFilterMenu(
  sessions: ProjectSession[],
  requestedFilter: SessionFilterValue,
  requestedStatus: SessionStatusFilterValue,
): SessionFilterMenu {
  // 1 + 2. Recovery, per dimension, against the whole set. A persisted filter
  // outlives the sessions that justified it: filter to Slack, delete the last
  // Slack session, and the option is gone with no way back. Falling back to
  // "all" only ever widens the visible set.
  const activeFilter: SessionFilterValue = availableSessionFilterOptions(sessions).some(
    (option) => option.value === requestedFilter,
  )
    ? requestedFilter
    : 'all';
  const activeStatus: SessionStatusFilterValue = availableSessionStatusFilterOptions(sessions).some(
    (option) => option.value === requestedStatus,
  )
    ? requestedStatus
    : 'all';

  // 3. Faceted counts: each dimension sees only what the other one lets through.
  return {
    statusOptions: buildFilterOptions(
      SESSION_STATUS_FILTER_OPTIONS,
      sessions.filter((session) => matchesSessionFilter(session, activeFilter)),
      matchesSessionStatusFilter,
      activeStatus,
    ),
    filterOptions: buildFilterOptions(
      SESSION_FILTER_OPTIONS,
      sessions.filter((session) => matchesSessionStatusFilter(session, activeStatus)),
      matchesSessionFilter,
      activeFilter,
    ),
    activeFilter,
    activeStatus,
  };
}
