import type { QueryClient } from '@tanstack/react-query';
import {
  invalidateProjectIdentity,
  restoreProjectName,
  writeProjectNameOptimistically,
  type ProjectNameSnapshot,
} from '@kortix/sdk/react';

/**
 * The `onMutate`/`onError`/`onSettled` trio a project-rename mutation wires
 * into its own `useMutation` — today just `settings-view.tsx`'s
 * `GeneralProjectCard`.
 *
 * Originally shared between that card and `edit-project-modal.tsx`'s
 * `EditProjectModal` so the two call sites could not drift the way the old
 * per-project-connectors query builder once drifted from its six siblings.
 * The workspace-switcher work deleted that modal and moved icon editing into
 * the card, leaving one caller. These stay extracted anyway: what they own is
 * the snapshot/restore invariant below, which is worth stating in one place
 * and testing directly (`project-rename-cache.test.ts`) whether it has one
 * caller or two — and a second rename path is exactly the kind of thing that
 * gets added later.
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
