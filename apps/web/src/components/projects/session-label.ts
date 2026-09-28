import type { UiTranslator } from '@/i18n/translator';

import {
  isLegacyMigratedSession,
  SESSION_LIST_STATUS,
  sessionListStatus,
  type ProjectRuntimeSession,
  type ProjectSession,
  type SessionListStatus,
} from '@kortix/sdk';

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

/**
 * Direct, non-archived children of the root opencode session, newest first.
 *
 * Ties break on id. A child with no `updated_at` collapses to `0`, so whole
 * groups of them tie — and a stable sort then preserves ARRIVAL order, which is
 * whatever order the sandbox listing came back in. That order is re-derived on
 * every refetch, and the snapshot writer persists a pure reorder as a change,
 * so the churn reached every client as sub-sessions visibly swapping places in
 * the sidebar. Ids are stable and unique; the rendered order now is too.
 */
export function directSubsessions(session: ProjectSession): ProjectRuntimeSession[] {
  const root = rootOpenCodeSession(session);
  if (!root) return [];
  return (session.opencode_sessions ?? [])
    .filter((item) => item.parent_id === root.id && !item.archived_at)
    .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0) || a.id.localeCompare(b.id));
}

/**
 * Where a session came from, derived from the creation metadata stamped by
 * the API: channel sessions carry `metadata.source` ('slack' | 'telegram' |
 * 'teams' | 'email'),
 * trigger fires carry `metadata.trigger_source` ('cron' | 'webhook' |
 * 'manual') + `trigger_type`/`trigger_slug`. Everything else is a regular
 * chat the user started.
 */
export type SessionSourceKind =
  | 'chat'
  | 'slack'
  | 'telegram'
  | 'teams'
  | 'email'
  | 'schedule'
  | 'webhook';

export interface SessionSource {
  kind: SessionSourceKind;
  /** Human label, e.g. "Slack", "Scheduled". */
  label: string;
  /** For trigger-fired sessions: the kortix.yaml trigger slug. */
  triggerSlug: string | null;
}

/** The platform meta coordinator — drives other sessions from its own sandbox. */
export function isMetaCoordinatorSession(session: ProjectSession): boolean {
  return session.agent_name === 'meta';
}

/** The coordinator session that spawned this one (stamped at create from the
 *  caller's session-bound token), or null for sessions users started. */
export function spawnedBySessionId(session: ProjectSession): string | null {
  const meta = (session.metadata ?? {}) as Record<string, unknown>;
  return typeof meta.spawned_by_session === 'string' ? meta.spawned_by_session : null;
}

/**
 * Viewer-relative ownership marker.
 *
 * The API computes `is_owner` from the authenticated viewer. Only an explicit
 * false is shared. Older payloads omit the field, so they keep the unmarked
 * default state instead of being mislabeled.
 */
export function sessionIsShared(session: Pick<ProjectSession, 'is_owner'>): boolean {
  return session.is_owner === false;
}

export function sessionSource(session: ProjectSession, tI18nComplete: UiTranslator): SessionSource {
  const meta = (session.metadata ?? {}) as Record<string, unknown>;
  const source = typeof meta.source === 'string' ? meta.source : null;
  if (source === 'slack')
    return { kind: 'slack', label: tI18nComplete.raw('textb27fb38ba323'), triggerSlug: null };
  if (source === 'telegram')
    return { kind: 'telegram', label: tI18nComplete.raw('textacdd1e734125'), triggerSlug: null };
  if (source === 'teams')
    return { kind: 'teams', label: tI18nComplete.raw('texta7b52b269a23'), triggerSlug: null };
  if (source === 'email')
    return { kind: 'email', label: tI18nComplete.raw('text969ccbd3cf63'), triggerSlug: null };
  if (typeof meta.trigger_source === 'string') {
    const triggerSlug = typeof meta.trigger_slug === 'string' ? meta.trigger_slug : null;
    // Classify by the trigger's kind (cron|webhook) when present so a manual
    // "run now" fire groups under its trigger; fall back to the fire source.
    const type = typeof meta.trigger_type === 'string' ? meta.trigger_type : meta.trigger_source;
    if (type === 'cron')
      return { kind: 'schedule', label: tI18nComplete.raw('text4724f344c1c0'), triggerSlug };
    return { kind: 'webhook', label: tI18nComplete.raw('text4814f62c108d'), triggerSlug };
  }
  return { kind: 'chat', label: tI18nComplete.raw('text460b3a7da007'), triggerSlug: null };
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
  return (
    stripChatMentionMarkup(session.custom_name ?? '') ||
    stripChatMentionMarkup(session.name ?? '') ||
    stripChatMentionMarkup(metadataName ?? '') ||
    fallback
  );
}

