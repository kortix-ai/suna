'use client';

// AccessList / AccessRow — THE list row for every access surface.
//
// Canonical anatomy, extracted faithfully from the account `MembersCard`
// list (`app/(app)/accounts/[id]/page.tsx:1443-1676`): a `bg-popover
// rounded-md border` stack, an optional bulk checkbox, a `UserAvatar` /
// `EntityAvatar`, title + badges, an `InlineMeta` meta line, a trailing
// role label, and a kebab `DropdownMenu`.
//
// It replaces the three `MEMBER_ROW` copies, the project Access `Table`,
// the `PolicyAssignments` table, the roles table, and the six ad hoc
// `<ul>` lists across groups / agents / audit-webhooks.

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import Hint from '@/components/ui/hint';
import { InlineMeta } from '@/components/ui/inline-meta';
import Loading from '@/components/ui/loading';
import { cn } from '@/lib/utils';
import { DotsThreeIcon, ShieldIcon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';

/** The entity-row dialect the customize section views established. */
export const ACCESS_ROW_CLASS = 'bg-popover flex items-center gap-3 rounded-md border px-4 py-2.5';

/**
 * One kebab action. Flat list only — no submenus, no radio groups. A role
 * change is not a menu item; it opens `AccessDialog`.
 */
export interface KebabItem {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  variant?: 'default' | 'destructive';
  disabled?: boolean;
  /** Tooltip on the item, e.g. why it is disabled. */
  hint?: string;
  /** Draws a separator above this item. */
  separated?: boolean;
}

export interface AccessRowSelectable {
  checked: boolean;
  onCheckedChange: () => void;
  /** Accessible name, e.g. `Select alice@corp.com`. */
  label: string;
  disabled?: boolean;
  /**
   * This row is not selectable but a sibling is — reserve the checkbox
   * width so every avatar still lines up on one column.
   */
  reserveSpace?: boolean;
}

export interface AccessRowProps {
  /** `UserAvatar` / `EntityAvatar` / tinted icon tile. */
  leading?: ReactNode;
  title: ReactNode;
  /** Rendered next to the title. Pass `Badge` elements. */
  badges?: ReactNode;
  /** Meta line under the title — wrap plain strings in `InlineMeta` yourself,
   *  or pass `metaParts` and let the row do it. */
  meta?: ReactNode;
  /** Convenience: `string[]` rendered through `InlineMeta`. */
  metaParts?: ReactNode[];
  /** Right-hand label — a role name, a status. */
  trailing?: ReactNode;
  /** Inline ghost buttons before the kebab (Approve / Decline, Resend / Revoke). */
  actions?: ReactNode;
  kebab?: KebabItem[];
  /** Accessible name for the kebab trigger. Defaults to "Actions". */
  kebabLabel?: string;
  /** Row click target. The row becomes keyboard-activatable. */
  onClick?: () => void;
  selectable?: AccessRowSelectable;
  /** Swaps the kebab for a spinner while a mutation on this row is in flight. */
  pending?: boolean;
  /** Pending-invite styling. */
  dashed?: boolean;
  /**
   * This grant cannot be edited here (implicit owner/admin access, or
   * inherited from a group). Renders a `Shield` + `Hint` where the kebab
   * would be — ported from `access-projects-tab.tsx:1280-1293`.
   */
  notEditable?: { hint: string };
  className?: string;
}

export function AccessRow({
  leading,
  title,
  badges,
  meta,
  metaParts,
  trailing,
  actions,
  kebab,
  kebabLabel = 'Actions',
  onClick,
  selectable,
  pending = false,
  dashed = false,
  notEditable,
  className,
}: AccessRowProps) {
  const interactive = !!onClick;
  const items = kebab?.filter(Boolean) ?? [];
  const hasTrailingSlot = !!trailing || !!actions || items.length > 0 || pending || !!notEditable;

  return (
    <li
      className={cn(
        ACCESS_ROW_CLASS,
        'transition-colors',
        dashed && 'border-dashed',
        interactive && 'hover:bg-primary/[0.04] cursor-pointer',
        className,
      )}
      {...(interactive
        ? {
            role: 'button',
            tabIndex: 0,
            onClick,
            onKeyDown: (event: React.KeyboardEvent<HTMLLIElement>) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              onClick?.();
            },
          }
        : {})}
    >
      {selectable ? (
        selectable.reserveSpace ? (
          // This row is not selectable (it's you) but a sibling is — reserve
          // the same width so every avatar lines up on one column.
          <span aria-hidden className="size-3.5 shrink-0" />
        ) : (
          <input
            type="checkbox"
            checked={selectable.checked}
            disabled={selectable.disabled}
            onChange={selectable.onCheckedChange}
            onClick={(event) => event.stopPropagation()}
            aria-label={selectable.label}
            className="border-border accent-primary size-3.5 shrink-0 cursor-pointer rounded"
          />
        )
      ) : null}
      {leading}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-foreground truncate text-sm font-medium">{title}</span>
          {badges}
        </div>
        {meta ?? (metaParts && metaParts.length > 0 ? (
          <div className="text-muted-foreground text-xs">
            <InlineMeta>
              {metaParts.map((part, i) => (
                <span key={i}>{part}</span>
              ))}
            </InlineMeta>
          </div>
        ) : null)}
      </div>
      {hasTrailingSlot ? (
        <div
          className="flex shrink-0 items-center gap-1.5"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          role="presentation"
        >
          {trailing ? (
            <span className="text-muted-foreground text-sm">{trailing}</span>
          ) : null}
          {actions}
          <div className="flex w-7 shrink-0 justify-end">
            {pending ? (
              <Loading className="text-muted-foreground size-4 shrink-0" />
            ) : notEditable ? (
              <Hint side="top" label={notEditable.hint}>
                <span className="text-muted-foreground inline-flex size-7 items-center justify-center">
                  <ShieldIcon className="size-3.5" />
                </span>
              </Hint>
            ) : items.length > 0 ? (
              <RowKebab items={items} label={kebabLabel} />
            ) : null}
          </div>
        </div>
      ) : null}
    </li>
  );
}

