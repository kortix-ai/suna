import type { ProjectSession } from '@kortix/sdk';
import { mapProjectSessionListCache } from '@kortix/sdk/react';
import type { QueryClient, QueryKey } from '@tanstack/react-query';

/**
 * Writes a rename into a project-session list without touching any other row.
 *
 * Extracted so the rename mutation's `onMutate` (optimistic write, fired
 * before the request lands) and a plain unit test call the SAME function —
 * no React Query, no network, no mock. `qk.project.sessions(projectId)` has
 * seven readers (sidebar, session list, tab bar, command palette, review
 * center, gateway overview); writing here settles all of them at once instead
 * of waiting for the post-mutation refetch.
 *
 * Total: a `sessionId` that is not in `sessions` returns `sessions` UNCHANGED
 * (same array reference) rather than throwing — `onMutate` runs against a
 * client-cached snapshot that can already be stale by the time it fires (the
 * row may have been deleted, or the cache may not be populated yet).
 *
 * `name` mirrors the API's own clear-vs-set rule
 * (`apps/api/src/projects/routes/r7.ts`): an empty string clears the override
 * (`custom_name: null`, reverting to the auto title) rather than storing `''`.
 */
export function applySessionRename(
  sessions: ProjectSession[],
  sessionId: string,
  name: string,
): ProjectSession[] {
  const index = sessions.findIndex((session) => session.session_id === sessionId);
  if (index === -1) return sessions;

  const next = sessions.slice();
  next[index] = { ...next[index], custom_name: name || null };
  return next;
}

/** Every list entry the optimistic write touched, as it was before. */
export type RenameSnapshot = Array<[QueryKey, unknown]>;

/**
 * `onMutate`'s cache write, extracted so it can be driven against a real
 * `QueryClient` in a unit test — no component mount, no `mock.module`.
 *
 * `queryKey` is a PREFIX: the rename modal passes the list family
 * (`[...qk.project.sessionsScope(id), 'list']`), so every loaded list is
 * painted — both scopes, and both cache shapes (a bare array, and the paged
 * `{ pages, pageParams }` entry the sidebar reads). Returns the snapshot the
 * caller must pass to `rollbackOptimisticRename` on failure. Caller is
 * expected to have already run `cancelQueries` on `queryKey`; that step is
 * async and stays in the mutation, not here.
 */
export function beginOptimisticRename(
  queryClient: QueryClient,
  queryKey: QueryKey,
  sessionId: string | null,
  name: string,
): { previous: RenameSnapshot } {
  if (!sessionId) return { previous: [] };
  const previous = queryClient
    .getQueriesData<unknown>({ queryKey })
    .filter(([, data]) => data !== undefined);
  queryClient.setQueriesData<unknown>({ queryKey }, (data: unknown) =>
    mapProjectSessionListCache(data, (sessions) => applySessionRename(sessions, sessionId, name)),
  );
  return { previous };
}

/**
 * `onSuccess`'s cache write: the rename's authoritative result, merged onto the
 * row that is already cached.
 *
 * MERGED, not replaced. `PATCH /projects/:id/sessions/:id` serializes its
 * response with `serializeSession(row, { grants, viewerId, canManageProject })`
 * (`apps/api/src/projects/routes/r7.ts`) — it passes no `ownerEmail`,
 * `ownerName`, `runtimeStatus` or `deletedAt`, so those come back `null` even
 * though the LIST endpoint resolves and populates them. Writing the response
 * wholesale therefore blanked `owner_email` on a SHARED session — the field
 * `share-session-modal.tsx` reads for "shared by X" — until `onSettled`'s
 * refetch landed. Only the three fields this endpoint actually owns are taken.
 */
export function applyRenameResponse(
  sessions: ProjectSession[],
  updated: ProjectSession,
): ProjectSession[] {
  return sessions.map((session) =>
    session.session_id === updated.session_id
      ? {
          ...session,
          name: updated.name,
          custom_name: updated.custom_name,
          updated_at: updated.updated_at,
        }
      : session,
  );
}

/** `applyRenameResponse` over every loaded list under the `queryKey` prefix. */
export function applyRenameResponseToCache(
  queryClient: QueryClient,
  queryKey: QueryKey,
  updated: ProjectSession,
): void {
  queryClient.setQueriesData<unknown>({ queryKey }, (data: unknown) =>
    mapProjectSessionListCache(data, (sessions) => applyRenameResponse(sessions, updated)),
  );
}

/**
 * `onError`'s restore: puts every list `beginOptimisticRename` snapshotted back
 * into the cache. An empty snapshot (nothing was cached) is a no-op, not a
 * clear.
 */
export function rollbackOptimisticRename(queryClient: QueryClient, previous: RenameSnapshot): void {
  for (const [key, data] of previous) {
    queryClient.setQueryData(key, data);
  }
}
