import type { ProjectOpenCodeSession, ProjectSession } from '@/lib/projects-client';

/**
 * Canonical helpers for resolving a project session's display label and its
 * opencode session tree. Single source of truth — the sidebar, the session
 * list, and the tab bar must all render the SAME name for a session.
 */

/** The root opencode session a project session is pinned to (if synced). */
export function rootOpenCodeSession(session: ProjectSession): ProjectOpenCodeSession | null {
  const opencodeSessions = session.opencode_sessions ?? [];
  const rootId = session.opencode_session_id;
  if (rootId) return opencodeSessions.find((item) => item.id === rootId) ?? null;
  return opencodeSessions.find((item) => !item.parent_id) ?? null;
}

/** Direct, non-archived children of the root opencode session, newest first. */
export function directSubsessions(session: ProjectSession): ProjectOpenCodeSession[] {
  const root = rootOpenCodeSession(session);
  if (!root) return [];
  return (session.opencode_sessions ?? [])
    .filter((item) => item.parent_id === root.id && !item.archived_at)
    .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
}

/**
 * Where a session came from, derived from the creation metadata stamped by
 * the API: channel sessions carry `metadata.source` ('slack' | 'telegram'),
 * trigger fires carry `metadata.trigger_source` ('cron' | 'webhook' |
 * 'manual') + `trigger_type`/`trigger_slug`. Everything else is a regular
 * chat the user started.
 */
export type SessionSourceKind = 'chat' | 'slack' | 'telegram' | 'schedule' | 'webhook';

export interface SessionSource {
  kind: SessionSourceKind;
  /** Human label, e.g. "Slack", "Scheduled". */
  label: string;
  /** For trigger-fired sessions: the kortix.toml trigger slug. */
  triggerSlug: string | null;
}

export function sessionSource(session: ProjectSession): SessionSource {
  const meta = (session.metadata ?? {}) as Record<string, unknown>;
  const source = typeof meta.source === 'string' ? meta.source : null;
  if (source === 'slack') return { kind: 'slack', label: 'Slack', triggerSlug: null };
  if (source === 'telegram') return { kind: 'telegram', label: 'Telegram', triggerSlug: null };
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
 * automation sources match sessionSource(). Every option is always offered,
 * even at count 0.
 */
export type SessionFilterValue =
  | 'all'
  | 'mine'
  | 'shared'
  | 'slack'
  | 'schedule'
  | 'webhook';

export const SESSION_FILTER_OPTIONS: Array<{ value: SessionFilterValue; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'mine', label: 'My Chats' },
  { value: 'shared', label: 'Shared' },
  { value: 'slack', label: 'Slack' },
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
 * (custom_name) is AUTHORITATIVE and always wins — even over the live
 * opencode root title (which keeps serving the auto title after a rename).
 * Then: live opencode root title → resolved name (synced auto-title) →
 * legacy metadata.session_name → branch slice → short id.
 */
export function sessionDisplayLabel(session: ProjectSession): string {
  const metadataName =
    typeof session.metadata?.session_name === 'string'
      ? (session.metadata.session_name as string)
      : null;
  const fallback = session.branch_name
    ? session.branch_name.slice(0, 14)
    : session.session_id.slice(0, 8);
  return (
    session.custom_name?.trim() ||
    rootOpenCodeSession(session)?.title?.trim() ||
    session.name?.trim() ||
    metadataName?.trim() ||
    fallback
  );
}
