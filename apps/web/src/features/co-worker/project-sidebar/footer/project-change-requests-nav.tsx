'use client';

import * as React from 'react';
import { useCallback, useState } from 'react';
import { ArrowRight, GitBranch, GitMerge, GitPullRequest } from 'lucide-react';

import { SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from '@/components/ui/popover';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { ChangeRequestDetailDialog } from '@/features/project-files/components/change-request-detail-dialog';
import { ProjectFilesProvider } from '@/features/project-files/context';
import { useChangeRequests } from '@/features/project-files/hooks/use-change-requests';
import type { ChangeRequest } from '@/features/project-files/api/change-requests';
import { cn } from '@/lib/utils';

interface CrController {
  crs: ChangeRequest[];
  count: number;
  selectedCrId: string | null;
  setSelectedCrId: (id: string | null) => void;
  listOpen: boolean;
  setListOpen: (open: boolean) => void;
  onActivate: () => void;
  openCr: (id: string) => void;
}

function useOpenCrController(): CrController {
  const { data } = useChangeRequests('open', { refetchInterval: 20_000 });
  const crs = data?.change_requests ?? [];
  const count = crs.length;

  const [selectedCrId, setSelectedCrId] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);

  const openCr = useCallback((id: string) => {
    setListOpen(false);
    setSelectedCrId(id);
  }, []);

  const onActivate = useCallback(() => {
    if (count === 1) {
      setSelectedCrId(crs[0].cr_id);
    } else if (count > 1) {
      setListOpen((v) => !v);
    }
  }, [count, crs]);

  return {
    crs,
    count,
    selectedCrId,
    setSelectedCrId,
    listOpen,
    setListOpen,
    onActivate,
    openCr,
  };
}

function tooltipCopy(count: number): string {
  return count === 1
    ? 'A change is ready to merge into main. Click to review and merge it.'
    : `${count} changes are ready to merge into main. Click to review and merge them.`;
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
  return (
    <div className="w-full overflow-hidden">
      <div className="flex items-center gap-2.5 border-b border-border/60 px-4 pt-4 pb-3">
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-emerald-500/10 text-emerald-600">
          <GitPullRequest className="size-3.5" />
        </span>
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold tracking-tight text-foreground">
            Changes ready for {baseRef || 'main'}
          </h3>
          <p className="truncate text-xs text-muted-foreground">
            {crs.length} open · pick one to review &amp; merge
          </p>
        </div>
      </div>
      <div className="max-h-[50vh] overflow-y-auto py-1">
        {crs.map((cr) => (
          <button
            key={cr.cr_id}
            type="button"
            onClick={() => onPick(cr.cr_id)}
            className="group flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
          >
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-muted/50">
              <GitPullRequest className="size-3 text-emerald-600" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-xs text-muted-foreground">#{cr.number}</span>
                <span className="truncate text-sm font-medium text-foreground">{cr.title}</span>
              </div>
              <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                <GitBranch className="size-3" />
                <span className="truncate font-mono">{cr.head_ref}</span>
                <span className="text-muted-foreground/60">→</span>
                <span className="font-mono">{cr.base_ref}</span>
              </div>
            </div>
            <span className="ml-auto flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground/70 transition-colors group-hover:text-foreground">
              Review
              <ArrowRight className="size-3" />
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function NavItemInner() {
  const c = useOpenCrController();

  if (c.count === 0) return null;

  const label = c.count === 1 ? 'Review change' : 'Review changes';
  const baseRef = c.crs[0]?.base_ref ?? '';

  return (
    <SidebarMenuItem>
      <Popover open={c.listOpen} onOpenChange={c.setListOpen}>
        <Tooltip>
          <PopoverAnchor asChild>
            <TooltipTrigger asChild>
              <SidebarMenuButton
                onClick={c.onActivate}
                className={cn(
                  '!text-sm [&_svg]:!size-4',
                  'bg-emerald-500/[0.07] text-foreground hover:bg-emerald-500/15',
                )}
              >
                <span className="relative flex">
                  <GitPullRequest className="text-emerald-600" />
                  <span className="absolute -right-0.5 -top-0.5 flex size-1.5">
                    <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500/70" />
                    <span className="relative inline-flex size-1.5 rounded-full bg-emerald-500" />
                  </span>
                </span>
                <span>{label}</span>
                <span className="ml-auto flex min-w-5 items-center justify-center rounded-full bg-emerald-500/15 px-1.5 text-xs font-medium tabular-nums text-emerald-700 dark:text-emerald-400">
                  {c.count}
                </span>
              </SidebarMenuButton>
            </TooltipTrigger>
          </PopoverAnchor>
          <TooltipContent side="right" sideOffset={12} className="max-w-[220px] text-xs">
            {tooltipCopy(c.count)}
          </TooltipContent>
        </Tooltip>
        <PopoverContent
          side="right"
          align="end"
          sideOffset={12}
          className="w-[340px] overflow-hidden rounded-2xl p-0"
        >
          <OpenCrChooser crs={c.crs} baseRef={baseRef} onPick={c.openCr} />
        </PopoverContent>
      </Popover>

      <ChangeRequestDetailDialog
        crId={c.selectedCrId}
        onClose={() => c.setSelectedCrId(null)}
      />
    </SidebarMenuItem>
  );
}

function RailItemInner() {
  const c = useOpenCrController();

  if (c.count === 0) return null;

  const baseRef = c.crs[0]?.base_ref ?? '';

  return (
    <>
      <Popover open={c.listOpen} onOpenChange={c.setListOpen}>
        <Tooltip>
          <PopoverAnchor asChild>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={tooltipCopy(c.count)}
                onClick={c.onActivate}
                className="relative flex w-full items-center justify-center rounded-lg py-2 text-sidebar-foreground transition-colors duration-150 ease-out hover:bg-emerald-500/15"
              >
                <GitMerge className="size-4 text-emerald-600" />
                <span className="absolute right-1 top-1 flex size-1.5">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500/70" />
                  <span className="relative inline-flex size-1.5 rounded-full bg-emerald-500" />
                </span>
              </button>
            </TooltipTrigger>
          </PopoverAnchor>
          <TooltipContent side="right" sideOffset={12} className="max-w-[220px] text-xs">
            {tooltipCopy(c.count)}
          </TooltipContent>
        </Tooltip>
        <PopoverContent
          side="right"
          align="start"
          sideOffset={12}
          className="w-[340px] overflow-hidden rounded-2xl p-0"
        >
          <OpenCrChooser crs={c.crs} baseRef={baseRef} onPick={c.openCr} />
        </PopoverContent>
      </Popover>

      <ChangeRequestDetailDialog
        crId={c.selectedCrId}
        onClose={() => c.setSelectedCrId(null)}
      />
    </>
  );
}

export function ProjectChangeRequestsNavItem({ projectId }: { projectId: string }) {
  return (
    <ProjectFilesProvider value={{ projectId, ref: '' }}>
      <NavItemInner />
    </ProjectFilesProvider>
  );
}

export function ProjectChangeRequestsRailItem({ projectId }: { projectId: string }) {
  return (
    <ProjectFilesProvider value={{ projectId, ref: '' }}>
      <RailItemInner />
    </ProjectFilesProvider>
  );
}
