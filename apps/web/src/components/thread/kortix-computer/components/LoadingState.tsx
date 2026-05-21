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

function LoadingSkeleton() {
  return (
    <div className="flex-1 p-4 overflow-auto">
      <div className="space-y-4">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-20 w-full rounded-2xl" />
        <Skeleton className="h-40 w-full rounded-2xl" />
        <Skeleton className="h-20 w-full rounded-2xl" />
      </div>
    </div>
  );
}

export const LoadingState = memo(function LoadingState({
  agentName,
  onClose,
  isMobile,
}: LoadingStateProps) {
  const { activeView, setActiveView } = useKortixComputerStore();

  if (isMobile) {
    return (
      <DrawerContent
        className="h-[85vh]"
        onKeyDown={(e) => {
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
        <LoadingSkeleton />
      </DrawerContent>
    );
  }

  // Desktop: render inline (container is provided by parent layout)
  return (
    <div className="flex flex-col h-full bg-card rounded-[24px] border overflow-hidden">
      <PanelHeader
        agentName={agentName}
        onClose={onClose}
        onMaximize={() => {}}
        currentView={activeView}
        onViewChange={setActiveView}
      />
      <LoadingSkeleton />
    </div>
  );
});

LoadingState.displayName = 'LoadingState';
