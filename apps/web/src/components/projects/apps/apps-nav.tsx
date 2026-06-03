'use client';

/**
 * "Apps" — the project-sidebar entry that opens the {@link AppsOverlay}.
 *
 * Two surfaces share one controller (mirrors {@link ProjectChangeRequestsNavItem}):
 *
 *   • <ProjectAppsNavItem>  — the expanded sidebar row.
 *   • <ProjectAppsRailItem> — the collapsed icon-rail button.
 *
 * Both hide themselves unless the experimental [[apps]] surface is enabled for
 * THIS project. That signal rides on the project payload (`apps_enabled`, a
 * per-project toggle in Customize → Settings over the operator default) so this
 * UI and the /apps routes are gated by the SAME value — enable it and both
 * light up.
 */

import { useQuery } from '@tanstack/react-query';

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import { IconApp } from '@/components/ui/kortix-icons';
import { getProjectDetail } from '@/lib/projects-client';
import { cn } from '@/lib/utils';
import { useAppsOverlayStore } from '@/stores/apps-overlay-store';

/** Shared gate — is the [[apps]] surface enabled for this project's platform? */
function useAppsEnabled(projectId: string): boolean {
  const { data } = useQuery({
    queryKey: ['project-detail', projectId],
    queryFn: () => getProjectDetail(projectId),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  return data?.project?.apps_enabled ?? false;
}

/** Expanded sidebar row — renders an <li>; place inside a <SidebarMenu>. */
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
        className="!text-sm font-normal data-[active=true]:font-normal !transition-none transform-none [&_svg]:!size-4"
      >
        <IconApp />
        <span>Apps</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/** Collapsed icon-rail button — mirrors the rail's other icon buttons. */
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
            'flex w-full items-center justify-center rounded-lg py-2 transition-colors duration-150 ease-out',
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
