import type { WorkspaceSession } from '@kortix/sdk';

import {
  matchesSourceFilters,
  matchesStatusFilters,
  sessionSource,
  type SessionSourceFilter,
  type SessionSourceKind,
  type SessionStatusFilter,
} from '@/components/workspaces/session-label';
import {
  getSessionDisplayTitle,
  sortSessionsByLastActivity,
} from '@/features/workspace/workspace-sidebar/workspace-session-list-helpers';

export function sessionOwnerLabel(session: WorkspaceSession): string {
  if (session.owner_name) return session.owner_name;
  if (session.owner_email) return session.owner_email;
  if (session.is_owner === true) return 'You';
  return 'Unknown owner';
}

export function sessionAccessMeta(session: WorkspaceSession): {
  label: 'Can open' | 'Metadata only' | 'Runtime unavailable' | 'Deleted';
  canOpen: boolean;
} {
  if (session.deleted_at) return { label: 'Deleted', canOpen: false };
  if (session.can_access === false) return { label: 'Metadata only', canOpen: false };
  if (session.status === 'stopped' && !session.runtime_status) {
    return { label: 'Runtime unavailable', canOpen: false };
  }
  if (session.runtime_status === 'archived' || session.runtime_status === 'error') {
    return { label: 'Runtime unavailable', canOpen: false };
  }
  return { label: 'Can open', canOpen: true };
}

