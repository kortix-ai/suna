'use client';

/**
 * Re-export of the canonical sidebar primitives from @kortix/design-system.
 *
 * Everything in apps/web that imports `@/components/ui/sidebar` ends up in
 * the same React context as code that imports `@kortix/design-system` directly,
 * which is what lets the AppProviders' provider drive every consumer.
 *
 * The local twist: the dashboard's document modal grabs the keyboard, so the
 * global Cmd+B toggle needs to be muted while it's open. `SidebarProvider`
 * exposes a `shortcutDisabled` prop for exactly this — we wrap it here so
 * callers don't have to wire the store every time.
 */

import * as React from 'react';

import {
  SidebarProvider as DesignSystemSidebarProvider,
  useSidebar,
} from '@kortix/design-system/components/sidebar';
import { useDocumentModalStore } from '@/stores/use-document-modal-store';

function SidebarProvider({
  shortcutDisabled,
  ...rest
}: React.ComponentProps<typeof DesignSystemSidebarProvider>) {
  const isDocumentModalOpen = useDocumentModalStore((s) => s.isOpen);
  return (
    <DesignSystemSidebarProvider
      {...rest}
      shortcutDisabled={isDocumentModalOpen || shortcutDisabled}
    />
  );
}

export { SidebarProvider, useSidebar };

export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
  SidebarContext,
} from '@kortix/design-system/components/sidebar';
