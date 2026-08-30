import type { CraftRun, InstalledCraft } from '@kortix/sdk';

import { groupRunsByCraft } from './craft-runs';

/** One craft's runs, ready to render as a row. */
export interface CraftReportGroup {
  slug: string;
  /** The installed craft's title, or the slug when the manifest no longer names it. */
  title: string;
  runs: CraftRun[];
}

/**
 * Group a flat run list into one entry per craft, most recently run first.
 *
 * The order falls out of the API's own ordering: runs come back newest-first
 * across every craft, so the FIRST time a slug appears is that craft's newest
 * run, and `Map` preserves insertion order. No second sort, and no clock.
 *
 * Titles come from the project's installed list, not the store index. A run's
 * craft may have been withdrawn from the index — the install lives in the
 * project's manifest and outlives its catalogue entry — and a row titled with
 * the raw slug is a worse answer than the manifest's own title but a far better
 * one than a blank.
 */
export function craftReportGroups(
  runs: readonly CraftRun[],
  installed: readonly InstalledCraft[],
): CraftReportGroup[] {
  const titles = new Map(installed.map((entry) => [entry.slug, entry.title]));
  return [...groupRunsByCraft(runs)].map(([slug, craftRuns]) => ({
    slug,
    title: titles.get(slug) || slug,
    runs: craftRuns,
  }));
}
