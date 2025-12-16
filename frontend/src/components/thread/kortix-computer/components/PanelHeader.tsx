'use client';

import { memo } from 'react';
import { CircleDashed, Minimize2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DrawerTitle } from '@/components/ui/drawer';
import { ViewType } from '@/stores/kortix-computer-store';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { cn } from '@/lib/utils';
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
  hideViewToggle?: boolean;
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
  hideViewToggle = false,
}: PanelHeaderProps) {
  const title = "Kortix Computer";

  if (variant === 'drawer') {
    return (
      <div className="h-14 flex-shrink-0 px-4 flex items-center justify-between border-b border-border">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 flex items-center justify-center">
            <KortixLogo size={18}/>
          </div>
          <DrawerTitle className="text-sm font-semibold text-foreground">
            {title}
          </DrawerTitle>
        </div>
        <div className="flex items-center gap-2">
          <ViewToggle currentView={currentView} onViewChange={onViewChange} showFilesTab={showFilesTab} />
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="h-8 w-8 text-muted-foreground hover:text-foreground"
            title="Minimize"
          >
            <Minimize2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className={cn(
      "h-14 flex-shrink-0 px-4 grid grid-cols-3 items-center",
      !isMaximized && "border-b border-border"
    )}>
      {/* Left: Traffic light buttons */}
      <div className="flex items-center justify-start">
        <ToolbarButtons 
          onClose={onClose}
          onMinimize={onMinimize || onClose}
          onMaximize={onMaximize || (() => {})}
          isMaximized={isMaximized}
        />
      </div>

      {/* Center: Logo and title (always centered) */}
      <div className="flex items-center justify-center gap-2">
        <div className="w-6 h-6 flex items-center justify-center">
          <KortixLogo size={18}/>
        </div>
        <h2 className="text-md font-semibold text-foreground">
          {title}
        </h2>
      </div>

      {/* Right: Running indicator + View toggle */}
      <div className="flex items-center justify-end gap-2">
        {isStreaming && (
          <div className="px-2.5 py-1 rounded-md text-xs font-medium bg-primary/10 text-primary flex items-center gap-1.5">
            <CircleDashed className="h-3 w-3 animate-spin" />
            <span>Running</span>
          </div>
        )}
        {!hideViewToggle && (
          <ViewToggle currentView={currentView} onViewChange={onViewChange} showFilesTab={showFilesTab} />
        )}
      </div>
    </div>
  );
});

PanelHeader.displayName = 'PanelHeader';

