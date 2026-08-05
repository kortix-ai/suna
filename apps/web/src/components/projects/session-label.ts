import type { ProjectRuntimeSession, ProjectSession } from '@kortix/sdk';

/**
 * Canonical helpers for resolving a project session's display label and its
 * opencode session tree. Single source of truth — the sidebar, the session
 * list, and the tab bar must all render the SAME name for a session.
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

/**
 * Human display label for a session. Precedence: the user-set rename
 * (custom_name) is AUTHORITATIVE and always wins. Then: server-resolved
 * session.name (OpenCode auto-title mirrored during session reads) → legacy
 * metadata.session_name → branch slice → short id.
 */
export interface SessionFilterOption {
  value: SessionFilterValue;
  label: string;
  count: number;
}

/**
 * Which filters a session set is worth offering, with their counts.
 *
 * A source filter earns a slot only when it matches at least one session — an
 * "Email 0" row is a dead end. And the menu as a whole only earns its place
 * when two or more sources are present: with a single source every option
 * renders the exact same list as "All", so the control does nothing. Returns
 * [] in that case, which is the signal to drop the dropdown entirely.
 *
 * "All" is prepended (never counted as a source) and counts every session,
 * including kinds no filter covers (e.g. telegram).
 */
export function availableSessionFilterOptions(sessions: ProjectSession[]): SessionFilterOption[] {
  const [allOption, ...sourceOptions] = SESSION_FILTER_OPTIONS;
  const present = sourceOptions
    .map((option) => ({
      ...option,
      count: sessions.filter((session) => matchesSessionFilter(session, option.value)).length,
    }))
    .filter((option) => option.count > 0);

  if (present.length < 2) return [];
  return [{ ...allOption, count: sessions.length }, ...present];
}

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

/**
 * Which status filters this session set is worth offering, with their counts.
 *
 * Mirrors `availableSessionFilterOptions` exactly: an option earns a slot only
 * when it matches at least one session ("Failed 0" is a dead end), and the
 * group as a whole earns its place only at two or more represented statuses —
 * below that every option renders the same list as "All".
 */
export function availableSessionStatusFilterOptions(
  sessions: ProjectSession[],
): SessionStatusFilterOption[] {
  const [allOption, ...statusOptions] = SESSION_STATUS_FILTER_OPTIONS;
  const present = statusOptions
    .map((option) => ({
      ...option,
      count: sessions.filter((session) => matchesSessionStatusFilter(session, option.value)).length,
    }))
    .filter((option) => option.count > 0);

  if (present.length < 2) return [];
  return [{ ...allOption, count: sessions.length }, ...present];
}
