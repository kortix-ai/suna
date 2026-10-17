/**
 * Duration-balanced browser sharding.
 *
 * Playwright's native `--shard=N/M` splits by test COUNT. Journey durations
 * differ by 100x, so the split left one release-gate shard at 28 min beside
 * two at 13 min. This planner partitions whole spec files by MEASURED
 * duration instead, and the runner hands each shard its files by path.
 *
 * - The unit is the spec file: one file's tests stay together, so any
 *   `describe.serial` or shared module state stays safe.
 * - The weights are `e2e/shard-durations.json`, summed per file from CI logs
 *   by `bin/refresh-shard-durations.ts`. One table per target: the deployed
 *   gate runs journeys the local stack skips (billing, sdk-only, templates).
 * - Longest-processing-time greedy bin packing. Ties break by path, so every
 *   shard computes the same partition with no coordination.
 * - A spec missing from the table takes the median weight, so a new file lands
 *   in exactly one shard before the next refresh.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type ShardTarget = 'local' | 'deployed';
export type DurationTable = Record<string, number>;

const TESTS_DIR = resolve(import.meta.dirname, '../..');
export const SPECS_DIR = 'e2e/specs';

export function listSpecFiles(testsDir = TESTS_DIR): string[] {
  return readdirSync(resolve(testsDir, SPECS_DIR))
    .filter((name) => name.endsWith('.spec.ts'))
    .sort()
    .map((name) => `${SPECS_DIR}/${name}`);
}

export function loadDurations(target: ShardTarget, testsDir = TESTS_DIR): DurationTable {
  const file = resolve(testsDir, 'e2e/shard-durations.json');
  return JSON.parse(readFileSync(file, 'utf8'))[target] ?? {};
}

function median(values: number[]): number {
  if (values.length === 0) return 1;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** The spec files of shard `current` of `total`, sorted. Throws on an empty shard. */
export function planBrowserShard(opts: {
  specs: string[];
  durations: DurationTable;
  current: number;
  total: number;
}): string[] {
  const { specs, durations, current, total } = opts;
  const fallback = median(specs.flatMap((s) => (s in durations ? [durations[s]!] : [])));
  const weighted = specs
    .map((spec) => ({ spec, weight: durations[spec] ?? fallback }))
    .sort((a, b) => b.weight - a.weight || (a.spec < b.spec ? -1 : 1));
  const loads = Array.from({ length: total }, () => 0);
  const bins: string[][] = Array.from({ length: total }, () => []);
  for (const { spec, weight } of weighted) {
    const lightest = loads.indexOf(Math.min(...loads));
    loads[lightest]! += weight;
    bins[lightest]!.push(spec);
  }
  const mine = bins[current - 1]!.sort();
  // An empty list would make Playwright run EVERY spec, not none.
  if (mine.length === 0) {
    throw new Error(`browser shard ${current}/${total} has no spec files (${specs.length} specs)`);
  }
  return mine;
}
