'use client';

import { HoverPrefetchLink } from '@/components/common/hover-prefetch-link';
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar';
import { useIsMobile } from '@/hooks/utils';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { useProjectApps } from '@kortix/sdk/react';
import { AppWindowIcon } from '@phosphor-icons/react';
import { useTranslations } from '@/i18n/use-translations';
import { useParams, usePathname } from 'next/navigation';
import { useCallback } from 'react';

/**
 * The Apps row shows to a caller who can deploy an App, or while the project
 * has an App they can open. A member who can do neither got an empty page
 * that told them to "ask an agent to build one". Nothing shows until both
 * answers land, so the row never appears and then vanishes.
 */
export function useAppsRowVisible(projectId: string | undefined): boolean {
  const canDeploy = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_APP_DEPLOY);
  const apps = useProjectApps(projectId);
  if (canDeploy.allowed === true) return true;
  if (canDeploy.isLoading) return false;
  return (apps.data?.length ?? 0) > 0;
}

export function ProjectAppsNavItem() {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const pathname = usePathname();
  const params = useParams<{ id: string }>();
  const projectId = params?.id;
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  const visible = useAppsRowVisible(projectId);
  const handleClick = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  if (!projectId || !visible) return null;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={pathname?.startsWith(`/projects/${projectId}/apps`) === true}
        tooltip={tI18nComplete.raw('text89dd748442c1')}
        /* Must match the row contract of THIS group — New session and Customize
           (project-settings-nav `ProjectCustomizeNavItem`). The bottom group
           (Files, Settings) uses a different one with no px-3 and no muted
           resting colour; Apps kept that after moving up here, which left its
           icon and label ~8px left of its neighbours and a shade darker. */
        className="group/menu-button text-sidebar-foreground relative"
      >
        {/* Hover-gated prefetch: prefetching on mount cost every session open a
            full dynamic render of /apps for a route most opens never visit. */}
        <HoverPrefetchLink href={`/projects/${projectId}/apps`} prefetch onClick={handleClick}>
          {/* shrink-0 so the glyph keeps its box when the label is long or the
              sidebar is narrow — the sibling rows wrap their icons the same way. */}
          <span className="shrink-0">
            <AppWindowIcon />
          </span>
          {tI18nComplete.raw('text89dd748442c1')}
        </HoverPrefetchLink>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
