import type { UiTranslator } from '@/i18n/translator';
import { runtimeSessionsOf, type ProjectSession } from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';
import type { QueryClient } from '@tanstack/react-query';

import {
  matchesSourceFilters,
  matchesStatusFilters,
  sessionSource,
  type SessionSourceFilter,
  type SessionSourceKind,
  type SessionStatusFilter,
} from '@/components/projects/session-label';
import {
  getSessionDisplayTitle,
  sortSessionsByLastActivity,
} from '@/features/workspace/project-sidebar/project-session-list-helpers';

import {
  matchesAccessFilters,
  matchesOwnerFilters,
  type SessionAccessFilter,
} from './session-owner-filters';

/**
 * The owner column's label. A named owner renders verbatim; the fallbacks
 * route through the catalog so they translate with the viewer's locale.
 */
export function sessionOwnerLabel(
  session: ProjectSession,
  tI18nComplete: UiTranslator,
): string {
  if (session.owner_name) return session.owner_name;
  if (session.owner_email) return session.owner_email;
  if (session.is_owner === true) return tI18nComplete.raw('text08b041935798');
  return tI18nComplete.raw('text0b6a47661327');
}

export function sessionAccessMeta(
  session: ProjectSession,
  tI18nComplete: UiTranslator,
): {
  label: 'Can open' | 'Metadata only' | 'Runtime unavailable' | 'Deleted';
  canOpen: boolean;
} {
  if (session.deleted_at) return { label: tI18nComplete.raw('textb48ff39c2e0f'), canOpen: false };
  if (session.can_access === false)
    return { label: tI18nComplete.raw('textdf0453d185c4'), canOpen: false };
  if (session.status === 'stopped' && !session.runtime_status) {
    return { label: tI18nComplete.raw('text9ded5a3c7a7d'), canOpen: false };
  }
  if (session.runtime_status === 'archived' || session.runtime_status === 'error') {
    return { label: tI18nComplete.raw('text9ded5a3c7a7d'), canOpen: false };
  }
  return { label: tI18nComplete.raw('textda56a3718077'), canOpen: true };
}

/**
 * The sessions page's client-side facets: the sidebar's two multi-select
 * facets, then the page-only owner and access facets. Free-text search is NOT
 * here — it is the server's `q`, which reaches every session the viewer may
 * open, not only the pages already loaded. Newest activity first.
 */
