'use client';

import { HoverPrefetchLink } from '../../../components/common/hover-prefetch-link';
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from '../../../../components/ui/sidebar';
import { useIsMobile } from '../../../hooks/utils';
import type { ComponentProps, ReactNode } from 'react';

/** Keep the anchor's intent handlers and the caller's active-route semantics. */
export function ProjectNavRow({
  active,
  label,
  children,
  ...link
}: ComponentProps<typeof HoverPrefetchLink> & {
  active: boolean;
  label: string;
  children: ReactNode;
}) {
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={active}
        tooltip={label}
        className="group/menu-button text-sidebar-foreground relative"
      >
        <HoverPrefetchLink
          {...link}
          onClick={(event) => {
            link.onClick?.(event);
            if (isMobile) setOpenMobile(false);
          }}
        >
          {children}
        </HoverPrefetchLink>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
