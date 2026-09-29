/**
 * session-cache-write — the pure pieces of this app's session-list cache
 * writes that the SDK does not provide. The writes themselves go through the
 * SDK's writers (`@kortix/sdk/react/session-list`: `upsertCachedProjectSession`,
 * `updateCachedProjectSessions`, `removeCachedProjectSession`), which reach
 * every cached list shape under `qk.project.sessionsScope(projectId)`.
 *
 * - `renameInRows` / `mergeRenamed`: the rename updaters. The SDK writes any
 *   updater; what a rename changes on a row is this app's decision.
 * - `createdSessionListRow`: a create's answer as a list row. The SDK's
 *   upsert takes a row; the 202 answer and the list-omitted metadata are
 *   this app's to handle.
 * - `listCreatedSession`, `removeListedSession`, `cachedSessionRow`: the
 *   create, the delete and the freshest-row read, over the SDK's writers.
 *
 * No React Native imports: `bun test` cannot load native modules.
 */

import type { QueryClient } from '@tanstack/react-query';
import {
  flattenProjectSessionPages,
  qk,
  removeCachedProjectSession,
  upsertCachedProjectSession,
} from '@kortix/sdk/react/session-list';

import type { ProjectSession } from '@/lib/projects/projects-client';

/**
 * A rename as the server answers it: `custom_name` set, or cleared by an
 * empty name (back to the automatic title). `name` is the resolved display
 * name and a rename wins it (apps/api `serializeSession`), so a set name goes
 * there too; a cleared one leaves `name` to the server's answer.
 */
export function renameInRows(
  rows: ProjectSession[],
  sessionId: string,
  name: string
): ProjectSession[] {
  const index = rows.findIndex((row) => row.session_id === sessionId);
  if (index === -1) return rows;
  const row = rows[index];
  const customName = name || null;
  const renamed = customName
    ? { ...row, custom_name: customName, name: customName }
    : { ...row, custom_name: null };
  if (renamed.custom_name === row.custom_name && renamed.name === row.name) return rows;
  const next = rows.slice();
  next[index] = renamed;
  return next;
}

/**
 * The server's rename, merged onto the cached row: only the fields the PATCH
 * owns. Its answer omits what the list endpoint resolves (`owner_email`,
 * `runtime_status`), so the whole answer would blank them until the refetch.
 */
export function mergeRenamed(rows: ProjectSession[], updated: ProjectSession): ProjectSession[] {
  const index = rows.findIndex((row) => row.session_id === updated.session_id);
  if (index === -1) return rows;
  const next = rows.slice();
  next[index] = {
    ...rows[index],
    name: updated.name,
    custom_name: updated.custom_name,
    updated_at: updated.updated_at,
  };
  return next;
}

/**
 * Metadata the list endpoint leaves out (apps/api
 * `LIST_OMITTED_SESSION_METADATA_KEYS`): the literal first prompt and
 * write-only bookkeeping. A created row carries them; a list row, and so the
 * stored copy of the list (lib/query), does not.
 */
const LIST_OMITTED_METADATA_KEYS = [
  'initial_prompt',
  'payload_summary',
  'session_start_timeline',
  'audit_v2',
  'remote_branch',
] as const;

/**
 * A create's answer as a list row of `projectId`, or null. The API answers
 * 201 with the session row, or 202 `{ status, command_id, session_id, reason }`
 * when it only queued the create: that one is not a row, and waits for the
 * refetch.
 */
export function createdSessionListRow(value: unknown, projectId: string): ProjectSession | null {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as Partial<ProjectSession>;
  if (
    typeof row.session_id !== 'string' ||
    row.project_id !== projectId ||
    typeof row.created_at !== 'string' ||
    typeof row.status !== 'string'
  ) {
    return null;
  }
  const session = row as ProjectSession;
  const metadata: Record<string, unknown> = session.metadata ?? {};
  if (!LIST_OMITTED_METADATA_KEYS.some((key) => key in metadata)) return session;
  const trimmed = { ...metadata };
  for (const key of LIST_OMITTED_METADATA_KEYS) delete trimmed[key];
  return { ...session, metadata: trimmed };
}

/**
 * A created session, in the cached lists now: the top of page one, or in
 * place where a refetch already brought it. A 202 (create only queued) is not
 * a row and waits for the refetch. Only lists it belongs to
 * (`upsertCachedProjectSession` decides per list): the flat lookup list and
 * the viewer's own top-level lists, never "Shared", "Automated", a search or
 * a parent's children.
 */
export function listCreatedSession(queryClient: QueryClient, projectId: string, created: unknown): void {
  const row = createdSessionListRow(created, projectId);
  if (row) upsertCachedProjectSession(queryClient, projectId, row);
}

/**
 * A deleted session, out of every paged list and parent's children now.
 * Returns the undo, for the delete the server refuses. The flat first page
 * keeps the row: it names the open thread, which keeps its title until the
 * delete succeeds (the tab then closes).
 */
export function removeListedSession(queryClient: QueryClient, projectId: string, sessionId: string): () => void {
  const flatKey = qk.project.sessions(projectId);
  const flat = queryClient.getQueryData(flatKey);
  const undo = removeCachedProjectSession(queryClient, projectId, sessionId);
  if (flat !== undefined) queryClient.setQueryData(flatKey, flat);
  return undo;
}

/**
 * A session's freshest cached row, from any cached list of the project: the
 * flat first page, each paged list (the drawer's three sections, the Sessions
 * page and its searches) and each parent's children.
 */
export function cachedSessionRow(queryClient: QueryClient, projectId: string, sessionId: string): ProjectSession | null {
  for (const [, data] of queryClient.getQueriesData({ queryKey: qk.project.sessionsScope(projectId) })) {
    const rows = Array.isArray(data)
      ? (data as ProjectSession[])
      : Array.isArray((data as { pages?: unknown } | undefined)?.pages)
        ? flattenProjectSessionPages(data as Parameters<typeof flattenProjectSessionPages>[0])
        : [];
    const row = rows.find((r) => r.session_id === sessionId);
    if (row) return row;
  }
  return null;
}
