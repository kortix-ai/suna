'use client';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import Hint from '@/components/ui/hint';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import Loading from '@/components/ui/loading';
import { cn } from '@/lib/utils';
import { CaretDownIcon, MagnifyingGlassIcon, PlusIcon } from '@phosphor-icons/react';

import {
  projectSessionsFilterLabel,
  type ProjectSessionsFilter,
  type ProjectSessionsFilterGroup,
} from './project-sessions-helpers';

export function SessionsToolbar({
  filter,
  onFilterChange,
  groups,
  search,
  onSearchChange,
  searchOpen,
  onSearchOpenChange,
  onEnterSelectMode,
  onNewSession,
  creatingSession,
  canSelect,
}: {
  filter: ProjectSessionsFilter;
  onFilterChange: (filter: ProjectSessionsFilter) => void;
  groups: ProjectSessionsFilterGroup[];
  search: string;
  onSearchChange: (search: string) => void;
  searchOpen: boolean;
  onSearchOpenChange: (open: boolean) => void;
  onEnterSelectMode: () => void;
  onNewSession: () => void;
  creatingSession: boolean;
  canSelect: boolean;
}) {
  const closeSearch = () => {
    onSearchChange('');
    onSearchOpenChange(false);
  };

  if (searchOpen) {
    return (
      // Fixed width, not flex-1: the section header wraps its action slot in
      // `shrink-0`, so a flex-1 child would collapse to its content width.
      <div className="flex items-center gap-2">
        <InputGroupSearch className="w-[min(20rem,60vw)]">
          <InputGroupSearchIcon>
            <MagnifyingGlassIcon />
          </InputGroupSearchIcon>
          <InputGroupSearchInput
            autoFocus
            variant="popover"
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                closeSearch();
              }
            }}
            size="xs"
            placeholder="Search by title, owner, source, branch, agent, or ID"
            aria-label="Search sessions"
          />
          {search ? <InputGroupSearchClear onClick={() => onSearchChange('')} /> : null}
        </InputGroupSearch>
        <Button type="button" variant="ghost" size="sm" onClick={closeSearch}>
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <Hint label="Search sessions" side="bottom">
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="Search sessions"
          onClick={() => onSearchOpenChange(true)}
          className="size-8 transition-[scale] duration-150 active:scale-[0.96]"
        >
          <MagnifyingGlassIcon className="size-4 shrink-0" />
        </Button>
      </Hint>

      {groups.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 transition-[scale] duration-150 active:scale-[0.96]"
            >
              <span className="text-muted-foreground">Filter by</span>
              <span>{projectSessionsFilterLabel(filter)}</span>
              <CaretDownIcon className="size-3.5 shrink-0" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuRadioGroup
              value={filter}
              onValueChange={(value) => onFilterChange(value as ProjectSessionsFilter)}
            >
              <DropdownMenuRadioItem value="all">All</DropdownMenuRadioItem>
              {groups.map((group) => (
                <div key={group.axis} className="w-full">
                  {group.options.map((option) => (
                    <DropdownMenuRadioItem key={option.value} value={option.value}>
                      {option.label}
                    </DropdownMenuRadioItem>
                  ))}
                </div>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      {canSelect ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onEnterSelectMode}
          className="h-8 transition-[scale] duration-150 active:scale-[0.96]"
        >
          Select
        </Button>
      ) : null}

      <Button
        type="button"
        size="sm"
        variant="secondary"
        className={cn('h-8 gap-1.5 transition-[scale] duration-150 active:scale-[0.96]')}
        onClick={onNewSession}
        disabled={creatingSession}
        aria-busy={creatingSession}
      >
        {creatingSession ? (
          <Loading className="size-4 shrink-0" />
        ) : (
          <PlusIcon className="size-4 shrink-0" />
        )}
        New
      </Button>
    </div>
  );
}
