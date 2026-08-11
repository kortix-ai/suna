import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { qk } from './query-keys';

/** Everything belonging to one workspace. Use after a write with broad effect. */
export async function invalidateWorkspace(qc: QueryClient, workspaceId: string): Promise<void> {
  await qc.invalidateQueries({ queryKey: qk.workspace.scope(workspaceId) });
}

/** @deprecated Use `invalidateWorkspace`. */
export const invalidateProject = invalidateWorkspace;

/**
 * A project's NAME lives in two caches: every projects-LIST entry and the
 * detail entry. Rename previously invalidated only `qk.workspaces.list()` — the
 * single accountless slot — so the sidebar and the project home title
 * disagreed until eviction. That was ALSO a second, narrower bug on top of
 * the first: `qk.workspaces.list(accountId)` and `qk.workspaces.list()` are
 * SIBLINGS under `qk.workspaces.scope()`, not parent and child (see
 * `query-keys.ts`'s own warning about exactly this collision shape) — so
 * invalidating `list()` alone never reached the account-scoped list every
 * real project switcher actually reads. Reaching every list form needs the
 * two-element `qk.workspaces.scope()` PREFIX, not the three-element `list()`
 * key. Both invalidations, always, or the bug returns.
 */
export async function invalidateWorkspaceIdentity(
  qc: QueryClient,
  workspaceId: string,
): Promise<void> {
  await Promise.all([
    qc.invalidateQueries({ queryKey: qk.workspaces.scope() }),
    qc.invalidateQueries({ queryKey: qk.workspace.detail(workspaceId) }),
  ]);
}

/** @deprecated Use `invalidateWorkspaceIdentity`. */
export const invalidateProjectIdentity = invalidateWorkspaceIdentity;

type WorkspacesListEntry = {
  workspace_id?: string;
  /** @deprecated Legacy Project cache compatibility. */
  project_id?: string;
  name: string;
};
type WorkspaceDetailEntry = {
  workspace?: { name?: string };
  /** @deprecated Legacy Project cache compatibility. */
  project?: { name?: string };
};

/**
 * Exactly what `writeProjectNameOptimistically` overwrote, restorable with
 * `restoreProjectName`. `lists` is an array, not a single entry, because the
 * project can be cached under several account-scoped list keys at once — see
 * `invalidateProjectIdentity`'s doc comment for why that's a prefix, not a
 * single key. A key with no snapshot row was never cached at write time, and
 * `restoreProjectName` will correctly leave it alone.
 */
export interface WorkspaceNameSnapshot {
  detail: WorkspaceDetailEntry | undefined;
  lists: Array<{ queryKey: QueryKey; data: WorkspacesListEntry[] | undefined }>;
}

/** @deprecated Use `WorkspaceNameSnapshot`. */
export type ProjectNameSnapshot = WorkspaceNameSnapshot;

/**
 * Paint the new name in the same frame the rename dialog closes, instead of a
 * round-trip later. Callers still invalidate on settle; this only removes the
 * visible lag. A missing cache entry is not an error — nothing to update yet.
 *
 * Returns a snapshot of exactly what it overwrote, so the caller can restore
 * it with `restoreProjectName` if the mutation fails — see that function's
 * doc comment for why a failed rename used to leave the optimistic name
 * cached permanently. `setQueryData` needs an exact key, so the list side
 * can't just target the `qk.workspaces.scope()` prefix directly — it fans out
 * with `setQueriesData`, verified empirically to update every matching list
 * entry and nothing outside the prefix (confirmed against the real TanStack
 * engine: two sibling list keys both update, an unrelated
 * `qk.workspace.detail` entry does not).
 */
export function writeWorkspaceNameOptimistically(
  qc: QueryClient,
  workspaceId: string,
  name: string,
): WorkspaceNameSnapshot {
  const lists = qc.getQueriesData<WorkspacesListEntry[]>({ queryKey: qk.workspaces.scope() });
  const snapshot: WorkspaceNameSnapshot = {
    detail: qc.getQueryData<WorkspaceDetailEntry>(qk.workspace.detail(workspaceId)),
    lists: lists.map(([queryKey, data]) => ({ queryKey, data })),
  };

  qc.setQueriesData<WorkspacesListEntry[] | undefined>(
    { queryKey: qk.workspaces.scope() },
    (prev) =>
      prev?.map((workspace) =>
        (workspace.workspace_id ?? workspace.project_id) === workspaceId
          ? { ...workspace, name }
          : workspace,
      ),
  );
  qc.setQueryData(
    qk.workspace.detail(workspaceId),
    (prev: WorkspaceDetailEntry | undefined) => {
      if (prev?.workspace) {
        return { ...prev, workspace: { ...prev.workspace, name } };
      }
      if (prev?.project) {
        return { ...prev, project: { ...prev.project, name } };
      }
      return prev;
    },
  );

  return snapshot;
}

/** @deprecated Use `writeWorkspaceNameOptimistically`. */
export const writeProjectNameOptimistically = writeWorkspaceNameOptimistically;

/**
 * Put back exactly what `writeProjectNameOptimistically` overwrote. THE
 * Critical-path fix: `onMutate` used to write the optimistic name but never
 * snapshot what it overwrote, and `onError` only showed a toast — so a FAILED
 * rename left the wrong name cached until `invalidateQueries` happened to hit
 * a mounted observer, which (with `refetchOnMount: false`, before that was
 * also fixed) it never did. The wrong name was permanent until a hard
 * refresh.
 *
 * Restores each snapshotted list key individually rather than re-invalidating
 * broadly: a key with no row in `snapshot.lists` was never cached at write
 * time (or was populated by an unrelated mutation AFTER the snapshot), and
 * this leaves it untouched rather than evicting data this rollback never saw.
 * `setQueryData(key, undefined)` is a verified no-op (does not evict an
 * existing entry), so a snapshot that captured nothing is safely a no-op too.
 */
export function restoreWorkspaceName(
  qc: QueryClient,
  workspaceId: string,
  snapshot: WorkspaceNameSnapshot,
): void {
  for (const { queryKey, data } of snapshot.lists) {
    qc.setQueryData(queryKey, data);
  }
  qc.setQueryData(qk.workspace.detail(workspaceId), snapshot.detail);
}

/** @deprecated Use `restoreWorkspaceName`. */
export const restoreProjectName = restoreWorkspaceName;
