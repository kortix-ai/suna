'use client';

import { SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar';
import { useIsMobile } from '@/hooks/utils';
import { useFeatureFlag } from '@kortix/sdk/react';
import { AppWindowIcon, GlobeIcon } from '@phosphor-icons/react';
import { HoverPrefetchLink } from '@/components/common/hover-prefetch-link';
import { useParams, usePathname } from 'next/navigation';
import { useCallback } from 'react';

export function ProjectAppsNavItem() {
  const pathname = usePathname();
  const params = useParams<{ id: string }>();
  const projectId = params?.id;
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  const appsGate = useFeatureFlag(projectId, 'apps');
  const handleClick = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  if (!projectId) return null;
  /* Fail-closed like every other flagged surface: the entry exists once the
     project turns the `apps` feature flag on in Settings → Feature flags.
     Loading counts as disabled. Apps is a STABLE flag — an ordinary per-project
     opt-in, so the row carries no stability badge. */
  if (!appsGate.enabled) return null;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={pathname?.startsWith(`/projects/${projectId}/apps`) === true}
        tooltip="Apps"
        /* Must match the row contract of THIS group — New session and Customize
           (project-settings-nav `ProjectCustomizeNavItem`). The bottom group
           (Files, Settings) uses a different one with no px-3 and no muted
           resting colour; Apps kept that after moving up here, which left its
           icon and label ~8px left of its neighbours and a shade darker. */
        className="group/menu-button text-muted-foreground hover:text-sidebar-foreground flex items-center gap-2 px-3 text-sm! font-medium [&_svg]:size-4!"
      >
        {/* Hover-gated prefetch: prefetching on mount cost every session open a
            full dynamic render of /apps for a route most opens never visit. */}
        <HoverPrefetchLink href={`/projects/${projectId}/apps`} prefetch onClick={handleClick}>
          {/* shrink-0 so the glyph keeps its box when the label is long or the
              sidebar is narrow — the sibling rows wrap their icons the same way. */}
          <span className="shrink-0">
            <AppWindowIcon />
          </span>
          Apps
        </HoverPrefetchLink>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
