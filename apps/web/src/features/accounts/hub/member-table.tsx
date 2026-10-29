'use client';

/**
 * The account Members table, shared with the account Projects pane so a
 * project's people read in the same rows: name · email · role · actions.
 */

import type { ComponentProps, ReactNode } from 'react';

import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@kortix/ui';
import type { KebabItem } from '@kortix/ui/access/access/index';
import { Badge } from '@kortix/ui/badge';
import { Button } from '@kortix/ui/button';
import { Checkbox } from '@kortix/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@kortix/ui/dropdown-menu';
import Loading from '@kortix/ui/loading';
import { DotsThreeIcon as DotsThree } from '@phosphor-icons/react';

export type RoleTone = NonNullable<ComponentProps<typeof Badge>['variant']>;

/** Where a role sits in the hierarchy, from the most power to none. */
export type RoleRank = 'owner' | 'admin' | 'manager' | 'member' | 'custom' | 'none';

/**
 * One colour per rank, so the role column reads top-down at a glance
 * (decisions.md, R1): the owner royal purple, an account admin blue, a
 * project manager green, a custom role and a member in neutral ink. Only no
 * access is muted: a member has access, so it never looks like none.
 */
export const ROLE_TONE: Record<RoleRank, RoleTone> = {
  owner: 'royal',
  admin: 'info',
  manager: 'success',
  custom: 'secondary',
  member: 'default',
  none: 'muted',
};

/**
 * The members table: flat rows, no borders, a full-width fill on hover. One grid so every row lines up: select gutter · name · email · role ·
 * actions. The gutter sits OUTSIDE the content edge (the table pulls left by
 * its width), so avatars align with the toolbar above. Below `sm` the email
 * column drops.
 */
export const MEMBER_GRID =
  'grid grid-cols-[calc(var(--spacing)*7)_minmax(0,1fr)_minmax(0,9rem)_2rem] items-center pr-1 sm:grid-cols-[calc(var(--spacing)*7)_minmax(0,1fr)_minmax(0,18rem)_11rem_2rem]';

/** The name cell's handle: the email's local part, else the label. */
export function memberHandle(email: string | null | undefined, fallback: string): string {
  return email?.split('@')[0] || fallback;
}

export interface MemberSelect {
  /** Any row is selected: show every checkbox, not just the hovered one. */
  visible: boolean;
  checked: boolean | 'indeterminate';
  onCheckedChange: () => void;
  label: string;
}

function SelectCell({ select }: { select?: MemberSelect }) {
  return (
    <span role="cell" className="relative z-10 flex items-center justify-center">
      {select ? (
        <Checkbox
          checked={select.checked}
          onCheckedChange={select.onCheckedChange}
          onClick={(event) => event.stopPropagation()}
          aria-label={select.label}
          className={cn(
            // A 32px hit area: the pseudo-element takes the clicks.
            "relative after:absolute after:-inset-2 after:content-['']",
            !select.visible && 'opacity-0 group-hover/member:opacity-100 focus-visible:opacity-100',
          )}
        />
      ) : null}
    </span>
  );
}

export function MemberTableHead({
  select,
  nameHeader,
  emailHeader,
  roleHeader,
}: {
  select?: MemberSelect;
  /** Column titles. Default to "Name", "Email" and "Role". */
  nameHeader?: ReactNode;
  emailHeader?: ReactNode;
  roleHeader?: ReactNode;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const head = 'text-muted-foreground truncate text-xs font-medium';
  return (
    <div role="row" className={cn(MEMBER_GRID, 'group/member h-9 px-2')}>
      <SelectCell select={select} />
      <span
        role="columnheader"
        aria-sort="ascending"
        className={cn(head, 'flex items-center gap-1')}
      >
        {nameHeader ?? tI18nComplete.raw('textdcd1d5223f73')}
      </span>
      <span role="columnheader" className={cn(head, 'max-sm:hidden')}>
        {emailHeader ?? tI18nComplete.raw('text969ccbd3cf63')}
      </span>
      <span role="columnheader" className={head}>
        {roleHeader ?? tI18nComplete.raw('text14736a2eb9f4')}
      </span>
      <span aria-hidden />
    </div>
  );
}

export function MemberTableRow({
  select,
  selected = false,
  pending = false,
  invited = false,
  onOpen,
  avatar,
  name,
  email,
  tags,
  role,
  roleCell,
  roleTone: tone = 'muted',
  kebab,
  kebabLabel,
}: {
  select?: MemberSelect;
  selected?: boolean;
  pending?: boolean;
  /** A pending invite: muted name. */
  invited?: boolean;
  /** Row click: opens the member's access panel. */
  onOpen?: () => void;
  avatar: ReactNode;
  name: string;
  email: string;
  tags?: ReactNode;
  role: ReactNode;
  /** Replaces the role badge, e.g. Approve and Decline on an access request. */
  roleCell?: ReactNode;
  /** Badge variant by the role's rank (`ROLE_TONE`). */
  roleTone?: RoleTone;
  kebab?: KebabItem[];
  kebabLabel: string;
}) {
  return (
    <div
      role="row"
      aria-selected={select ? selected : undefined}
      className={cn(
        MEMBER_GRID,
        'group/member relative h-11 rounded-lg px-2',
        selected ? 'bg-active' : 'hover:bg-hover',
      )}
    >
      {onOpen ? (
        // The whole row opens the member; checkbox and kebab sit above it.
        <button
          type="button"
          aria-label={email}
          onClick={onOpen}
          className="focus-visible:ring-ring absolute inset-0 rounded-[inherit] outline-none focus-visible:ring-1"
        />
      ) : null}
      <SelectCell select={select} />
      <span role="cell" className="flex min-w-0 items-center gap-3">
        {avatar}
        <span
          className={cn(
            'min-w-0 truncate text-sm',
            invited ? 'text-muted-foreground' : 'text-foreground',
          )}
        >
          {name}
        </span>
        {tags ? (
          <span className="relative z-10 flex shrink-0 items-center gap-1.5">{tags}</span>
        ) : null}
      </span>
      <span role="cell" className="text-muted-foreground truncate pr-4 text-sm max-sm:hidden">
        {email}
      </span>
      <span role="cell" className={cn('flex min-w-0', roleCell && 'relative z-10')}>
        {/* The role as a neutral borderless `Badge`, the same recipe as the
            Roles pane's Built-in / Custom tags. */}
        {roleCell ?? (
          <Badge variant={tone} className="max-w-full truncate normal-case ring-0">
            {role}
          </Badge>
        )}
      </span>
      <span role="cell" className="relative z-10 flex justify-end">
        {pending ? (
          <Loading className="size-3.5 shrink-0" />
        ) : kebab && kebab.length > 0 ? (
          <MemberKebab items={kebab} label={kebabLabel} />
        ) : null}
      </span>
    </div>
  );
}

/** The row's actions. Hidden until the row is hovered, focused or open. */
function MemberKebab({ items, label }: { items: KebabItem[]; label: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={label}
          className="text-muted-foreground hover:text-foreground data-[state=open]:text-foreground opacity-0 group-hover/member:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
        >
          <DotsThree className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {items.map((item, index) => (
          <div key={item.label}>
            {item.separated && index > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem
              variant={item.variant}
              disabled={item.disabled}
              onSelect={item.onSelect}
              className="gap-2"
            >
              {item.icon}
              {item.label}
            </DropdownMenuItem>
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
