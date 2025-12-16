'use client';

import { memo } from 'react';
import { CircleDashed, Minimize2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DrawerTitle } from '@/components/ui/drawer';
import { ViewType } from '@/stores/kortix-computer-store';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { ViewToggle } from './ViewToggle';
import { ToolbarButtons } from './ToolbarButtons';

interface PanelHeaderProps {
  agentName?: string;
  onClose: () => void;
  onMinimize?: () => void;
  onMaximize?: () => void;
  isStreaming?: boolean;
  variant?: 'drawer' | 'desktop' | 'motion';
  showMinimize?: boolean;
  layoutId?: string;
  currentView: ViewType;
  onViewChange: (view: ViewType) => void;
  showFilesTab?: boolean;
  isMaximized?: boolean;
}

export const PanelHeader = memo(function PanelHeader({
  agentName,
  onClose,
  onMinimize,
  onMaximize,
  isStreaming = false,
  variant = 'desktop',
  showMinimize = false,
  layoutId,
  currentView,
  onViewChange,
  showFilesTab = true,
  isMaximized = false,
}: PanelHeaderProps) {
  const title = "Kortix Computer";

  if (variant === 'drawer') {
    return (
      <div className="h-14 flex-shrink-0 px-4 flex items-center justify-between border-b border-zinc-200 dark:border-zinc-800">
        <div className="flex items-center gap-2">
          <DrawerTitle className="text-base font-medium text-zinc-900 dark:text-zinc-100">
            {title}
          </DrawerTitle>
        </div>
        <div className="flex items-center gap-3">
          <ViewToggle currentView={currentView} onViewChange={onViewChange} showFilesTab={showFilesTab} />
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="h-8 w-8"
            title="Minimize"
          >
            <Minimize2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-14 flex-shrink-0 px-4 flex items-center justify-between border-b border-zinc-200 dark:border-zinc-800">
      <div className="flex items-center gap-3">
        <ToolbarButtons 
          onClose={onClose}
          onMinimize={onMinimize || onClose}
          onMaximize={onMaximize || (() => {})}
          isMaximized={isMaximized}
        />
        <div className="h-4 w-px bg-zinc-200 dark:bg-zinc-700" />
        <div className="flex items-center gap-2">
          <KortixLogo size={16}/>
          <h2 className="text-base font-medium text-zinc-900 dark:text-zinc-100">
            {title}
          </h2>
        </div>
        {isStreaming && (
          <div className="px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400 flex items-center gap-1.5">
            <CircleDashed className="h-3 w-3 animate-spin" />
            <span>Running</span>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        <ViewToggle currentView={currentView} onViewChange={onViewChange} showFilesTab={showFilesTab} />
      </div>
    </div>
  );
});

PanelHeader.displayName = 'PanelHeader';

