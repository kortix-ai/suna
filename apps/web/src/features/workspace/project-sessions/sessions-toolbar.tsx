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
import { SessionFilterMenu } from '@/features/workspace/project-sidebar/session-filter-menu';
import { cn } from '@/lib/utils';
import type { ProjectSession } from '@kortix/sdk';
import { MagnifyingGlassIcon, PlusIcon } from '@phosphor-icons/react';
import { useTranslations } from '@/i18n/use-translations';
import Link from 'next/link';

export function SessionsToolbar({
  projectId,
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
  projectId: string;
  sessions: ProjectSession[];
  reviewCountBySession: Record<string, number>;
  search: string;
  onSearchChange: (search: string) => void;
  searchOpen: boolean;
  onSearchOpenChange: (open: boolean) => void;
  onEnterSelectMode: () => void;
  /**
   * Click-time side effects for "New". The control is an anchor to the project
   * composer, so the navigation itself is not this handler's job.
   */
  onNewSession?: () => void;
  creatingSession: boolean;
  canSelect: boolean;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
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
            placeholder={tI18nComplete.raw('textb65a63353da6')}
            aria-label={tI18nComplete.raw('text8cb650539ec8')}
          />
          {search ? <InputGroupSearchClear onClick={() => onSearchChange('')} /> : null}
        </InputGroupSearch>
        <Button type="button" variant="ghost" size="sm" onClick={closeSearch}>
          {tI18nComplete.raw('text19766ed6ccb2')}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <Hint label={tI18nComplete.raw('text8cb650539ec8')} side="bottom">
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={tI18nComplete.raw('text8cb650539ec8')}
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
          <Hint label={tI18nComplete.raw('text6c03b504d991')} side="bottom">
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label={tI18nComplete.raw('text6c03b504d991')}
                className="transition-[scale] duration-150 active:scale-[0.96]"
              >
                {tI18nComplete.raw('text638e249f4a15')}
              </Button>
            </DropdownMenuTrigger>
          </Hint>
          <SessionFilterMenu
            projectId={projectId}
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
          {tI18nComplete.raw('text2a78025de6aa')}
        </Button>
      ) : null}

      {/* An anchor, not a button: the composer route is known at render time,
          so <Link> holds its payload in the segment cache and the click never
          runs a cold RSC fetch. The in-flight state stays a real <button> so
          `disabled` still holds. */}
      {creatingSession ? (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className={cn('h-8 gap-1.5 transition-[scale] duration-150 active:scale-[0.96]')}
          disabled
          aria-busy
        >
          <Loading className="size-4 shrink-0" />
          {tI18nComplete.raw('text18fdd549b2ed')}
        </Button>
      ) : (
        <Button
          asChild
          size="sm"
          variant="secondary"
          className={cn('h-8 gap-1.5 transition-[scale] duration-150 active:scale-[0.96]')}
        >
          <Link href={`/projects/${projectId}`} prefetch onClick={onNewSession}>
            <PlusIcon className="size-4 shrink-0" />
            {tI18nComplete.raw('text18fdd549b2ed')}
          </Link>
        </Button>
      )}
    </div>
  );
}
