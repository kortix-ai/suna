'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import Hint from '@/components/ui/hint';
import { useOptionalSidebar, useSidebar } from '@/components/ui/sidebar';
import { useFilesStore } from '@/features/file-browser/store/files-store';
import {
  sidebarOpenerLabel,
  useShowPageSidebarOpener,
} from '@/features/workspace/project-layout/sidebar-opener';
import { cn } from '@/lib/utils';
import {
  GitDiffIcon as FileDiff,
  ClockCounterClockwiseIcon as History,
  SquaresFourIcon as LayoutGrid,
  ListIcon as ListSolid,
  SidebarSimpleIcon as PanelLeft,
} from '@phosphor-icons/react';

interface DriveHeaderProps {
  historyToggle: { open: boolean; onToggle: () => void };
  reviewsToggle: { open: boolean; onToggle: () => void; openCount?: number };
  /**
   * Draw the page-level sidebar opener. Only the standalone Files page needs
   * it: ProjectShell does not render a web opener, and the embedded session
   * view already has the session header above.
   */
  offsetForSidebarToggle?: boolean;
}

/**
 * Hook the desktop shell's title-bar rules in globals.css key off. Only the
 * standalone Files page reaches the top of the window, so only it opts in;
 * the rules widen the indents so the row clears the OS window controls
 * (macOS traffic lights + the shell's sidebar toggle on the left, the
 * Win/Linux control cluster on the right).
 */
export const FILES_HEADER_DESKTOP_CLASS = 'kx-files-header';

export function driveHeaderClass(offsetForSidebarToggle: boolean, _sidebarCollapsed: boolean) {
  return cn(
    'flex flex-wrap gap-1 border-b px-2 items-center justify-between gap-x-4 gap-y-3 py-2 pr-4',
    offsetForSidebarToggle && FILES_HEADER_DESKTOP_CLASS,
  );
}

/**
 * Same rules as capability tabs / project-home / session header. In flow
 * with the Files title — do not absolute-position it over the header.
 */
function FilesSidebarToggle() {
  const sidebar = useOptionalSidebar();
  const show = useShowPageSidebarOpener();
  if (!sidebar || !show) return null;

  const label = sidebarOpenerLabel(sidebar);

  return (
    <Hint label={label} side="bottom">
      <Button
        type="button"
        aria-label={label}
        variant="ghost"
        size="icon"
        onClick={sidebar.toggleSidebar}
        onPointerEnter={sidebar.state === 'collapsed' ? sidebar.peekEnter : undefined}
        onPointerLeave={sidebar.state === 'collapsed' ? sidebar.peekLeave : undefined}
        className="hover:bg-sidebar-accent hover:text-sidebar-foreground shrink-0 cursor-pointer active:scale-[0.96]"
      >
        <PanelLeft className="cn-rtl-flip size-4" />
      </Button>
    </Hint>
  );
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
      className={driveHeaderClass(offsetForSidebarToggle, sidebarCollapsed)}
      // The macOS rule keys off this: the left indent is only needed while the
      // sidebar is collapsed, since an expanded sidebar covers the lights.
      data-sidebar-collapsed={sidebarCollapsed || undefined}
    >
      <div className="flex min-w-0 items-center gap-1">
        {offsetForSidebarToggle ? <FilesSidebarToggle /> : null}
        <div className="min-w-0 space-y-1">
          <h2 className="text-foreground text-xl font-medium">Files</h2>
        </div>
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
            <Badge variant="success" size="tabular" className="ml-0.5">
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
              <ListSolid weight="fill" className="size-4" />
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
