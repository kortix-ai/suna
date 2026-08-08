import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { qk } from './query-keys';

/** Everything belonging to one project. Use after a write with broad effect. */
export async function invalidateProject(qc: QueryClient, projectId: string): Promise<void> {
  await qc.invalidateQueries({ queryKey: qk.project.scope(projectId) });
}

/**
 * A project's NAME lives in two caches: every projects-LIST entry and the
 * detail entry. Rename previously invalidated only `qk.projects.list()` — the
 * single accountless slot — so the sidebar and the project home title
 * disagreed until eviction. That was ALSO a second, narrower bug on top of
 * the first: `qk.projects.list(accountId)` and `qk.projects.list()` are
 * SIBLINGS under `qk.projects.scope()`, not parent and child (see
 * `query-keys.ts`'s own warning about exactly this collision shape) — so
 * invalidating `list()` alone never reached the account-scoped list every
 * real project switcher actually reads. Reaching every list form needs the
 * two-element `qk.projects.scope()` PREFIX, not the three-element `list()`
 * key. Both invalidations, always, or the bug returns.
 */
export async function invalidateProjectIdentity(
  qc: QueryClient,
  projectId: string,
): Promise<void> {
  await Promise.all([
    qc.invalidateQueries({ queryKey: qk.projects.scope() }),
    qc.invalidateQueries({ queryKey: qk.project.detail(projectId) }),
  ]);
}

type ProjectsListEntry = { project_id: string; name: string };
type ProjectDetailEntry = { project?: { name?: string } };

/**
 * Exactly what `writeProjectNameOptimistically` overwrote, restorable with
 * `restoreProjectName`. `lists` is an array, not a single entry, because the
 * project can be cached under several account-scoped list keys at once — see
 * `invalidateProjectIdentity`'s doc comment for why that's a prefix, not a
 * single key. A key with no snapshot row was never cached at write time, and
 * `restoreProjectName` will correctly leave it alone.
 */
export interface ProjectNameSnapshot {
  detail: ProjectDetailEntry | undefined;
  lists: Array<{ queryKey: QueryKey; data: ProjectsListEntry[] | undefined }>;
}

/**
 * Paint the new name in the same frame the rename dialog closes, instead of a
 * round-trip later. Callers still invalidate on settle; this only removes the
 * visible lag. A missing cache entry is not an error — nothing to update yet.
 *
 * Returns a snapshot of exactly what it overwrote, so the caller can restore
 * it with `restoreProjectName` if the mutation fails — see that function's
 * doc comment for why a failed rename used to leave the optimistic name
 * cached permanently. `setQueryData` needs an exact key, so the list side
 * can't just target the `qk.projects.scope()` prefix directly — it fans out
 * with `setQueriesData`, verified empirically to update every matching list
 * entry and nothing outside the prefix (confirmed against the real TanStack
 * engine: two sibling list keys both update, an unrelated
 * `qk.project.detail` entry does not).
 */
export function writeProjectNameOptimistically(
  qc: QueryClient,
  projectId: string,
  name: string,
): ProjectNameSnapshot {
  const lists = qc.getQueriesData<ProjectsListEntry[]>({ queryKey: qk.projects.scope() });
  const snapshot: ProjectNameSnapshot = {
    detail: qc.getQueryData<ProjectDetailEntry>(qk.project.detail(projectId)),
    lists: lists.map(([queryKey, data]) => ({ queryKey, data })),
  };

  qc.setQueriesData<ProjectsListEntry[] | undefined>(
    { queryKey: qk.projects.scope() },
    (prev) => prev?.map((p) => (p.project_id === projectId ? { ...p, name } : p)),
  );
  qc.setQueryData(
    qk.project.detail(projectId),
    (prev: ProjectDetailEntry | undefined) =>
      prev?.project ? { ...prev, project: { ...prev.project, name } } : prev,
  );

  return snapshot;
}

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
export function restoreProjectName(
  qc: QueryClient,
  projectId: string,
  snapshot: ProjectNameSnapshot,
): void {
  for (const { queryKey, data } of snapshot.lists) {
    qc.setQueryData(queryKey, data);
  }
  qc.setQueryData(qk.project.detail(projectId), snapshot.detail);
}
