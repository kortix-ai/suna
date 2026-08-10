import type { QueryClient } from '@tanstack/react-query';
import {
  invalidateWorkspaceIdentity,
  restoreWorkspaceName,
  writeWorkspaceNameOptimistically,
  type WorkspaceNameSnapshot,
} from '@kortix/sdk/react';

/**
 * The `onMutate`/`onError`/`onSettled` trio a workspace-rename mutation wires
 * into its own `useMutation` — today just `settings-view.tsx`'s
 * `WorkspaceCard`.
 *
 * Originally shared between that card and `edit-workspace-modal.tsx`'s
 * Workspace edit modal so the two call sites could not drift the way the old
 * per-workspace-connectors query builder once drifted from its six siblings.
 * The workspace-switcher work deleted that modal and moved icon editing into
 * the card, leaving one caller. These stay extracted anyway: what they own is
 * the snapshot/restore invariant below, which is worth stating in one place
 * and testing directly (`workspace-rename-cache.test.ts`) whether it has one
 * caller or two — and a second rename path is exactly the kind of thing that
 * gets added later.
 *
 * Fixes the Critical gap in the first version of this wiring: `onMutate`
 * wrote the optimistic name but never snapshotted what it overwrote, so a
 * FAILED rename left the wrong name cached — permanently, because
 * `invalidateQueries` does not refetch an entry with no mounted observer.
 * `renameOnMutate` now returns a `WorkspaceNameSnapshot`; `renameOnError` uses
 * it to put back exactly what was there before.
 */

/** Wire as `onMutate`. Writes the optimistic name and returns a snapshot for
 *  `renameOnError` to restore — or `undefined` when there is no name in this
 *  patch (an icon-only edit) or no workspace to write against yet, in which
 *  case there is nothing to snapshot and nothing to roll back. */
export function renameOnMutate(
  queryClient: QueryClient,
  workspaceId: string | null | undefined,
  name: string | undefined,
): WorkspaceNameSnapshot | undefined {
  if (!workspaceId || typeof name !== 'string') return undefined;
  return writeWorkspaceNameOptimistically(queryClient, workspaceId, name);
}

/** Wire as `onError`. Puts back exactly what `renameOnMutate` overwrote. A
 *  no-op when `context` is `undefined` — `renameOnMutate` wrote nothing, so
 *  there is nothing to restore. */
export function renameOnError(
  queryClient: QueryClient,
  workspaceId: string | null | undefined,
  context: WorkspaceNameSnapshot | undefined,
): void {
  if (workspaceId && context) restoreWorkspaceName(queryClient, workspaceId, context);
}

/** Wire as `onSettled`. Runs on both success and failure: on success it
 *  reconciles the optimistic write against the server response; on failure
 *  it reconfirms the value `renameOnError` just restored. Either way every
 *  cache holding this workspace's name ends the mutation in agreement. Returns
 *  the invalidation promise (react-query's `onSettled` may return one and
 *  will wait for it) instead of firing it and forgetting, so a caller — or a
 *  test — can await completion. */
export function renameOnSettled(
  queryClient: QueryClient,
  workspaceId: string | null | undefined,
): Promise<void> {
  if (!workspaceId) return Promise.resolve();
  return invalidateWorkspaceIdentity(queryClient, workspaceId);
}