export function sessionSearchText(session: WorkspaceSession): string {
  const source = sessionSource(session);
  return [
    getSessionDisplayTitle(session),
    session.session_id,
    session.branch_name,
    session.base_ref,
    session.agent_name,
    session.owner_email,
    session.owner_name,
    session.owner_type,
    session.sandbox_provider,
    session.status,
    session.visibility,
    session.runtime_status,
    session.deleted_at,
    source.label,
    source.triggerSlug,
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(' ')
    .toLocaleLowerCase();
}

/** Precomputed haystack per session id — see `filterWorkspaceSessions`. */
export type SessionSearchIndex = ReadonlyMap<string, string>;

/**
 * Build the search haystack once per session.
 *
 * `sessionSearchText` reads 15 fields, resolves the session's source, joins and
 * lowercases. Doing that inside the filter meant rebuilding it for every
 * session on every keystroke; on a workspace with a few hundred sessions that is
 * the single most expensive thing this page does while you type. The caller
 * memoises this against the session list, so typing only re-runs `includes`.
 */
export function buildSessionSearchIndex(sessions: WorkspaceSession[]): SessionSearchIndex {
  const index = new Map<string, string>();
  for (const session of sessions) index.set(session.session_id, sessionSearchText(session));
  return index;
}

/**
 * The sessions page's visible set: the sidebar's two multi-select facets ANDed
 * together, then the page's own free-text search.
 *
 * The facets are the SAME predicates the sidebar list applies
 * (`matchesStatusFilters` / `matchesSourceFilters`), reading the same persisted
 * store — so a filter set in either surface means the same thing in both. The
 * ordering inside each section is `groupSessions`' job; this sorts so callers
 * that skip grouping still get newest-first.
 */
export function filterWorkspaceSessions(
  sessions: WorkspaceSession[],
  statusFilters: readonly SessionStatusFilter[],
  sourceFilters: readonly SessionSourceFilter[],
  query: string,
  /** Omit and the haystack is computed inline, which is fine for one-off calls
   *  and for tests; the view always passes its memoised index. */
  searchIndex?: SessionSearchIndex,
): WorkspaceSession[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matches = sessions.filter((session) => {
    if (!matchesStatusFilters(session, statusFilters)) return false;
    if (!matchesSourceFilters(session, sourceFilters)) return false;
    if (!normalizedQuery) return true;
    const haystack = searchIndex?.get(session.session_id) ?? sessionSearchText(session);
    return haystack.includes(normalizedQuery);
  });
  return sortSessionsByLastActivity(matches);
}

export interface SessionDetailField {
  label: string;
  value: string;
  mono?: boolean;
}

const OWNER_TYPE_LABELS: Record<string, string> = {
  user: 'Person',
  service_account: 'Agent / service account',
};

/**
 * The detail fields worth rendering for a session.
 *
 * A field is emitted only when it carries a real value. The previous grid
 * rendered all 18 fields unconditionally, so a plain chat session was roughly
 * two thirds placeholders — `Not created`, `Missing`, `Unattributed`,
 * `Not synced`. A placeholder formatted like data reads like data; omitting the
 * row says the same thing honestly and in less space.
 */
export function sessionDetailFields(
  session: WorkspaceSession,
  formatted: { created: string; updated: string },
): SessionDetailField[] {
  const source = sessionSource(session);
  const access = sessionAccessMeta(session);
  const fields: SessionDetailField[] = [];

  const push = (label: string, value: string | null | undefined, mono?: boolean) => {
    if (typeof value === 'string' && value.length > 0) fields.push({ label, value, mono });
  };

  // Trigger metadata is meaningless for a chat a person started; it exists only
  // once something fired the session.
  if (source.kind !== 'chat') {
    push('Source', source.label);
    push('Trigger', source.triggerSlug);
  }

  push('Last activity', formatted.updated);
  push('Created', formatted.created);
  push('Owner', sessionOwnerLabel(session));
  push('Owner identity', session.owner_type ? OWNER_TYPE_LABELS[session.owner_type] : null);
  push('Owner ID', session.created_by, true);
  // "Can open" is the default; surfacing it on every row is noise.
  if (!access.canOpen) push('Your access', access.label);
  push('Agent', session.agent_name);
  push('Runtime', session.sandbox_provider);
  push('Runtime state', session.runtime_status);

  const conversationCount = (session.opencode_sessions ?? []).length;
  if (conversationCount > 0) {
    const archived = (session.opencode_sessions ?? []).filter((item) => item.archived_at).length;
    fields.push({
      label: 'Conversations',
      value: `${conversationCount}${archived > 0 ? ` · ${archived} archived` : ''}`,
    });
  }

  push('Base ref', session.base_ref, true);

  // The platform sets `session_id == sandbox_id` and defaults the branch name
  // to the session id, so all three routinely hold the SAME 36-char uuid.
  // Printing it three times is noise for the same reason a placeholder is: a
  // field earns its row by telling you something you do not already know.
  if (session.branch_name !== session.session_id) push('Branch', session.branch_name, true);
  push('Session ID', session.session_id, true);
  if (session.sandbox_id !== session.session_id) push('Sandbox ID', session.sandbox_id, true);
  push('Root conversation ID', session.opencode_session_id, true);

  return fields;
}

/** A session can only be deleted when the viewer owns a live, undeleted record. */
export function sessionIsDeletable(session: WorkspaceSession): boolean {
  return !session.deleted_at && session.can_access !== false;
}

/** Toggle one id, returning a new set so React sees the change. */
export function toggleSelection(selected: Set<string>, sessionId: string): Set<string> {
  const next = new Set(selected);
  if (!next.delete(sessionId)) next.add(sessionId);
  return next;
}

/**
 * Drop selected ids that are no longer visible.
 *
 * Without this, narrowing the filter after selecting leaves `N selected`
 * counting rows that are off screen, and `Delete N` would destroy sessions the
 * user cannot see. Selection must never outlive its own visibility.
 */
export function pruneSelection(selected: Set<string>, visible: WorkspaceSession[]): Set<string> {
  const visibleIds = new Set(visible.map((session) => session.session_id));
  const next = new Set([...selected].filter((id) => visibleIds.has(id)));
  return next.size === selected.size ? selected : next;
}

export interface BulkDeleteSummary {
  succeeded: string[];
  failed: string[];
  /** Human sentence for the toast. Never claims a success that did not happen. */
  message: string;
}

/**
 * Fold per-session delete outcomes into one honest result.
 *
 * There is no bulk delete endpoint — only
 * `DELETE /workspaces/:workspaceId/sessions/:sessionId` — so a batch can partially
 * fail. Reporting "Deleted 7 sessions" while two rows survive is worse than
 * reporting nothing, because the user stops looking.
 */
export function summarizeBulkDelete(
  results: Array<{ sessionId: string; ok: boolean }>,
): BulkDeleteSummary {
  const succeeded = results.filter((result) => result.ok).map((result) => result.sessionId);
  const failed = results.filter((result) => !result.ok).map((result) => result.sessionId);
  const total = results.length;

  if (failed.length === 0) {
    return {
      succeeded,
      failed,
      message: `Deleted ${total} ${total === 1 ? 'session' : 'sessions'}`,
    };
  }
  if (succeeded.length === 0) {
    return {
      succeeded,
      failed,
      message: `Could not delete ${failed.length === 1 ? 'the session' : `${failed.length} sessions`}`,
    };
  }
  return {
    succeeded,
    failed,
    message: `Deleted ${succeeded.length} of ${total}. ${failed.length} failed.`,
  };
}

/** Run `task` over `items` with at most `limit` in flight, preserving order. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await task(items[index]);
    }
  });

  await Promise.all(workers);
  return results;
}

export type { SessionSourceKind };
