'use client';

import { useFeatureFlag } from '@kortix/sdk/react';
import { CaretRightIcon, TrayIcon } from '@phosphor-icons/react';
import { useRouter } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { MENU_LABEL, menuRow } from '@/components/ui/menu-recipe';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import type { ChangeRequest } from '@/features/project-files/api/change-requests';
import { ChangeRequestDetailDialog } from '@/features/project-files/components/change-request-detail-dialog';
import { ProjectFilesProvider } from '@/features/project-files/context';
import { useChangeRequests } from '@/features/project-files/hooks/use-change-requests';
import { useReviewSessionSummary } from '@/features/review-center/hooks/use-review-session-summary';
import { projectSettingsSectionHref } from '@/features/workspace/capabilities/project-settings/project-settings-sections';
import { useIsMobile } from '@/hooks/use-mobile';
import { relativeTime } from '@/lib/relative-time';

interface CrController {
  crs: ChangeRequest[];
  count: number;
  selectedCrId: string | null;
  setSelectedCrId: (id: string | null) => void;
  listOpen: boolean;
  setListOpen: (open: boolean) => void;
  openCr: (id: string) => void;
}

function useOpenCrController(): CrController {
  const { data } = useChangeRequests('open', { refetchInterval: 60_000 });
  const crs = useMemo(() => data?.change_requests ?? [], [data?.change_requests]);
  const count = crs.length;

  const [selectedCrId, setSelectedCrId] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);

  const openCr = useCallback((id: string) => {
    setListOpen(false);
    setSelectedCrId(id);
  }, []);

  return {
    crs,
    count,
    selectedCrId,
    setSelectedCrId,
    listOpen,
    setListOpen,
    openCr,
  };
}

/**
 * The chooser that opens when more than one change is waiting.
 *
 * It is a plain list of what is waiting, in the words a person outside the team
 * uses. Branch names (`into main`), SHAs and the word "merge" stay out: whoever
 * clicks this pill is deciding *which* change to look at, and the base branch is
 * the same for every row anyway — it costs a line and tells them nothing. The
 * age does the opposite, so it takes that line instead. A change proposed 20
 * minutes ago and one sitting there for 11 days are different decisions, and an
 * undated row reads as a fresh one.
 *
 * Rows wear the app-wide `menuRow` recipe rather than local padding, so this
 * list lines up with every other floating list in the product — and shares the
 * label's `px-2.5` left edge, which a hand-rolled `px-3.5` did not.
 */
function OpenCrChooser({ crs, onPick }: { crs: ChangeRequest[]; onPick: (id: string) => void }) {
  return (
    <>
      <p className={MENU_LABEL}>Proposed changes</p>
      <div className="max-h-[50vh] overflow-y-auto overscroll-contain">
        {crs.map((cr) => (
          <button
            key={cr.cr_id}
            type="button"
            onClick={() => onPick(cr.cr_id)}
            className={menuRow('sm', 'default', 'group cursor-pointer py-2 text-left')}
          >
            <span className="min-w-0 flex-1">
              <span className="text-foreground block truncate text-sm font-medium">
                {cr.title || 'Untitled change'}
              </span>
              <span className="text-muted-foreground mt-0.5 flex items-center gap-1.5 text-xs">
                <span className="shrink-0 tabular-nums">#{cr.number}</span>
                <span className="text-muted-foreground/40" aria-hidden="true">
                  &bull;
                </span>
                <span className="truncate">{relativeTime(cr.created_at)}</span>
              </span>
            </span>
            <CaretRightIcon className="text-muted-foreground/50 group-hover:text-muted-foreground shrink-0 transition-transform duration-150 ease-out group-hover:translate-x-0.5" />
          </button>
        ))}
      </div>
    </>
  );
}

