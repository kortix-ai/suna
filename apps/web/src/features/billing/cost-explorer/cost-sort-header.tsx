'use client';

import { IconChevronDown, IconChevronUp, IconSort } from '@/components/ui/kortix-icons';
import { TableHead } from '@/components/ui/table';
import { cn } from '@/lib/utils';

/** The two values `aria-sort` takes on the active column. The attribute is
 *  absent — not `"none"` — on every other column, which is what tells assistive
 *  technology that exactly one column is ordering the table. */
export type CostSortDirection = 'ascending' | 'descending';

export interface CostSortHeaderProps {
  label: string;
  /** `undefined` when this column is not the active sort. */
  direction?: CostSortDirection;
  /** Right for the numeric columns, matching their cells. */
  align?: 'left' | 'right';
  onSort: () => void;
}

/**
 * A sortable `<th>` for the cost tables.
 *
 * Only columns the API can actually order are built with this. A header that
 * looks clickable and does nothing is worse than a plain one, so
 * `workspaces-level.tsx` and `sessions-level.tsx` each map their sortable columns
 * to the sort tokens their route accepts and leave the rest as plain
 * `TableHead`s.
 *
 * The control is a real `<button>` INSIDE the `<th>`, not a click handler on
 * the `<th>` itself: a `<th>` is not focusable, gets no Enter/Space handling,
 * and cannot take a focus ring — so a handler there is a mouse-only control.
 *
 * `-my-2 py-2` gives the button the row's full height as its hit area while
 * cancelling its own padding, so the header row's density is unchanged.
 */
export function CostSortHeader({ label, direction, align = 'left', onSort }: CostSortHeaderProps) {
  return (
    <TableHead aria-sort={direction} className={align === 'right' ? 'text-right' : undefined}>
      <button
        type="button"
        onClick={onSort}
        className={cn(
          'group/sort hover:text-foreground focus-visible:ring-ring/50 -my-2 inline-flex cursor-pointer items-center gap-1 rounded-sm py-2 outline-none focus-visible:ring-2',
          // The indicator sits on the inboard side of a right-aligned column,
          // so the LABEL's right edge stays flush with the numbers below it.
          // Reversing the flex direction rather than floating the icon keeps
          // it inside the cell's own alignment.
          align === 'right' && 'flex-row-reverse',
        )}
      >
        {label}
        {direction ? (
          <SortIndicator direction={direction} />
        ) : (
          // Sortable but not active. Revealed on hover or keyboard focus, and
          // it occupies the same box as the active indicator at all times — so
          // sorting a column never shifts its label sideways. Tailwind v4
          // scopes `hover:` to `@media (hover: hover)` on its own, which is why
          // this codebase never hand-rolls that query, and why the focus half
          // is required rather than decorative.
          <IconSort
            aria-hidden="true"
            className="size-3 shrink-0 opacity-0 transition-opacity duration-150 ease-out group-hover/sort:opacity-60 group-focus-visible/sort:opacity-60"
          />
        )}
      </button>
    </TableHead>
  );
}

/** The active column's direction glyph. `aria-hidden` — `aria-sort` on the
 *  `<th>` already carries this to assistive technology, and announcing it
 *  twice reads as two separate facts. */
function SortIndicator({ direction }: { direction: CostSortDirection }) {
  const Icon = direction === 'ascending' ? IconChevronUp : IconChevronDown;
  return <Icon aria-hidden="true" className="size-3 shrink-0" />;
}