function RowKebab({ items, label }: { items: KebabItem[]; label: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="text-muted-foreground hover:text-foreground size-7"
          aria-label={label}
        >
          <DotsThreeIcon className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {items.map((item, index) => {
          const node = (
            <DropdownMenuItem
              key={item.label}
              variant={item.variant}
              disabled={item.disabled}
              onSelect={item.onSelect}
              className="gap-2"
            >
              {item.icon}
              {item.label}
            </DropdownMenuItem>
          );
          // A disabled item carries its reason as `hint` — a plain disabled
          // row says nothing about why.
          const wrapped =
            item.hint && item.disabled ? (
              <Hint side="left" label={item.hint}>
                <div>{node}</div>
              </Hint>
            ) : (
              node
            );
          return (
            <div key={item.label}>
              {item.separated && index > 0 ? <DropdownMenuSeparator /> : null}
              {wrapped}
            </div>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export interface AccessListSelection {
  selectedIds: ReadonlySet<string> | readonly string[];
  /** Rows that can be bulk-acted on — self rows are usually excluded. */
  eligibleIds: readonly string[];
  onToggleAll: () => void;
}

export interface AccessListHeader {
  title: ReactNode;
  count?: number;
  /** Right-aligned header actions — a "+ Grant access" button, filters. */
  actions?: ReactNode;
}

export interface AccessListProps {
  children: ReactNode;
  header?: AccessListHeader;
  /** Renders the "Select all visible" control in the header. Row checkboxes
   *  come from each `AccessRow`'s own `selectable`. */
  selectable?: AccessListSelection;
  className?: string;
}

export function AccessList({ children, header, selectable, className }: AccessListProps) {
  const selected = selectable
    ? selectable.selectedIds instanceof Set
      ? selectable.selectedIds
      : new Set(selectable.selectedIds as readonly string[])
    : null;
  const eligible = selectable?.eligibleIds ?? [];
  const allSelected =
    !!selected && eligible.length > 0 && eligible.every((id) => selected.has(id));

  return (
    <div className={cn('space-y-2', className)}>
      {header || (selectable && eligible.length > 0) ? (
        <div className="flex items-center justify-between gap-3 px-1">
          <span className="text-muted-foreground text-xs font-medium">
            {header?.title}
            {typeof header?.count === 'number' ? ` · ${header.count}` : ''}
          </span>
          <div className="flex items-center gap-3">
            {selectable && eligible.length > 0 ? (
              <label className="text-muted-foreground flex cursor-pointer items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={selectable.onToggleAll}
                  className="border-border accent-primary size-3.5 cursor-pointer rounded"
                />
                {allSelected ? 'Deselect all' : 'Select all visible'}
              </label>
            ) : null}
            {header?.actions}
          </div>
        </div>
      ) : null}
      <ul className="space-y-2">{children}</ul>
    </div>
  );
}
