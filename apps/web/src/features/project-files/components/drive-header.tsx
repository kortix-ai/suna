'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { useOptionalSidebar } from '@/components/ui/sidebar';
import {
  sidebarOpenerLabel,
  useShowPageSidebarOpener,
} from '@/features/workspace/project-layout/sidebar-opener';
import { cn } from '@/lib/utils';
import {
  GitDiffIcon as FileDiff,
  ClockCounterClockwiseIcon as History,
  SidebarSimpleIcon as PanelLeft,
} from '@phosphor-icons/react';

import { DrivePathBar, DriveViewMenu } from './drive-toolbar';
import { VersionSelector } from './version-selector';

interface DriveHeaderProps {
  historyToggle: { open: boolean; onToggle: () => void };
  reviewsToggle: { open: boolean; onToggle: () => void; openCount?: number };
  /** `⋯` menu wiring — the page owns the queries these act on. */
  onRefresh: () => void;
  onDownloadDir: () => void;
  isDownloading?: boolean;
  /**
   * Draw the page-level sidebar opener. Only the standalone Files page needs
   * it: ProjectShell does not render a web opener, and the embedded session
   * view already has the session header above.
   */
  offsetForSidebarToggle?: boolean;
}

/**
 * The desktop shell's title-bar hook — the SAME class the capability tab row
 * wears (`capability-tabs.tsx`). Both rows are the first in-flow child of
 * their layout, so both start at y=0 and share the band with the OS window
 * controls; the rules in globals.css widen the indents so neither renders
 * under the macOS traffic lights or the Win/Linux control cluster.
 *
 * Files used to carry its own near-duplicate (`.kx-files-header`) with its own
 * platform split. One class, one rule, one behaviour.
 */
export const FILES_HEADER_DESKTOP_CLASS = 'kx-titlebar-row';

/**
 * One row, `h-11`, matching the capability tab row's height exactly. This used
 * to be a `flex-wrap` two-line block sitting on top of a SECOND full-width
 * toolbar; see `drive-toolbar.tsx` for what moved where.
 */
export function driveHeaderClass(offsetForSidebarToggle: boolean) {
  return cn(
    'relative flex h-11 shrink-0 items-center gap-1 border-b px-2',
    offsetForSidebarToggle && FILES_HEADER_DESKTOP_CLASS,
  );
}

/**
 * Same rules as capability tabs / project-home / session header. In flow
 * with the path bar — do not absolute-position it over the header.
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
 * Header for the standalone project Files page. One row:
 *
 *   [☰]  Files › src › ui        [main ▾]  [⏱]  [Proposed changes ②]  [⋯]
 *
 * The breadcrumb chain IS the title — `Files` is its root crumb, so at the
 * root the row reads exactly like any other page header, and navigating a
 * folder deep costs no extra chrome. That replaced a static `<h2>Files</h2>`
 * that only repeated the sidebar entry the user had just clicked, plus the
 * separate toolbar row underneath that carried the real path.
 *
 * Right-hand order is by frequency: which version you are reading, then the
 * two review panels, then everything rare behind `⋯`.
 */
export function DriveHeader({
  historyToggle,
  reviewsToggle,
  onRefresh,
  onDownloadDir,
  isDownloading,
  offsetForSidebarToggle = false,
}: DriveHeaderProps) {
  const sidebar = useOptionalSidebar();
  const sidebarCollapsed = sidebar?.state === 'collapsed';

  const reviewCount = reviewsToggle.openCount ?? 0;

  return (
    <header
      className={driveHeaderClass(offsetForSidebarToggle)}
      // The desktop rule keys off this: the left indent is only needed while
      // the sidebar is collapsed, since an expanded sidebar covers the lights.
      data-sidebar-collapsed={sidebarCollapsed || undefined}
    >
      {offsetForSidebarToggle ? <FilesSidebarToggle /> : null}

      <DrivePathBar rootLabel="Files" />

      <div className="flex shrink-0 items-center gap-1">
        <VersionSelector />

        <Hint label="Browse every saved version of this project" side="bottom">
          <Button
            type="button"
            aria-label="Version history"
            aria-pressed={historyToggle.open}
            variant={historyToggle.open ? 'secondary' : 'ghost'}
            size="icon-sm"
            onClick={historyToggle.onToggle}
            className={cn(
              'active:scale-[0.96]',
              !historyToggle.open && 'text-muted-foreground hover:text-foreground',
            )}
          >
            <History className="size-4" />
          </Button>
        </Hint>

        <Button
          type="button"
          aria-pressed={reviewsToggle.open}
          variant={reviewsToggle.open ? 'secondary' : 'ghost'}
          size="sm"
          onClick={reviewsToggle.onToggle}
          title={
            reviewCount > 0
              ? `${reviewCount} proposed change${reviewCount === 1 ? '' : 's'} waiting for review`
              : 'Review changes proposed by your agents'
          }
          className={cn(
            'active:scale-[0.96]',
            !reviewsToggle.open && reviewCount === 0 && 'text-muted-foreground hover:text-foreground',
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

        <DriveViewMenu
          onRefresh={onRefresh}
          onDownloadDir={onDownloadDir}
          isDownloading={isDownloading}
        />
      </div>
    </header>
  );
}
