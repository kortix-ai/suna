'use client';
import {
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';
import { XIcon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';
export function PromoNavRow({
  icon,
  label,
  badge,
  dismissLabel,
  onDismiss,
  onClick,
  pending = false,
}: {
  icon: ReactNode;
  label: string;
  badge: string;
  dismissLabel: string;
  onDismiss: () => void;
  onClick: () => void;
  pending?: boolean;
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        className="text-sidebar-foreground bg-hover group-has-data-[sidebar=menu-action]/menu-item:pr-12"
        disabled={pending}
        aria-busy={pending || undefined}
        onClick={onClick}
      >
        {icon}
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </SidebarMenuButton>
      <SidebarMenuBadge className="bg-kortix-blue/15 text-foreground mr-1 rounded-sm px-1.5 group-focus-within/menu-item:opacity-0 group-hover/menu-item:opacity-0 max-md:hidden">
        {badge}
      </SidebarMenuBadge>
      <SidebarMenuAction onClick={onDismiss} aria-label={dismissLabel} showOnHover className="mr-1">
        <XIcon />
      </SidebarMenuAction>
    </SidebarMenuItem>
  );
}
