import type { UiTranslator } from '@/i18n/translator';

import {
  isLegacyMigratedSession,
  SESSION_LIST_STATUS,
  sessionDisplayTitle,
  sessionHasTitle,
  sessionListStatus,
  sessionSource as sdkSessionSource,
  type ProjectSession,
  type SessionListStatus,
  type SessionSource as SdkSessionSource,
  type SessionSourceKind,
} from '@kortix/sdk';

/**
 * The web's localized reading of a project session. The rules (title, source,
 * status, filters, the opencode sub-session tree) live in `@kortix/sdk`; this
 * file adds only what needs the web's translator or has no SDK twin:
 *
 * - the localized SOURCE label, and the source filter over it;
 * - the DISPLAY STATUS aliases and their catalog keys;
 * - the ownership and meta-coordinator markers.
 */

export type { SessionSourceKind };

export interface SessionSource extends SdkSessionSource {
  /** Human label, e.g. "Slack", "Scheduled". */
  label: string;
}

/** The platform meta coordinator — drives other sessions from its own sandbox. */
export function isMetaCoordinatorSession(session: ProjectSession): boolean {
  return session.agent_name === 'meta';
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

function sourceLabel(kind: SessionSourceKind, tI18nComplete: UiTranslator): string {
  switch (kind) {
    case 'slack':
      return tI18nComplete.raw('textb27fb38ba323');
    case 'telegram':
      return tI18nComplete.raw('textacdd1e734125');
    case 'teams':
      return tI18nComplete.raw('texta7b52b269a23');
    case 'email':
      return tI18nComplete.raw('text969ccbd3cf63');
    case 'schedule':
      return tI18nComplete.raw('text4724f344c1c0');
    case 'webhook':
      return tI18nComplete.raw('text4814f62c108d');
    case 'chat':
      return tI18nComplete.raw('text460b3a7da007');
  }
}

/** The SDK's `sessionSource` plus the localized label. */
export function sessionSource(session: ProjectSession, tI18nComplete: UiTranslator): SessionSource {
  const source = sdkSessionSource(session);
  return { ...source, label: sourceLabel(source.kind, tI18nComplete) };
}

/**
 * Human display label for a session. Precedence: the user-set rename
 * (custom_name) is AUTHORITATIVE and always wins. Then: server-resolved
 * session.name (OpenCode auto-title mirrored during session reads) → legacy
 * metadata.session_name → branch slice → short id.
 */
export function sessionDisplayLabel(session: ProjectSession): string {
  if (sessionHasTitle(session)) return sessionDisplayTitle(session);
  return session.branch_name ? session.branch_name.slice(0, 14) : session.session_id.slice(0, 8);
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
  | 'shared'
  | 'slack'
  | 'telegram'
  | 'teams'
  | 'email'
  | 'schedule'
  | 'webhook';

export const SESSION_SOURCE_FILTERS: Array<{ value: SessionSourceFilter; label: string }> = [
  { value: 'shared', label: 'Shared' },
  { value: 'slack', label: 'Slack' },
  { value: 'telegram', label: 'Telegram' },
  { value: 'teams', label: 'Teams' },
  { value: 'email', label: 'Email' },
  { value: 'schedule', label: 'Scheduled' },
  { value: 'webhook', label: 'Webhook' },
];

export function matchesSourceFilters(
  session: ProjectSession,
  filters: readonly SessionSourceFilter[],
  tI18nComplete: UiTranslator,
): boolean {
  if (filters.length === 0) return true;
  const kind = sessionSource(session, tI18nComplete).kind;
  return filters.some((filter) => {
    // Ownership is independent of source. A scheduled or channel session can
    // be shared with the viewer and must remain discoverable through Shared.
    if (filter === 'shared') return sessionIsShared(session);
    return kind === filter;
  });
}
