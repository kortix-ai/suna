'use client';

import { useQuery } from '@tanstack/react-query';

import { IconApp } from '@/components/ui/kortix-icons';
import { SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { getProjectDetail } from '@/lib/projects-client';
import { cn } from '@/lib/utils';
import { useAppsOverlayStore } from '@/stores/apps-overlay-store';

function useAppsEnabled(projectId: string): boolean {
  const { data } = useQuery({
    queryKey: ['project-detail', projectId],
    queryFn: () => getProjectDetail(projectId),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  return data?.project?.apps_enabled ?? false;
}

export function ProjectAppsNavItem({ projectId }: { projectId: string }) {
  const enabled = useAppsEnabled(projectId);
  const openApps = useAppsOverlayStore((s) => s.openApps);
  const overlayOpen = useAppsOverlayStore((s) => s.open);

  if (!enabled) return null;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        onClick={() => openApps()}
        isActive={overlayOpen}
        className="transform-none !text-sm font-normal !transition-none data-[active=true]:font-normal [&_svg]:!size-4"
      >
        <IconApp />
        <span>Apps</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

export function ProjectAppsRailItem({ projectId }: { projectId: string }) {
  const enabled = useAppsEnabled(projectId);
  const openApps = useAppsOverlayStore((s) => s.openApps);
  const overlayOpen = useAppsOverlayStore((s) => s.open);

  if (!enabled) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="Apps"
          onClick={() => openApps()}
          className={cn(
            'flex size-8 items-center justify-center rounded-md transition-colors duration-150 ease-out',
            overlayOpen
              ? 'bg-sidebar-accent text-sidebar-accent-foreground'
              : 'text-sidebar-foreground hover:bg-sidebar-accent',
          )}
        >
          <IconApp className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={12} className="text-xs">
        Apps
      </TooltipContent>
    </Tooltip>
  );
}
