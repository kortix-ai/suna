/**
 * Which "nothing to show" copy applies, given a catalog's total item count
 * and the count left after the current filter/search. Shared by every
 * capability catalog (skills, commands, ...) — the logic has no domain-specific
 * shape, only counts in and a three-way outcome out, so one implementation
 * here is the only way the skills and commands pages can't drift apart on it.
 * Lives at the `capabilities/` root, not inside `skills/`, for the same reason
 * `capability-page-shell.tsx`/`catalog-card.tsx`/`catalog-grid.tsx` do: it
 * carries zero knowledge of any one catalog's domain.
 *
 * `null` means there is content to render — the caller shouldn't reach for
 * either empty variant. `'empty'` is the catalog genuinely has zero items
 * (the "Create a ..." invitation is honest here). `'no-match'` is items exist
 * but the current filter/search hid all of them — telling the user "No ...
 * yet" in that case is false and points at the wrong action (they need to
 * clear the filter, not create anything).
 */
export function catalogEmptyKind(
  totalCount: number,
  filteredCount: number,
): 'empty' | 'no-match' | null {
  if (filteredCount > 0) return null;
  return totalCount === 0 ? 'empty' : 'no-match';
}
