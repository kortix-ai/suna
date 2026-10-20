/**
 * Multi-select on the Triggers page: the pure selection rules and the
 * sequential bulk runner. There is no bulk trigger API, and every PATCH or
 * DELETE commits the manifest, so a bulk action runs one trigger at a time
 * (concurrency 1) to avoid commit conflicts.
 */

export { selectRange, toggleId as toggleSlug } from '../../../workspace/selection/selection';

/** Select all: every trigger the current filter and search show. */
export function selectAllShown(shown: readonly { slug: string }[]): Set<string> {
  return new Set(shown.map((t) => t.slug));
}

/** What a bulk Pause or Resume would change: the selected triggers not already in that state. */
export function bulkTargets<T extends { slug: string; enabled: boolean }>(
  triggers: readonly T[],
  selected: ReadonlySet<string>,
  enable: boolean,
): T[] {
  return triggers.filter((t) => selected.has(t.slug) && t.enabled !== enable);
}

export interface BulkTally {
  ok: number;
  failed: number;
  /** Each failed item's error message, in order. */
  errors: string[];
  /** The run stopped early (`isCancelled`), so some items were not tried. */
  cancelled: boolean;
}

/**
 * Runs `fn` over `items` one at a time, reporting progress; never throws.
 * `isCancelled` is checked between items (the page unmounted).
 */
export async function runSequentially<T>(
  items: readonly T[],
  fn: (item: T) => Promise<unknown>,
  onProgress?: (done: number, total: number) => void,
  isCancelled?: () => boolean,
): Promise<BulkTally> {
  const tally: BulkTally = { ok: 0, failed: 0, errors: [], cancelled: false };
  for (const [i, item] of items.entries()) {
    if (isCancelled?.()) {
      tally.cancelled = true;
      break;
    }
    onProgress?.(i + 1, items.length);
    try {
      await fn(item);
      tally.ok += 1;
    } catch (err) {
      tally.failed += 1;
      tally.errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  return tally;
}

/** The selection the bulk actions act on: only what the current filter and search show. */
export function visibleSelection(
  shown: readonly { slug: string }[],
  selected: ReadonlySet<string>,
): Set<string> {
  return new Set(shown.filter((t) => selected.has(t.slug)).map((t) => t.slug));
}
