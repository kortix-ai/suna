'use client';

import { HoverPrefetchLink } from '../components/hover-prefetch-link';
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from '../../primitives/sidebar';
import { useIsMobile } from '../hooks';
import { cn } from '../lib/utils';
import type { ComponentProps, ReactNode } from 'react';

/** Keep the anchor's intent handlers and the caller's active-route semantics. */
export function ProjectNavRow({
  active,
  label,
  className,
  children,
  ...link
}: ComponentProps<typeof HoverPrefetchLink> & {
  active: boolean;
  label: string;
  /** Added to the row button's classes. */
  className?: string;
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
        className={cn('group/menu-button text-sidebar-foreground relative', className)}
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
