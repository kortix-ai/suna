import type { SubprojectRun, InstalledSubproject } from '@kortix/sdk';

import { groupRunsBySubproject } from './subproject-runs';

/** One subproject's runs, ready to render as a row. */
export interface SubprojectReportGroup {
  slug: string;
  /** The installed subproject's title, or the slug when the manifest no longer names it. */
  title: string;
  runs: SubprojectRun[];
}

/**
 * Group a flat run list into one entry per subproject, most recently run first.
 *
 * The order falls out of the API's own ordering: runs come back newest-first
 * across every subproject, so the FIRST time a slug appears is that subproject's newest
 * run, and `Map` preserves insertion order. No second sort, and no clock.
 *
 * Titles come from the project's installed list, not the store index. A run's
 * subproject may have been withdrawn from the index — the install lives in the
 * project's manifest and outlives its catalogue entry — and a row titled with
 * the raw slug is a worse answer than the manifest's own title but a far better
 * one than a blank.
 */
export function subprojectReportGroups(
  runs: readonly SubprojectRun[],
  installed: readonly InstalledSubproject[],
): SubprojectReportGroup[] {
  const titles = new Map(installed.map((entry) => [entry.slug, entry.title]));
  return [...groupRunsBySubproject(runs)].map(([slug, subprojectRuns]) => ({
    slug,
    title: titles.get(slug) || slug,
    runs: subprojectRuns,
  }));
}
