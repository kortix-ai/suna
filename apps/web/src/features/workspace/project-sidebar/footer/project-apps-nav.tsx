'use client';

import { Badge } from '@/components/ui/badge';
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar';
import { useIsMobile } from '@/hooks/utils';
import { useFeatureFlag } from '@kortix/sdk/react';
import { GlobeIcon } from '@phosphor-icons/react';
import Link from 'next/link';
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
  /* Fail-closed: the entry exists only after the project turns the `apps`
     feature flag on in Customize → Feature flags. Loading counts as disabled. */
  if (!appsGate.enabled) return null;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={
          pathname?.startsWith(`/workspaces/${projectId}/apps`) === true ||
          pathname?.startsWith(`/projects/${projectId}/apps`) === true
        }
        tooltip="Apps"
        className="flex items-center gap-2 text-sm! font-medium [&_svg]:size-4!"
      >
        <Link href={`/workspaces/${projectId}/apps`} prefetch onClick={handleClick}>
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
