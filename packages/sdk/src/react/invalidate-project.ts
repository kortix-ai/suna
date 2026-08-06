import type { QueryClient } from '@tanstack/react-query';
import { qk } from './query-keys';

/** Everything belonging to one project. Use after a write with broad effect. */
export async function invalidateProject(qc: QueryClient, projectId: string): Promise<void> {
  await qc.invalidateQueries({ queryKey: qk.project.scope(projectId) });
}

/**
 * A project's NAME lives in two caches: the list entry and the detail entry.
 * Rename previously invalidated only the list, so the sidebar and the project
 * home title disagreed until eviction. Both, always, or the bug returns.
 */
export async function invalidateProjectIdentity(
  qc: QueryClient,
  projectId: string,
): Promise<void> {
  await Promise.all([
    qc.invalidateQueries({ queryKey: qk.projects.list() }),
    qc.invalidateQueries({ queryKey: qk.project.detail(projectId) }),
  ]);
}

/**
 * Paint the new name in the same frame the rename dialog closes, instead of a
 * round-trip later. Callers still invalidate on settle; this only removes the
 * visible lag. A missing cache entry is not an error — nothing to update yet.
 */
export function writeProjectNameOptimistically(
  qc: QueryClient,
  projectId: string,
  name: string,
): void {
  qc.setQueryData(
    qk.projects.list(),
    (prev: Array<{ project_id: string; name: string }> | undefined) =>
      prev?.map((p) => (p.project_id === projectId ? { ...p, name } : p)),
  );
  qc.setQueryData(
    qk.project.detail(projectId),
    (prev: { project?: { name?: string } } | undefined) =>
      prev?.project ? { ...prev, project: { ...prev.project, name } } : prev,
  );
}
