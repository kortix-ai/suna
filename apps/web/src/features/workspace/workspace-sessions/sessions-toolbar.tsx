'use client';

import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import Hint from '@/components/ui/hint';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import Loading from '@/components/ui/loading';
import { SessionFilterMenu } from '@/features/workspace/workspace-sidebar/session-filter-menu';
import { cn } from '@/lib/utils';
import type { WorkspaceSession } from '@kortix/sdk';
import { MagnifyingGlassIcon, PlusIcon } from '@phosphor-icons/react';

export function SessionsToolbar({
  workspaceId,
  sessions,
  reviewCountBySession,
  search,
  onSearchChange,
  searchOpen,
  onSearchOpenChange,
  onEnterSelectMode,
  onNewSession,
  creatingSession,
  canSelect,
}: {
  workspaceId: string;
  sessions: WorkspaceSession[];
  reviewCountBySession: Record<string, number>;
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

      {sessions.length > 0 ? (
        // The SAME component the sidebar's Sessions header mounts — Grouping,
        // Ordering, Show, both faceted filters, Collapse all. Not a lookalike:
        // one menu, so the two surfaces cannot drift in what they OFFER. What
        // they do not share is state — see the `surface` prop below.
        <DropdownMenu>
          {/* Hint OUTSIDE the trigger. `Hint` spreads its extra props onto the
              Tooltip ROOT, so a `DropdownMenuTrigger asChild` wrapping it hands
              its onClick and ref to a component that discards them — the button
              renders and clicking it does nothing. Guarded by
              sessions-toolbar.test.tsx. */}
          <Hint label="Session view options" side="bottom">
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label="Session view options"
                className="transition-[scale] duration-150 active:scale-[0.96]"
              >
                Filter
              </Button>
            </DropdownMenuTrigger>
          </Hint>
          <SessionFilterMenu
            workspaceId={workspaceId}
            sessions={sessions}
            reviewCountBySession={reviewCountBySession}
            align="end"
            side="bottom"
            // Same menu as the sidebar, its OWN state. Inherits the sidebar's
            // values until something is changed here.
            surface="page"
          />
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
