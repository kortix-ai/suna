'use client';

import { ArrowRight, FileDiff } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useMemo, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import type { ChangeRequest } from '@/features/project-files/api/change-requests';
import { ChangeRequestDetailDialog } from '@/features/project-files/components/change-request-detail-dialog';
import { ProjectFilesProvider } from '@/features/project-files/context';
import { useChangeRequests } from '@/features/project-files/hooks/use-change-requests';
import { useReviewSessionSummary } from '@/features/review-center/hooks/use-review-session-summary';
import { useReviewCenterEnabled } from '@/hooks/projects/use-review-center-enabled';
import { useIsMobile } from '@/hooks/use-mobile';
import { useCustomizeStore } from '@/stores/customize-store';

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
  const { data } = useChangeRequests('open', { refetchInterval: 20_000 });
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

function OpenCrChooser({
  crs,
  baseRef,
  onPick,
}: {
  crs: ChangeRequest[];
  baseRef: string;
  onPick: (id: string) => void;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  return (
    <div className="w-full overflow-hidden py-1">
      <div className="border-border flex items-center justify-between gap-3 border-b px-3.5 py-1.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="bg-kortix-green/10 text-kortix-green grid size-8 shrink-0 place-items-center rounded-md">
            <FileDiff className="size-4" />
          </span>
          <div className="min-w-0">
            <h3 className="text-foreground truncate text-sm font-medium">
              {tI18nHardcoded.raw(
                'autoFeaturesCoWorkerProjectSidebarFooterProjectChangeRequestsNav63c4c66f',
              )}
            </h3>
            <p className="text-muted-foreground truncate text-xs">
              {crs.length}{' '}
              {tI18nHardcoded.raw(
                'autoFeaturesCoWorkerProjectSidebarFooterProjectChangeRequestsNavafed4c1a',
              )}
              {baseRef || 'main'}
            </p>
          </div>
        </div>
      </div>
      <div className="max-h-[50vh] overflow-y-auto">
        {crs.map((cr) => (
          <button
            key={cr.cr_id}
            type="button"
            onClick={() => onPick(cr.cr_id)}
            className="group hover:bg-muted/50 focus-visible:bg-muted/50 flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-[background-color,transform] duration-150 ease-out focus-visible:outline-none active:scale-[0.99]"
          >
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <span className="text-muted-foreground shrink-0 font-mono text-[11px] tabular-nums">
                  #{cr.number}
                </span>
                <span className="text-foreground truncate text-sm leading-5 font-medium">
                  {cr.title}
                </span>
              </div>
              <div className="text-muted-foreground mt-0.5 flex min-w-0 items-center gap-1.5 text-xs">
                <span className="shrink-0">into</span>
                <Badge variant="kortix" size="xs" className="truncate">
                  {cr.base_ref}
                </Badge>
              </div>
            </div>
            <ArrowRight className="text-muted-foreground/50 group-hover:text-foreground size-3.5 shrink-0 transition-colors" />
          </button>
        ))}
      </div>
    </div>
  );
}

function NavItemInner({ projectId }: { projectId: string }) {
  const c = useOpenCrController();
  const isMobile = useIsMobile();
  const openCustomize = useCustomizeStore((s) => s.openCustomize);
  // When the Review Center is enabled for this project, this pill becomes the
  // single entry point into the unified inbox (Customize → Review) — change
  // requests, approvals and agent outputs all live in one place — instead of
  // opening a single CR's detail dialog. Its badge then counts the SAME unified
  // "needs_you" set the per-session row dots and the Customize rail read, so the
  // pill, the dots, and the rail always agree on one number.
  const reviewEnabled = useReviewCenterEnabled(projectId);
  const reviewSummary = useReviewSessionSummary(projectId, { enabled: reviewEnabled });

  // Flag on → the unified inbox's "awaiting you" count (open CRs are a subset of
  // needs_you, so this never hides a change request); flag off → legacy open-CR count.
  const count = reviewEnabled ? reviewSummary.totalNeedsYou : c.count;

  if (count === 0) return null;

  const label = reviewEnabled ? 'Review' : count === 1 ? 'Review change' : 'Review changes';
  const baseRef = c.crs[0]?.base_ref ?? '';

  const menuButton = (
    <SidebarMenuButton
      variant="success"
      className="text-sm! font-medium [&_svg]:size-4!"
      onClick={
        reviewEnabled
          ? () => openCustomize('review')
          : c.count === 1
            ? () => c.openCr(c.crs[0].cr_id)
            : undefined
      }
    >
      <FileDiff />
      <span>{label}</span>
      <span className="ml-auto pr-1 text-xs tabular-nums">{count}</span>
    </SidebarMenuButton>
  );

  // Review on → always one button into the inbox. Review off → keep the existing
  // CR shortcut (button for a single CR, popover chooser for several).
  return (
    <SidebarMenuItem>
      {reviewEnabled || c.count === 1 ? (
        menuButton
      ) : (
        <Popover open={c.listOpen} onOpenChange={c.setListOpen}>
          <PopoverTrigger asChild>{menuButton}</PopoverTrigger>
          <PopoverContent
            side={isMobile ? 'top' : 'right'}
            align={isMobile ? 'start' : 'end'}
            sideOffset={12}
            className="w-[340px] overflow-hidden p-0"
          >
            <OpenCrChooser crs={c.crs} baseRef={baseRef} onPick={c.openCr} />
          </PopoverContent>
        </Popover>
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
