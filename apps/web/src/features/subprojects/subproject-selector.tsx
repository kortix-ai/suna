'use client';

import { Button } from '@/components/ui/button';
import {
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPopover,
  CommandPopoverContent,
  CommandPopoverTrigger,
  CommandSeparator,
} from '@/components/ui/command';
import { cn } from '@/lib/utils';
import type { Subproject } from '@kortix/sdk';
import {
  CaretDownIcon,
  CheckIcon,
  FolderSimpleIcon,
  PlusIcon,
  SquaresFourIcon,
} from '@phosphor-icons/react';
import { useMemo, useState, type ReactNode } from 'react';

import { CreateSubprojectModal } from './create-subproject-modal';

/** Same threshold as `AgentSelector`: under it the whole list is readable at
 *  a glance and a search field is a row of chrome that saves nobody time. */
const SEARCH_MIN_ITEMS = 7;

/**
 * Where a session from this composer starts: the whole project, or one of
 * its subprojects.
 *
 * Sits right after the agent picker and wears the SAME trigger — ghost, `sm`,
 * `rounded-lg`, label plus caret — so the bar reads as one row of sibling
 * choices ("Agent · Marketing · Model"), not a control of its own kind. The
 * list mirrors the sidebar's `Subprojects` group: the same rows, the same
 * folder glyph, and `New subproject` at the foot for anyone who may create
 * one (the modal navigates to the new page, which preselects itself here).
 */
export function SubprojectSelector({
  projectId,
  subprojects,
  selected,
  onSelect,
  canCreate,
}: {
  projectId: string;
  /** Every subproject the caller may see — the sidebar's list. */
  subprojects: Subproject[];
  /** The slug a send will carry, or `null` for the whole project. */
  selected: string | null;
  onSelect: (slug: string | null) => void;
  canCreate: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);

  const current = subprojects.find((s) => s.slug === selected) ?? null;
  const query = search.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!query) return subprojects;
    return subprojects.filter(
      (s) =>
        s.name.toLowerCase().includes(query) ||
        s.slug.includes(query) ||
        (s.description ?? '').toLowerCase().includes(query),
    );
  }, [subprojects, query]);
  // Keyed off the FULL list, never the filtered one — see `AgentSelector`.
  const showSearch = subprojects.length >= SEARCH_MIN_ITEMS;

  const row = (
    key: string,
    icon: ReactNode,
    title: string,
    description: string | null,
    isSelected: boolean,
    onPick: () => void,
  ) => (
    <CommandItem
      key={key}
      // The name rides the value so cmdk's own matching (if it is on) agrees
      // with the manual filter above instead of hiding what it shows.
      value={`${key} ${title}`}
      className={cn('items-start gap-2 py-2', isSelected && 'bg-primary/[0.06]')}
      onSelect={() => {
        onPick();
        setOpen(false);
      }}
    >
      <span className="text-muted-foreground mt-0.5 flex size-4 shrink-0 items-center justify-center">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-foreground truncate text-sm font-medium">{title}</div>
        {description ? (
          <p className="text-muted-foreground mt-0.5 truncate text-xs">{description}</p>
        ) : null}
      </div>
      {isSelected ? <CheckIcon className="text-foreground mt-0.5 size-4 shrink-0" /> : null}
    </CommandItem>
  );

  return (
    <>
      <CommandPopover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          // A closed picker forgets its query, so it never reopens filtered.
          if (!next) setSearch('');
        }}
      >
        <CommandPopoverTrigger>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label="Select subproject"
            className="text-foreground/70 rounded-lg"
          >
            <FolderSimpleIcon className="size-3.5 shrink-0" />
            <span className="max-w-[7rem] truncate">{current?.name ?? 'Subproject'}</span>
            <CaretDownIcon
              className={cn(
                'size-3 transition-transform duration-200 ease-out',
                open && 'rotate-180',
              )}
            />
          </Button>
        </CommandPopoverTrigger>

        <CommandPopoverContent
          side="top"
          align="start"
          sideOffset={8}
          className="w-[min(300px,calc(100vw-1.5rem))]"
        >
          {/* Mounted either way, hidden below the threshold: cmdk's arrow keys
              live on this input — see the same note in `AgentSelector`. */}
          <div className={showSearch ? undefined : 'sr-only'}>
            <CommandInput
              compact
              placeholder="Search subprojects"
              value={search}
              onValueChange={setSearch}
            />
          </div>

          <CommandList className="max-h-[320px]">
            <CommandGroup forceMount>
              {!query &&
                row(
                  'whole-project',
                  <SquaresFourIcon className="size-4" />,
                  'Whole project',
                  'Not inside a subproject.',
                  selected === null,
                  () => onSelect(null),
                )}
              {filtered.map((s) =>
                row(
                  `subproject-${s.slug}`,
                  <FolderSimpleIcon className="size-4" />,
                  s.name,
                  s.description,
                  selected === s.slug,
                  () => onSelect(s.slug),
                ),
              )}
            </CommandGroup>

            {filtered.length === 0 && query ? (
              <div className="text-muted-foreground/50 py-8 text-center text-xs">
                No subprojects match &ldquo;{search.trim()}&rdquo;
              </div>
            ) : null}

            {canCreate ? (
              <>
                <CommandSeparator />
                <CommandGroup forceMount>
                  {row(
                    'new-subproject',
                    <PlusIcon className="size-4" />,
                    'New subproject',
                    null,
                    false,
                    () => setCreateOpen(true),
                  )}
                </CommandGroup>
              </>
            ) : null}
          </CommandList>
        </CommandPopoverContent>
      </CommandPopover>

      {canCreate ? (
        <CreateSubprojectModal
          projectId={projectId}
          open={createOpen}
          onOpenChange={setCreateOpen}
        />
      ) : null}
    </>
  );
}