/**
 * Teams wraps a channel @-mention of the bot in `<at>…</at>`. Sessions titled
 * from such a message before the API stripped it (#7388) still carry the tag
 * in `name`; nothing a person reads should show it.
 */
export function stripChatMentionMarkup(value: string): string {
  return value
    .replace(/<at[^>]*>.*?<\/at>/gi, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * What the user sees, as opposed to what the sandbox is doing. The words and
 * the resolution live in the SDK (`sessionListStatus`, `SESSION_LIST_STATUS`),
 * so mobile shows the same state with the same word; these names stay as the
 * web's aliases.
 *
 * The governing rule is that green means live or actionable and nothing else,
 * so `completed` maps to `done` and is rendered muted — never green.
 */
export type SessionDisplayStatus = SessionListStatus;

/** Tooltip + section copy. Never "Active": `running` means the sandbox is up,
 *  not that the agent is working, and the payload carries no signal for that. */
export const SESSION_DISPLAY_STATUS_LABELS: Record<SessionDisplayStatus, string> = {
  'needs-you': SESSION_LIST_STATUS['needs-you'].label,
  starting: SESSION_LIST_STATUS.starting.label,
  running: SESSION_LIST_STATUS.running.label,
  done: SESSION_LIST_STATUS.done.label,
  stopped: SESSION_LIST_STATUS.stopped.label,
  failed: SESSION_LIST_STATUS.failed.label,
  legacy: SESSION_LIST_STATUS.legacy.label,
};

/** The `sidebar.sessionList.status.*` catalog key of each status, for every
 *  surface that names one. */
export const SESSION_STATUS_TRANSLATION_KEY = {
  'needs-you': 'needsYou',
  starting: 'starting',
  running: 'running',
  done: 'done',
  stopped: 'stopped',
  failed: 'failed',
  legacy: 'legacy',
} as const satisfies Record<SessionDisplayStatus, string>;

export { isLegacyMigratedSession };

/**
 * Resolve a session to its display status. A pending review wins outright; a
 * status this build has never seen reads `stopped`. See `sessionListStatus`.
 */
export function sessionDisplayStatus(
  session: ProjectSession,
  reviewCount = 0,
): SessionDisplayStatus {
  return sessionListStatus(session, reviewCount);
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
  | 'teams'
  | 'email'
  | 'schedule'
  | 'webhook';
export type SessionStatusFilter = 'running' | 'done' | 'stopped' | 'failed' | 'legacy';

export const SESSION_SOURCE_FILTERS: Array<{ value: SessionSourceFilter; label: string }> = [
  { value: 'mine', label: 'My chats' },
  { value: 'shared', label: 'Shared' },
  { value: 'slack', label: 'Slack' },
  { value: 'telegram', label: 'Telegram' },
  { value: 'teams', label: 'Teams' },
  { value: 'email', label: 'Email' },
  { value: 'schedule', label: 'Scheduled' },
  { value: 'webhook', label: 'Webhook' },
];

export const SESSION_STATUS_FILTERS: Array<{ value: SessionStatusFilter; label: string }> = [
  { value: 'running', label: 'Running' },
  { value: 'done', label: 'Done' },
  { value: 'stopped', label: 'Stopped' },
  { value: 'failed', label: 'Failed' },
  { value: 'legacy', label: 'Legacy' },
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
  tI18nComplete: UiTranslator,
): boolean {
  if (filters.length === 0) return true;
  const kind = sessionSource(session, tI18nComplete).kind;
  return filters.some((filter) => {
    // `is_owner` is viewer-relative and older payloads omit it — unknown
    // ownership reads as "mine" so the default view never hides a session.
    if (filter === 'mine') return kind === 'chat' && !sessionIsShared(session);
    // Ownership is independent of source. A scheduled or channel session can
    // be shared with the viewer and must remain discoverable through Shared.
    if (filter === 'shared') return sessionIsShared(session);
    return kind === filter;
  });
}
