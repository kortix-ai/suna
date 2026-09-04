'use client';

import { HoverPrefetchLink } from '@/components/common/hover-prefetch-link';
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar';
import { useIsMobile } from '@/hooks/utils';
import { useFeatureFlag } from '@kortix/sdk/react';
import { KanbanIcon } from '@phosphor-icons/react';
import { useParams, usePathname } from 'next/navigation';
import { useCallback } from 'react';

/**
 * Monitoring — the stage board over every session the caller can see. Sits
 * with Customize and Apps: a project surface you operate, not an alert.
 * Fail-closed on the `monitoring` flag like Apps; loading counts as disabled.
 */
export function ProjectMonitoringNavItem() {
  const pathname = usePathname();
  const params = useParams<{ id: string }>();
  const projectId = params?.id;
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  const gate = useFeatureFlag(projectId, 'monitoring');
  const handleClick = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  if (!projectId) return null;
  if (!gate.enabled) return null;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={pathname?.startsWith(`/projects/${projectId}/monitoring`) === true}
        tooltip="Monitoring"
        /* Same row contract as New session / Customize / Apps above it. */
        className="group/menu-button text-muted-foreground hover:text-sidebar-foreground flex items-center gap-2 px-3 text-sm! font-medium [&_svg]:size-4!"
      >
        <HoverPrefetchLink
          href={`/projects/${projectId}/monitoring`}
          prefetch
          onClick={handleClick}
        >
          <span className="shrink-0">
            <KanbanIcon />
          </span>
          Monitoring
        </HoverPrefetchLink>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
