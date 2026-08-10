'use client';

import { Badge } from '@/components/ui/badge';
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar';
import { useIsMobile } from '@/hooks/utils';
import { useFeatureFlag } from '@kortix/sdk/react';
import { GlobeIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import { useCallback } from 'react';

export function WorkspaceAppsNavItem() {
  const pathname = usePathname();
  const params = useParams<{ id: string }>();
  const workspaceId = params?.id;
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  const appsGate = useFeatureFlag(workspaceId, 'apps');
  const handleClick = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  if (!workspaceId) return null;
  /* Fail-closed: the entry exists only after the workspace turns the `apps`
     feature flag on in Customize → Feature flags. Loading counts as disabled. */
  if (!appsGate.enabled) return null;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={
          pathname?.startsWith(`/workspaces/${workspaceId}/apps`) === true ||
          pathname?.startsWith(`/projects/${workspaceId}/apps`) === true
        }
        tooltip="Apps"
        className="flex items-center gap-2 text-sm! font-medium [&_svg]:size-4!"
      >
        <Link href={`/workspaces/${workspaceId}/apps`} prefetch onClick={handleClick}>
          <GlobeIcon />
          Apps
          <Badge aria-hidden size="xs" variant="beta" className="ml-auto">
            Experimental
          </Badge>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
