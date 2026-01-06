'use client';

import React, { Suspense, lazy } from 'react';
import { SidebarProvider, SidebarInset } from '@/components/ui/sidebar';
import { useDeleteOperationEffects } from '@/stores/delete-operation-store';
import { SubscriptionStoreSync } from '@/stores/subscription-store';

// Lazy load the heavy sidebar component
const SidebarLeft = lazy(() => 
  import('@/components/sidebar/sidebar-left').then(mod => ({ default: mod.SidebarLeft }))
);

// Sidebar skeleton for immediate render
function SidebarSkeleton() {
  return (
    <div className="hidden md:flex w-[280px] flex-col border-r border-border bg-sidebar shrink-0">
      <div className="p-4 space-y-4">
        <div className="h-8 w-32 bg-muted/40 rounded animate-pulse" />
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-9 bg-muted/30 rounded animate-pulse" />
          ))}
        </div>
      </div>
      <div className="flex-1" />
      <div className="p-4">
        <div className="h-10 bg-muted/30 rounded animate-pulse" />
      </div>
    </div>
  );
}

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
      {sidebarContent || (
        <Suspense fallback={<SidebarSkeleton />}>
          <SidebarLeft />
        </Suspense>
      )}
      <SidebarInset>
        {content}
      </SidebarInset>
      {sidebarSiblings}
    </SidebarProvider>
  );
}

