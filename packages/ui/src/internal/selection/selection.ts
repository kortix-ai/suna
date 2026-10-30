/** Multi-select rules shared by every list that selects rows by string id. */

/** Toggle one id. */
export function toggleId(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/**
 * Shift-click: add every id between the anchor and the target, both
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
  if (from < 0 || to < 0) return toggleId(selected, target);
  const [lo, hi] = from < to ? [from, to] : [to, from];
  const next = new Set(selected);
  for (const id of ordered.slice(lo, hi + 1)) next.add(id);
  return next;
}
