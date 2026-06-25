'use client';

import { Activity } from '@mynaui/icons-react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';
import { useGatewayOverlayStore } from '@/stores/gateway-overlay-store';

export function ProjectGatewayNavItem() {
  const openGateway = useGatewayOverlayStore((s) => s.openGateway);
  const overlayOpen = useGatewayOverlayStore((s) => s.open);

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        onClick={() => openGateway()}
        isActive={overlayOpen}
        className="!text-sm font-normal data-[active=true]:font-normal !transition-none transform-none [&_svg]:!size-4"
      >
        <Activity />
        <span>Gateway</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

export function ProjectGatewayRailItem() {
  const openGateway = useGatewayOverlayStore((s) => s.openGateway);
  const overlayOpen = useGatewayOverlayStore((s) => s.open);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="Gateway"
          onClick={() => openGateway()}
          className={cn(
            'flex w-full items-center justify-center rounded-lg py-2 transition-colors duration-150 ease-out',
            overlayOpen
              ? 'bg-sidebar-accent text-sidebar-accent-foreground'
              : 'text-sidebar-foreground hover:bg-sidebar-accent',
          )}
        >
          <Activity className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={12} className="text-xs">
        Gateway
      </TooltipContent>
    </Tooltip>
  );
}
