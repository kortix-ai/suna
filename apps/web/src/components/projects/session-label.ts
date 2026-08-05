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
 * Multi-select filter facets. An EMPTY array means "no constraint" — that is
 * how "All" is expressed, so there is no `'all'` sentinel member. A sentinel
 * alongside arrays would allow `['all', 'running']`, which has no meaning.
 */
export type SessionSourceFilter =
  | 'mine'
  | 'shared'
  | 'slack'
  | 'telegram'
  | 'email'
  | 'schedule'
  | 'webhook';
export type SessionStatusFilter = 'running' | 'done' | 'stopped' | 'failed';

export const SESSION_SOURCE_FILTERS: Array<{ value: SessionSourceFilter; label: string }> = [
  { value: 'mine', label: 'My chats' },
  { value: 'shared', label: 'Shared' },
  { value: 'slack', label: 'Slack' },
  { value: 'telegram', label: 'Telegram' },
  { value: 'email', label: 'Email' },
  { value: 'schedule', label: 'Scheduled' },
  { value: 'webhook', label: 'Webhook' },
];

export const SESSION_STATUS_FILTERS: Array<{ value: SessionStatusFilter; label: string }> = [
  { value: 'running', label: 'Running' },
  { value: 'done', label: 'Done' },
  { value: 'stopped', label: 'Stopped' },
  { value: 'failed', label: 'Failed' },
];

/** Selected values are ORed. Empty = everything. */
export function matchesStatusFilters(
  session: ProjectSession,
  filters: readonly SessionStatusFilter[],
): boolean {
  if (filters.length === 0) return true;
  // Lifecycle only — someone filtering to Running still wants their
  // review-pending running session.
  const display = sessionDisplayStatus(session);
  return filters.some((filter) =>
    filter === 'running' ? display === 'running' || display === 'starting' : display === filter,
  );
}

export function matchesSourceFilters(
  session: ProjectSession,
  filters: readonly SessionSourceFilter[],
): boolean {
  if (filters.length === 0) return true;
  const kind = sessionSource(session).kind;
  return filters.some((filter) => {
    // `is_owner` is viewer-relative and older payloads omit it — unknown
    // ownership reads as "mine" so the default view never hides a session.
    if (filter === 'mine') return kind === 'chat' && session.is_owner !== false;
    if (filter === 'shared') return kind === 'chat' && session.is_owner === false;
    return kind === filter;
  });
}
