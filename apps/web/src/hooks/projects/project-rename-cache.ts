import type { QueryClient } from '@tanstack/react-query';
import {
  invalidateProjectIdentity,
  restoreProjectName,
  writeProjectNameOptimistically,
  type ProjectNameSnapshot,
} from '@kortix/sdk/react';

/**
 * The `onMutate`/`onError`/`onSettled` trio both project-rename mutations
 * (`edit-project-modal.tsx`'s `EditProjectModal`, `settings-view.tsx`'s
 * `GeneralProjectCard`) wire into their own `useMutation`. Shared so the two
 * call sites cannot drift the way the old per-project-connectors query
 * builder once drifted from its six siblings — one copy of the
 * cache-consistency logic, two mutations that each supply only their own
 * `projectId` + `name`.
 *
 * Fixes the Critical gap in the first version of this wiring: `onMutate`
 * wrote the optimistic name but never snapshotted what it overwrote, so a
 * FAILED rename left the wrong name cached — permanently, because
 * `invalidateQueries` does not refetch an entry with no mounted observer.
 * `renameOnMutate` now returns a `ProjectNameSnapshot`; `renameOnError` uses
 * it to put back exactly what was there before.
 */

/** Wire as `onMutate`. Writes the optimistic name and returns a snapshot for
 *  `renameOnError` to restore — or `undefined` when there is no name in this
 *  patch (an icon-only edit) or no project to write against yet, in which
 *  case there is nothing to snapshot and nothing to roll back. */
export function renameOnMutate(
  queryClient: QueryClient,
  projectId: string | null | undefined,
  name: string | undefined,
): ProjectNameSnapshot | undefined {
  if (!projectId || typeof name !== 'string') return undefined;
  return writeProjectNameOptimistically(queryClient, projectId, name);
}

/** Wire as `onError`. Puts back exactly what `renameOnMutate` overwrote. A
 *  no-op when `context` is `undefined` — `renameOnMutate` wrote nothing, so
 *  there is nothing to restore. */
export function renameOnError(
  queryClient: QueryClient,
  projectId: string | null | undefined,
  context: ProjectNameSnapshot | undefined,
): void {
  if (projectId && context) restoreProjectName(queryClient, projectId, context);
}

/** Wire as `onSettled`. Runs on both success and failure: on success it
 *  reconciles the optimistic write against the server response; on failure
 *  it reconfirms the value `renameOnError` just restored. Either way every
 *  cache holding this project's name ends the mutation in agreement. Returns
 *  the invalidation promise (react-query's `onSettled` may return one and
 *  will wait for it) instead of firing it and forgetting, so a caller — or a
 *  test — can await completion. */
export function renameOnSettled(
  queryClient: QueryClient,
  projectId: string | null | undefined,
): Promise<void> {
  if (!projectId) return Promise.resolve();
  return invalidateProjectIdentity(queryClient, projectId);
}
