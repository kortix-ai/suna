'use client';

import { ArrowRight, GitBranch, GitMerge, GitPullRequest } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { ChangeRequest } from '@/features/project-files/api/change-requests';
import { ChangeRequestDetailDialog } from '@/features/project-files/components/change-request-detail-dialog';
import { ProjectFilesProvider } from '@/features/project-files/context';
import { useChangeRequests } from '@/features/project-files/hooks/use-change-requests';

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
  const crs = useMemo(() => data?.change_requests ?? [], [data?.change_requests]);
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
    <div className="w-full overflow-hidden py-1">
      <div className="border-border flex items-center justify-between gap-3 border-b px-3.5 py-1.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-md bg-emerald-500/10 text-emerald-600">
            <GitPullRequest className="size-4" />
          </span>
          <div className="min-w-0">
            <h3 className="text-foreground truncate text-sm font-medium">Open changes</h3>
            <p className="text-muted-foreground truncate text-xs">
              {crs.length} ready for {baseRef || 'main'}
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
                <GitBranch className="size-3 shrink-0" />
                <span className="truncate font-mono">{cr.head_ref.slice(0, 7)}</span>
                <span className="text-muted-foreground/60">→</span>
                {cr.base_ref === 'main' ? (
                  <Badge variant="kortix" size="xs">
                    {cr.base_ref.slice(0, 7)}
                  </Badge>
                ) : (
                  <span className="shrink-0 truncate font-mono">{cr.base_ref}</span>
                )}
              </div>
            </div>
            <ArrowRight className="text-muted-foreground/50 group-hover:text-foreground size-3.5 shrink-0 transition-colors" />
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

  const menuButton = (
    <SidebarMenuButton
      variant="success"
      className="text-sm! font-medium [&_svg]:size-4!"
      onClick={c.count === 1 ? () => c.openCr(c.crs[0].cr_id) : undefined}
    >
      <GitPullRequest />
      <span>{label}</span>
      <span className="ml-auto pr-1 text-xs tabular-nums">{c.count}</span>
    </SidebarMenuButton>
  );

  return (
    <SidebarMenuItem>
      {c.count === 1 ? (
        menuButton
      ) : (
        <HoverCard openDelay={150} closeDelay={100}>
          <HoverCardTrigger asChild>{menuButton}</HoverCardTrigger>
          <HoverCardContent
            side="right"
            align="end"
            sideOffset={12}
            className="w-[340px] overflow-hidden p-0"
          >
            <OpenCrChooser crs={c.crs} baseRef={baseRef} onPick={c.openCr} />
          </HoverCardContent>
        </HoverCard>
      )}

      <ChangeRequestDetailDialog crId={c.selectedCrId} onClose={() => c.setSelectedCrId(null)} />
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
                className="text-sidebar-foreground relative flex w-full items-center justify-center rounded-lg py-2 transition-colors duration-150 ease-out hover:bg-emerald-500/15"
              >
                <GitMerge className="size-4 text-emerald-600" />
                <span className="absolute top-1 right-1 flex size-1.5">
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
          className="w-[340px] overflow-hidden p-0"
        >
          <OpenCrChooser crs={c.crs} baseRef={baseRef} onPick={c.openCr} />
        </PopoverContent>
      </Popover>

      <ChangeRequestDetailDialog crId={c.selectedCrId} onClose={() => c.setSelectedCrId(null)} />
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
