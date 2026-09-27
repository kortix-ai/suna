/**
 * Statistics for the latency benchmark's repeated-run report.
 *
 * The turn-latency spec (PR #7840)'s own §1 measurement found a 2.7x spread
 * across three identical prompts on one warm box — a single run proves
 * nothing. `pnpm test -- --latency` runs >=5 iterations and reports median
 * and spread here, never one number. Pure and clock-free, so it is unit
 * tested directly (`tests/unit/latency-stats.test.ts`).
 */

export interface Stats {
  count: number;
  min: number;
  max: number;
  median: number;
  mean: number;
  p90: number;
  /** max / min. Infinity when min is 0 and max is not; 1 when every sample is equal. */
  spread: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 1) return sorted[0]!;
  const rank = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower]!;
  const weight = rank - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

export function computeStats(samplesMs: number[]): Stats {
  if (samplesMs.length === 0) {
    throw new Error('computeStats requires at least one sample');
  }
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const count = sorted.length;
  const min = sorted[0]!;
  const max = sorted[count - 1]!;
  const mean = sorted.reduce((sum, v) => sum + v, 0) / count;
  const mid = Math.floor(count / 2);
  const median = count % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
  const spread = min === 0 ? (max === 0 ? 1 : Infinity) : max / min;
  return { count, min, max, median, mean, p90: percentile(sorted, 90), spread };
}

/** `4ms` under 1s, `4.90s` at or above 1s — matches §1's own table formatting. */
export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}