function NavItemInner({ projectId }: { projectId: string }) {
  const c = useOpenCrController();
  const isMobile = useIsMobile();
  const router = useRouter();
  // When the Review Center is enabled for this project, this pill becomes the
  // single entry point into the unified inbox (Customize → Review) — change
  // requests, approvals and agent outputs all live in one place — instead of
  // opening a single CR's detail dialog. Its badge then counts the SAME unified
  // "needs_you" set the per-session row dots and the Customize rail read, so the
  // pill, the dots, and the rail always agree on one number.
  const reviewEnabled = useFeatureFlag(projectId, 'review_center').enabled;
  const reviewSummary = useReviewSessionSummary(projectId, { enabled: reviewEnabled });

  // Flag on → the unified inbox's "awaiting you" count (open CRs are a subset of
  // needs_you, so this never hides a change request); flag off → legacy open-CR count.
  const count = reviewEnabled ? reviewSummary.totalNeedsYou : c.count;

  if (count === 0) return null;

  // One word, whichever surface it opens — both are "things waiting for you".
  // The old label switched between "Review change" and "Review changes" on the
  // count, so a nav row rewrote itself as work arrived; the badge already
  // carries the number.
  const label = 'Review';
  // The pill is one sidebar row: a three-digit count would push the label into
  // an ellipsis, so it clamps instead. The exact number lives in the list.
  const countLabel = count > 99 ? '99+' : String(count);
  const hasChooser = !reviewEnabled && c.count > 1;

  const menuButton = (
    <SidebarMenuButton
      className="font-medium"
      onClick={
        reviewEnabled
          ? // Review is a section of the Customize bar's Settings tab now.
            () => router.push(projectSettingsSectionHref(projectId, 'review'))
          : c.count === 1
            ? () => c.openCr(c.crs[0].cr_id)
            : undefined
      }
    >
      <TrayIcon className="size-4" />
      {/* `truncate` sits on the label, not on the trailing group: the sidebar's
          base recipe truncates the last child, which used to be the count. */}
      <span className="truncate">{label}</span>
      <span className="ml-auto flex shrink-0 items-center gap-1">
        {/* Pending, not done. The row used to be a filled green pill with green
            text (`variant="success"`), which is the tone this system uses for
            "finished" — on a row that exists precisely because something is
            NOT finished. A plain row with an amber count says "N waiting"
            without claiming a colour it has not earned. */}
        <Badge
          variant="transparent"
          size="tabular"
          className="bg-kortix-yellow/15 dark:bg-kortix-yellow/25 text-current"
        >
          {countLabel}
        </Badge>
        {/* Only when clicking opens a list — a caret on a row that goes straight
            somewhere would promise a menu that never appears. */}
        {hasChooser ? <CaretRightIcon className="size-3.5 opacity-50" /> : null}
      </span>
    </SidebarMenuButton>
  );

  // Review on → always one button into the inbox. Review off → keep the existing
  // CR shortcut (button for a single CR, popover chooser for several).
  return (
    <SidebarMenuItem>
      {hasChooser ? (
        <Popover open={c.listOpen} onOpenChange={c.setListOpen}>
          <PopoverTrigger asChild>{menuButton}</PopoverTrigger>
          <PopoverContent
            side={isMobile ? 'top' : 'right'}
            align={isMobile ? 'start' : 'end'}
            sideOffset={12}
            className="w-80 p-1"
          >
            <OpenCrChooser crs={c.crs} onPick={c.openCr} />
          </PopoverContent>
        </Popover>
      ) : (
        menuButton
      )}

      {!reviewEnabled && (
        <ChangeRequestDetailDialog crId={c.selectedCrId} onClose={() => c.setSelectedCrId(null)} />
      )}
    </SidebarMenuItem>
  );
}

export function ProjectChangeRequestsNavItem({ projectId }: { projectId: string }) {
  return (
    <ProjectFilesProvider value={{ projectId, ref: '' }}>
      <NavItemInner projectId={projectId} />
    </ProjectFilesProvider>
  );
}
