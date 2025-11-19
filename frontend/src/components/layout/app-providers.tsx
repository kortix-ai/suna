'use client';

import React from 'react';
import { SidebarProvider, SidebarInset } from '@/components/ui/sidebar';
import { SidebarLeft } from '@/components/sidebar/sidebar-left';
import { useDeleteOperationEffects } from '@/stores/delete-operation-store';
import { SubscriptionStoreSync } from '@/stores/subscription-store';

// Wrapper component to handle delete operation side effects
function DeleteOperationEffectsWrapper({ children }: { children: React.ReactNode }) {
  useDeleteOperationEffects();
  return <>{children}</>;
}

interface AppProvidersProps {
  children: React.ReactNode;
  showSidebar?: boolean;
  sidebarContent?: React.ReactNode;
  sidebarSiblings?: React.ReactNode; // Components to render as siblings of SidebarInset (e.g., StatusOverlay, FloatingMobileMenuButton)
}

/**
 * Shared wrapper component that provides common app-level providers:
 * - DeleteOperationEffectsWrapper
 * - SubscriptionStoreSync
 * - SidebarProvider + SidebarLeft + SidebarInset (if showSidebar is true)
 */
export function AppProviders({ 
  children, 
  showSidebar = true,
  sidebarContent,
  sidebarSiblings
}: AppProvidersProps) {
  const content = (
    <DeleteOperationEffectsWrapper>
      <SubscriptionStoreSync>
        {children}
      </SubscriptionStoreSync>
    </DeleteOperationEffectsWrapper>
  );

  if (!showSidebar) {
    return content;
  }

  return (
    <SidebarProvider>
      {sidebarContent || <SidebarLeft />}
      <SidebarInset>
        {content}
      </SidebarInset>
      {sidebarSiblings}
    </SidebarProvider>
  );
}

