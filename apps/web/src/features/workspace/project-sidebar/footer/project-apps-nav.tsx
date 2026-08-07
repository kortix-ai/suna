'use client';

import { SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar';
import { useIsMobile } from '@/hooks/utils';
import { useAppsFeatureEnabled } from '@/hooks/projects/use-apps-feature-enabled';
import { GlobeIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import { useCallback } from 'react';

export function ProjectAppsNavItem() {
  const pathname = usePathname();
  const params = useParams<{ id: string }>();
  const projectId = params?.id;
  const appsGate = useAppsFeatureEnabled(projectId);
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  const handleClick = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  if (!projectId || !appsGate.enabled) return null;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={pathname?.startsWith(`/projects/${projectId}/apps`) === true}
        tooltip="Apps"
        className="flex items-center gap-2 text-sm! font-medium [&_svg]:size-4!"
      >
        <Link href={`/projects/${projectId}/apps`} prefetch onClick={handleClick}>
          <GlobeIcon />
          Apps
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