export function filterProjectSessions(
  sessions: ProjectSession[],
  statusFilters: readonly SessionStatusFilter[],
  sourceFilters: readonly SessionSourceFilter[],
  tI18nComplete: UiTranslator,
  facets: { owners?: readonly string[]; access?: readonly SessionAccessFilter[] } = {},
): ProjectSession[] {
  const matches = sessions.filter(
    (session) =>
      matchesStatusFilters(session, statusFilters) &&
      matchesSourceFilters(session, sourceFilters, tI18nComplete) &&
      matchesOwnerFilters(session, facets.owners ?? []) &&
      matchesAccessFilters(session, facets.access ?? []),
  );
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
  session: ProjectSession,
  formatted: { created: string; updated: string },
  tI18nComplete: UiTranslator,
): SessionDetailField[] {
  const source = sessionSource(session, tI18nComplete);
  const access = sessionAccessMeta(session, tI18nComplete);
  const fields: SessionDetailField[] = [];

  const push = (label: string, value: string | null | undefined, mono?: boolean) => {
    if (typeof value === 'string' && value.length > 0) fields.push({ label, value, mono });
  };

  // Trigger metadata is meaningless for a chat a person started; it exists only
  // once something fired the session.
  if (source.kind !== 'chat') {
    push(tI18nComplete.raw('text0e570ca6fabe'), source.label); // Source
    push(tI18nComplete.raw('text8b9c643731c9'), source.triggerSlug); // Trigger
  }

  push(tI18nComplete.raw('text06475633ed3e'), formatted.updated); // Last activity
  push(tI18nComplete.raw('textd70b9e24bca2'), formatted.created); // Created
  push(tI18nComplete.raw('text4b1b8aa3608a'), sessionOwnerLabel(session, tI18nComplete)); // Owner
  push('Owner identity', session.owner_type ? OWNER_TYPE_LABELS[session.owner_type] : null);
  push('Owner ID', session.created_by, true);
  // "Can open" is the default; surfacing it on every row is noise.
  if (!access.canOpen) push('Your access', access.label);
  push('Agent', session.agent_name);
  push('Runtime', session.sandbox_provider);
  push('Runtime state', session.runtime_status);

  const conversations = runtimeSessionsOf(session);
  const conversationCount = conversations.length;
  if (conversationCount > 0) {
    const archived = conversations.filter((item) => item.archived_at).length;
    fields.push({
      label: tI18nComplete.raw('text1d432f58690c'),
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
  push('Root conversation ID', session.runtime_session_id ?? session.opencode_session_id, true);

  return fields;
}

/** The bulk-delete confirm button's label: "Delete 5", in the caller's locale. */
export function bulkDeleteConfirmLabel(
  selectedCount: number,
  tI18nComplete: UiTranslator,
): string {
  return tI18nComplete('text8782b778c202', { value0: selectedCount });
}

/** A session can only be deleted when the viewer owns a live, undeleted record. */
export function sessionIsDeletable(session: ProjectSession): boolean {
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
export function pruneSelection(selected: Set<string>, visible: ProjectSession[]): Set<string> {
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
 * `DELETE /projects/:projectId/sessions/:sessionId` — so a batch can partially
 * fail. Reporting "Deleted 7 sessions" while two rows survive is worse than
 * reporting nothing, because the user stops looking.
 */
export function summarizeBulkDelete(
  results: Array<{ sessionId: string; ok: boolean }>,
  tI18nComplete: UiTranslator,
): BulkDeleteSummary {
  const succeeded: string[] = [];
  const failed: string[] = [];
  for (const result of results) {
    (result.ok ? succeeded : failed).push(result.sessionId);
  }
  const total = results.length;

  if (failed.length === 0) {
    return {
      succeeded,
      failed,
      message: tI18nComplete('texte4cfda0cefb3', {
        value0: total,
        value1: total === 1 ? 'session' : 'sessions',
      }),
    };
  }
  if (succeeded.length === 0) {
    return {
      succeeded,
      failed,
      message: tI18nComplete('text2fcbf32eccad', {
        value0: failed.length === 1 ? 'the session' : `${failed.length} sessions`,
      }),
    };
  }
  return {
    succeeded,
    failed,
    message: tI18nComplete('text170c6185473e', {
      value0: succeeded.length,
      value1: total,
      value2: failed.length,
    }),
  };
}

/**
 * The scope whose list this device already holds for these filters, the newer
 * of the two, or null. The page reads the manager-only 'project' scope or the
 * default 'visible' one, and the permission probe that decides is not kept
 * across a reload: until it answered, a manager saw skeleton rows over a list
 * the restored cache held. Both entries came from this user's own earlier
 * reads (the persisted cache is per user), and the probe's answer replaces
 * the choice.
 */
export function cachedSessionsScope(
  queryClient: Pick<QueryClient, 'getQueryState'>,
  projectId: string,
  filters: Parameters<typeof qk.project.sessionsPaged>[2],
): 'project' | 'visible' | null {
  let newest: { scope: 'project' | 'visible'; at: number } | null = null;
  for (const scope of ['project', 'visible'] as const) {
    const state = queryClient.getQueryState(qk.project.sessionsPaged(projectId, scope, filters));
    if (state?.data === undefined) continue;
    if (!newest || state.dataUpdatedAt > newest.at) newest = { scope, at: state.dataUpdatedAt };
  }
  return newest?.scope ?? null;
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
