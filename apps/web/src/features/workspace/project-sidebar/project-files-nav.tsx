'use client';

import { FolderOpen } from 'lucide-react';
import { useCallback } from 'react';

import Hint from '@/components/ui/hint';
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar';
import { useIsMobile } from '@/hooks/utils';
import { useCustomizeStore } from '@/stores/customize-store';

/** Jump straight to the workspace Files section (Customize overlay → Files). */
function useOpenFiles() {
  const openCustomize = useCustomizeStore((s) => s.openCustomize);
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();

  return useCallback(() => {
    openCustomize('files');
    if (isMobile) setOpenMobile(false);
  }, [openCustomize, isMobile, setOpenMobile]);
}

export function ProjectFilesNavItem() {
  const onClick = useOpenFiles();
  const isActive = useCustomizeStore((s) => s.open && s.section === 'files');

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        onClick={onClick}
        isActive={isActive}
        tooltip="Files"
        className="text-sm! font-medium [&_svg]:size-4!"
      >
        <FolderOpen />
        Files
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

export function ProjectFilesRailItem() {
  const onClick = useOpenFiles();

  return (
    <Hint label="Files">
      <SidebarMenuButton type="button" aria-label="Files" onClick={onClick}>
        <FolderOpen className="size-4.5!" />
      </SidebarMenuButton>
    </Hint>
  );
}
