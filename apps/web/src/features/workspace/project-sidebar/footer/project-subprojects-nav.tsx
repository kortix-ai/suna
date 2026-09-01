'use client';

import { SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar';
import { useIsMobile } from '@/hooks/utils';
import { useFeatureFlag } from '@kortix/sdk/react';
import { PackageIcon } from '@phosphor-icons/react';
import { HoverPrefetchLink } from '@/components/common/hover-prefetch-link';
import { useParams, usePathname } from 'next/navigation';
import { useCallback } from 'react';

/**
 * The Subprojects row.
 *
 * Subprojects had NO entry point at all before this: the store was reachable only
 * from the project home's preview grid, so scrolling past it once meant the
 * surface was gone. A capability that installs agents, skills, connectors and
 * triggers into the project cannot be a thing you find by accident.
 *
 * Modeled on {@link ProjectAppsNavItem} deliberately, down to the row classes:
 * Subprojects and Apps are the same KIND of thing — a project surface you configure
 * and operate — and they sit together above the session list. It is not a
 * `(capabilities)` tab: that shell is `max-w-2xl` under a tab bar, and a store
 * grid is neither.
 */
export function ProjectSubprojectsNavItem() {
  const pathname = usePathname();
  const params = useParams<{ id: string }>();
  const projectId = params?.id;
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  const subprojectsGate = useFeatureFlag(projectId, 'subprojects');
  const handleClick = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  if (!projectId) return null;
  /* Fail-closed like every other flagged surface: the row exists once the
     project turns the `subprojects` flag on in Settings → Feature flags. Loading
     counts as disabled. */
  if (!subprojectsGate.enabled) return null;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        /* `/subprojects` covers the store AND `/subprojects/runs`, so the row stays active
           across the whole surface rather than going dark on the report page. */
        isActive={pathname?.startsWith(`/projects/${projectId}/subprojects`) === true}
        tooltip="Subprojects"
        /* Must match the row contract of THIS group — New session, Customize
           and Apps. The bottom group (Files, Settings) uses a different one. */
        className="group/menu-button text-muted-foreground hover:text-sidebar-foreground flex items-center gap-2 px-3 text-sm! font-medium [&_svg]:size-4!"
      >
        {/* Hover-gated prefetch, same reason as Apps: prefetching on mount cost
            every session open a full dynamic render of a route most opens never
            visit. */}
        <HoverPrefetchLink href={`/projects/${projectId}/subprojects`} prefetch onClick={handleClick}>
          {/* shrink-0 so the glyph keeps its box when the sidebar is narrow. */}
          <span className="shrink-0">
            <PackageIcon />
          </span>
          Subprojects
        </HoverPrefetchLink>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
