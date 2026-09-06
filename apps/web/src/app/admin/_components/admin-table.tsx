'use client';

import {
  ArrowDownIcon,
  ArrowUpIcon,
  CaretLeftIcon,
  CaretRightIcon,
  MagnifyingGlassIcon,
} from '@phosphor-icons/react';

import { Button } from '@/components/ui/button';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import { TableHead } from '@/components/ui/table';
import { cn } from '@/lib/utils';

/**
 * The console's search field. `InputGroupSearch` is the system's search
 * primitive (`kortix-design-system` → *Required primitives*); the three admin
 * pages previously used `PageSearchBar`, whose input is `rounded-2xl` — a
 * marketing radius on an app-chrome control.
 *
 * `variant="popover"` puts it on the same surface token as the panels beside
 * it, and `size="sm"` matches the `size="sm"` buttons it shares a header row
 * with.
 */
export function AdminSearch({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <InputGroupSearch>
      <InputGroupSearchIcon>
        <MagnifyingGlassIcon />
      </InputGroupSearchIcon>
      <InputGroupSearchInput
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        variant="popover"
        size="sm"
      />
      <InputGroupSearchClear onClick={() => onChange('')} />
    </InputGroupSearch>
  );
}

/**
 * A sortable column header.
 *
 * Generic over the column union so Accounts, Projects and Sandboxes share one
 * implementation instead of the three near-identical copies this replaces.
 *
 * Type matches `TableHead`'s own `text-sm font-normal` rather than the
 * letter-spaced uppercase the copies drew — a sortable header is still a table
 * header, and making three of a table's six headers look like a different
 * element was the loudest thing on the page.
 *
 * No transition on the arrow. Sorting is a click the operator repeats while
 * scanning, and the arrow is the answer to "which column am I sorted by" — it
 * has to be true on the frame the click lands, not 150ms later.
 */
export function AdminSortHeader<TColumn extends string>({
  label,
  column,
  sortBy,
  sortDir,
  onSort,
  align = 'left',
}: {
  label: string;
  column: TColumn;
  sortBy: TColumn;
  sortDir: 'asc' | 'desc';
  onSort: (column: TColumn) => void;
  align?: 'left' | 'right';
}) {
  const active = sortBy === column;
  return (
    <TableHead className={align === 'right' ? 'text-right' : undefined}>
      <button
        type="button"
        onClick={() => onSort(column)}
        aria-label={`Sort by ${label}`}
        className={cn(
          'inline-flex cursor-pointer items-center gap-1 text-sm outline-none',
          'focus-visible:ring-ring rounded-sm focus-visible:ring-2',
          active ? 'text-foreground font-medium' : 'text-muted-foreground hover:text-foreground',
          align === 'right' && 'flex-row-reverse',
        )}
      >
        {label}
        {/* The idle arrow keeps its box so the label does not shift by 12px
            the first time a column is sorted. */}
        {active && sortDir === 'asc' ? (
          <ArrowUpIcon className="size-3 shrink-0" />
        ) : (
          <ArrowDownIcon className={cn('size-3 shrink-0', !active && 'opacity-0')} />
        )}
      </button>
    </TableHead>
  );
}

/**
 * Page N of M, with the two controls that move between them.
 *
 * Renders nothing for a single page — a pager that can only ever be disabled
 * is chrome that teaches the reader nothing.
 */
export function AdminPagination({
  page,
  pages,
  total,
  noun,
  onPageChange,
}: {
  page: number;
  pages: number;
  total: number;
  /** Plural noun for the total, e.g. `projects`. */
  noun: string;
  onPageChange: (page: number) => void;
}) {
  if (pages <= 1) return null;

  return (
    <div className="text-muted-foreground flex items-center justify-between gap-3 text-xs">
      <span className="tabular-nums">
        Page {page} of {pages} · {total.toLocaleString()} {noun}
      </span>
      <div className="flex gap-2">
        <Button
          variant="outline"
          className="gap-1.5"
          onClick={() => onPageChange(Math.max(1, page - 1))}
          disabled={page === 1}
        >
          <CaretLeftIcon className="size-4 shrink-0" />
          Previous
        </Button>
        <Button
          variant="outline"
          className="gap-1.5"
          onClick={() => onPageChange(Math.min(pages, page + 1))}
          disabled={page === pages}
        >
          Next
          <CaretRightIcon className="size-4 shrink-0" />
        </Button>
      </div>
    </div>
  );
}
