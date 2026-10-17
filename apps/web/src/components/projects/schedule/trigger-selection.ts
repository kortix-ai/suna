/**
 * Multi-select on the Triggers page: the pure selection rules and the
 * sequential bulk runner. There is no bulk trigger API, and every PATCH or
 * DELETE commits the manifest, so a bulk action runs one trigger at a time
 * (concurrency 1) to avoid commit conflicts.
 */

/** Toggle one slug. */
export function toggleSlug(selected: ReadonlySet<string>, slug: string): Set<string> {
  const next = new Set(selected);
  if (next.has(slug)) next.delete(slug);
  else next.add(slug);
  return next;
}

/**
 * Shift-click: add every slug between the anchor and the target, both
 * included, in list order. Without an anchor in the list it toggles the target.
 */
export function selectRange(
  selected: ReadonlySet<string>,
  ordered: readonly string[],
  anchor: string | null,
  target: string,
): Set<string> {
  const from = anchor ? ordered.indexOf(anchor) : -1;
  const to = ordered.indexOf(target);
  if (from < 0 || to < 0) return toggleSlug(selected, target);
  const [lo, hi] = from < to ? [from, to] : [to, from];
  const next = new Set(selected);
  for (const slug of ordered.slice(lo, hi + 1)) next.add(slug);
  return next;
}

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
}

/** Runs `fn` over `items` one at a time, reporting progress; never throws. */
export async function runSequentially<T>(
  items: readonly T[],
  fn: (item: T) => Promise<unknown>,
  onProgress?: (done: number, total: number) => void,
): Promise<BulkTally> {
  const tally: BulkTally = { ok: 0, failed: 0 };
  for (const [i, item] of items.entries()) {
    onProgress?.(i + 1, items.length);
    try {
      await fn(item);
      tally.ok += 1;
    } catch {
      tally.failed += 1;
    }
  }
  return tally;
}
