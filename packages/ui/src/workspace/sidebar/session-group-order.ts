/**
 * The project's session groups in a new order, for `PUT /session-groups/order`
 * (every id, once). Null when nothing would move, so a caller sends no request
 * and a menu item can render disabled.
 */

/** `ids` with `id` moved to `index`, clamped to the ends: a group dropped on another takes its place. */
export function moveGroupTo(ids: readonly string[], id: string, index: number): string[] | null {
  const from = ids.indexOf(id);
  if (from === -1) return null;
  const to = Math.max(0, Math.min(ids.length - 1, index));
  if (to === from) return null;
  const next = ids.filter((other) => other !== id);
  next.splice(to, 0, id);
  return next;
}

/** `ids` with `id` moved one place up (`-1`) or down (`1`). Null at that end. */
export function moveGroupBy(ids: readonly string[], id: string, delta: -1 | 1): string[] | null {
  const from = ids.indexOf(id);
  const to = from + delta;
  if (from === -1 || to < 0 || to >= ids.length) return null;
  return moveGroupTo(ids, id, to);
}
