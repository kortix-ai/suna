'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import Hint from '@/components/ui/hint';
import { useSidebar } from '@/components/ui/sidebar';
import { useFilesStore } from '@/features/file-browser/store/files-store';
import { cn } from '@/lib/utils';
import { ListSolid } from '@mynaui/icons-react';
import { FileDiff, History, LayoutGrid } from 'lucide-react';

interface DriveHeaderProps {
  historyToggle: { open: boolean; onToggle: () => void };
  reviewsToggle: { open: boolean; onToggle: () => void; openCount?: number };
  /**
   * Reserve room for the floating "open sidebar" toggle that the project shell
   * renders over the top-left corner when the sidebar is collapsed (desktop) or
   * on mobile (always). Only the standalone Files page sits directly under it;
   * the embedded session view has its own header above, so it opts out.
   */
  offsetForSidebarToggle?: boolean;
}

/**
 * Drive-style page header for the project Files section: plain-language
 * title + purpose line on the left, version-history / proposed-changes
 * toggles and the list⇄grid switch on the right.
 */
export function DriveHeader({
  historyToggle,
  reviewsToggle,
  offsetForSidebarToggle = false,
}: DriveHeaderProps) {
  const viewMode = useFilesStore((s) => s.viewMode);
  const setViewMode = useFilesStore((s) => s.setViewMode);
  const { state } = useSidebar();
  const sidebarCollapsed = state === 'collapsed';

  const reviewCount = reviewsToggle.openCount ?? 0;

  return (
    <header
      className={cn(
        'flex flex-wrap items-center justify-between gap-x-4 gap-y-3 px-5 pb-4',
        // Mobile: the shell's open-sidebar trigger always sits top-left, so drop
        // the title below it. Desktop: only the collapsed-sidebar toggle overlaps,
        // so inset the title left only then (keeps it aligned when expanded).
        offsetForSidebarToggle ? 'pt-14 md:pt-3' : 'pt-5',
        offsetForSidebarToggle && sidebarCollapsed && 'md:pl-14',
      )}
    >
      <div className="min-w-0 space-y-1">
        <h2 className="text-foreground text-xl font-medium">Files</h2>
        <p className="text-muted-foreground text-sm text-pretty">
          Every document, asset, and piece of work in this project lives here.
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          type="button"
          variant={historyToggle.open ? 'secondary' : 'ghost'}
          size="sm"
          onClick={historyToggle.onToggle}
          title="Browse every saved version of this project"
          className={cn(!historyToggle.open && 'text-muted-foreground hover:text-foreground')}
        >
          <History className="size-4 shrink-0" />
          <span className="hidden sm:inline">History</span>
        </Button>

        <Button
          type="button"
          variant={reviewsToggle.open ? 'secondary' : 'ghost'}
          size="sm"
          onClick={reviewsToggle.onToggle}
          title={
            reviewCount > 0
              ? `${reviewCount} proposed change${reviewCount === 1 ? '' : 's'} waiting for review`
              : 'Review changes proposed by your agents'
          }
          className={cn(
            !reviewsToggle.open &&
              reviewCount === 0 &&
              'text-muted-foreground hover:text-foreground',
          )}
        >
          <FileDiff className="size-4 shrink-0" />
          <span className="hidden sm:inline">Proposed changes</span>
          {reviewCount > 0 && (
            <Badge variant="success" size="xs" className="ml-0.5 tabular-nums">
              {reviewCount}
            </Badge>
          )}
        </Button>

        <ButtonGroup className="ml-1">
          <Hint label="List view">
            <Button
              type="button"
              variant={viewMode === 'list' ? 'secondary' : 'outline'}
              size="icon-sm"
              aria-pressed={viewMode === 'list'}
              onClick={() => setViewMode('list')}
            >
              <ListSolid className="size-4" />
            </Button>
          </Hint>
          <Hint label="Grid view">
            <Button
              type="button"
              variant={viewMode === 'grid' ? 'secondary' : 'outline'}
              size="icon-sm"
              aria-pressed={viewMode === 'grid'}
              onClick={() => setViewMode('grid')}
            >
              <LayoutGrid className="size-4" />
            </Button>
          </Hint>
        </ButtonGroup>
      </div>
    </header>
  );
}
