'use client';

import { useCallback } from 'react';
import { Config } from '@mynaui/icons-react';
import { SlidersHorizontal } from 'lucide-react';

import { SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useIsMobile } from '@/hooks/utils';
import { cn } from '@/lib/utils';
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
        className="!text-sm font-medium [&_svg]:!size-4"
      >
        <Config />
        <span>Customize</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

export function ProjectCustomizeRailItem() {
  const onClick = useCustomizeActivate();
  const customizeOpen = useCustomizeStore((s) => s.open);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="Customize"
          onClick={onClick}
          className={cn(
            'flex w-full items-center justify-center rounded-lg py-2 transition-colors duration-150 ease-out',
            customizeOpen
              ? 'bg-sidebar-accent text-sidebar-accent-foreground'
              : 'text-sidebar-foreground hover:bg-sidebar-accent',
          )}
        >
          <SlidersHorizontal className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={12} className="text-xs">
        Customize
      </TooltipContent>
    </Tooltip>
  );
}
