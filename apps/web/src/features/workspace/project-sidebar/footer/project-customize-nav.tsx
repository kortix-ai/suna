'use client';

import { Config } from '@mynaui/icons-react';
import { useCallback } from 'react';

import Hint from '@/components/ui/hint';
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar';
import { useIsMobile } from '@/hooks/utils';
import { useCustomizeStore } from '@/stores/customize-store';

function useCustomizeActivate() {
  const openCustomize = useCustomizeStore((s) => s.openCustomize);
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();

  return useCallback(() => {
    openCustomize();
    if (isMobile) setOpenMobile(false);
  }, [openCustomize, isMobile, setOpenMobile]);
}

export function ProjectCustomizeNavItem() {
  const onClick = useCustomizeActivate();
  const customizeOpen = useCustomizeStore((s) => s.open);

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        onClick={onClick}
        isActive={customizeOpen}
        tooltip="Customize"
        className="text-sm! font-medium [&_svg]:size-4!"
      >
        <Config />
        <span>Customize</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

export function ProjectCustomizeRailItem() {
  const onClick = useCustomizeActivate();

  return (
    <Hint label="Customize">
      <SidebarMenuButton type="button" aria-label="Customize" onClick={onClick}>
        <Config className="size-4.5!" />
      </SidebarMenuButton>
    </Hint>
  );
}
