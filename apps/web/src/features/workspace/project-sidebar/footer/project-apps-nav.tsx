'use client';

import { useCallback } from 'react';

import Hint from '@/components/ui/hint';
import { IconApp } from '@/components/ui/kortix-icons';
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar';
import { useAppsEnabled } from '@/hooks/projects/use-apps-enabled';
import { useIsMobile } from '@/hooks/utils';
import { useAppsOverlayStore } from '@/stores/apps-overlay-store';

function useAppsActivate() {
  const openApps = useAppsOverlayStore((s) => s.openApps);
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();

  return useCallback(() => {
    openApps();
    if (isMobile) setOpenMobile(false);
  }, [openApps, isMobile, setOpenMobile]);
}

export function ProjectAppsNavItem({ projectId }: { projectId: string }) {
  const enabled = useAppsEnabled(projectId);
  const onClick = useAppsActivate();
  const overlayOpen = useAppsOverlayStore((s) => s.open);

  if (!enabled) return null;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        onClick={onClick}
        isActive={overlayOpen}
        tooltip="Apps"
        className="text-sm! font-medium [&_svg]:size-4!"
      >
        <IconApp />
        <span>Apps</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

export function ProjectAppsRailItem({ projectId }: { projectId: string }) {
  const enabled = useAppsEnabled(projectId);
  const onClick = useAppsActivate();

  if (!enabled) return null;

  return (
    <Hint label="Apps">
      <SidebarMenuButton type="button" aria-label="Apps" onClick={onClick}>
        <IconApp className="size-4.5!" />
      </SidebarMenuButton>
    </Hint>
  );
}
