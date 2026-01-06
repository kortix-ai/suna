'use client';

import { memo } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { DrawerContent } from '@/components/ui/drawer';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import { PanelHeader } from './PanelHeader';

interface LoadingStateProps {
  agentName?: string;
  onClose: () => void;
  isMobile: boolean;
}

export const LoadingState = memo(function LoadingState({ 
  agentName, 
  onClose, 
  isMobile 
}: LoadingStateProps) {
  const { activeView, setActiveView } = useKortixComputerStore();
  
  if (isMobile) {
    return (
      <DrawerContent
        className="h-[85vh]"
        onKeyDown={(e) => {
          // Prevent Escape / Esc from dismissing the Drawer (Kortix Computer).
          if (e.key === 'Escape' || e.key === 'Esc') {
            e.preventDefault();
            e.stopPropagation();
          }
        }}
      >
        <PanelHeader
          agentName={agentName}
          onClose={onClose}
          variant="drawer"
          currentView={activeView}
          onViewChange={setActiveView}
        />

        <div className="flex-1 p-4 overflow-auto">
          <div className="space-y-4">
            <Skeleton className="h-8 w-32" />
            <Skeleton className="h-20 w-full rounded-md" />
            <Skeleton className="h-40 w-full rounded-md" />
            <Skeleton className="h-20 w-full rounded-md" />
          </div>
        </div>
      </DrawerContent>
    );
  }

  return (
    <div className="fixed inset-0 z-30 pointer-events-none">
      <div className="p-4 h-full flex items-stretch justify-end pointer-events-auto">
        <div className="border rounded-2xl flex flex-col shadow-2xl bg-background w-[90%] sm:w-[450px] md:w-[500px] lg:w-[550px] xl:w-[650px]">
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="flex flex-col h-full">
              <PanelHeader
                agentName={agentName}
                onClose={onClose}
                onMaximize={() => {}}
                currentView={activeView}
                onViewChange={setActiveView}
              />
              <div className="flex-1 p-4 overflow-auto">
                <div className="space-y-4">
                  <Skeleton className="h-8 w-32" />
                  <Skeleton className="h-20 w-full rounded-md" />
                  <Skeleton className="h-40 w-full rounded-md" />
                  <Skeleton className="h-20 w-full rounded-md" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});

LoadingState.displayName = 'LoadingState';
