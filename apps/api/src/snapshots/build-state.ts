/** Pure helpers for interpreting the append-only snapshot build log. */

export type SnapshotBuildStateLike = {
  status: 'building' | 'ready' | 'failed';
};

/**
 * `listSnapshotBuilds` returns newest build attempt first. A sandbox is only in a
 * "failed build" state when that newest attempt failed. Older failed rows are
 * history and must not keep the sidebar/customize alert red after a newer ready
 * or building attempt exists.
 */
export function currentFailedSnapshotBuild<T extends SnapshotBuildStateLike>(
  builds: readonly T[],
): T | null {
  const latest = builds[0] ?? null;
  return latest?.status === 'failed' ? latest : null;
}
