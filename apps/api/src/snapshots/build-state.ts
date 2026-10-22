/** Pure helpers for interpreting the append-only snapshot build log. */

import { isWarmBuildSlug } from './build-slug';

export type SnapshotBuildStateLike = {
  status: 'building' | 'ready' | 'failed';
};

export type SnapshotBuildWithSlug = SnapshotBuildStateLike & {
  slug: string;
};

/**
 * Per-project warm images are optional accelerators. Their build state does not
 * describe whether a shared or custom session template can launch.
 */
export function sessionTemplateBuilds<T extends SnapshotBuildWithSlug>(
  builds: readonly T[],
): T[] {
  return builds.filter((build) => !isWarmBuildSlug(build.slug));
}
