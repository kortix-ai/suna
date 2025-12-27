'use client';

import { memo } from 'react';
import { Globe, Zap, FolderOpen } from 'lucide-react';
import { motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { ViewType } from '@/stores/kortix-computer-store';
import { HIDE_BROWSER_TAB } from '@/components/thread/utils';

interface ViewToggleProps {
  currentView: ViewType;
  onViewChange: (view: ViewType) => void;
  showFilesTab?: boolean;
}

export const ViewToggle = memo(function ViewToggle({ 
  currentView, 
  onViewChange, 
  showFilesTab = true 
}: ViewToggleProps) {
  // Hide browser tab if flag is enabled
  const viewOptions = HIDE_BROWSER_TAB
    ? (showFilesTab ? ['tools', 'files'] as const : ['tools'] as const)
    : (showFilesTab ? ['tools', 'files', 'browser'] as const : ['tools', 'browser'] as const);
  
  const getViewIndex = (view: ViewType) => {
    if (!showFilesTab && view === 'files') return 0;
    return viewOptions.indexOf(view as any);
  };
  
  const tabWidth = 28;
  const gap = 4;
  
  return (
    <div className="relative flex items-center gap-1 bg-muted rounded-3xl px-1 py-1">
      <motion.div
        className="absolute top-1 left-1 h-7 w-7 bg-white dark:bg-zinc-700 rounded-xl shadow-sm"
        initial={false}
        animate={{
          x: getViewIndex(currentView) * (tabWidth + gap),
        }}
        transition={{
          type: "spring",
          stiffness: 300,
          damping: 30
        }}
      />

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="sm"
            onClick={() => onViewChange('tools')}
            className={`relative z-10 h-7 w-7 p-0 rounded-xl bg-transparent hover:bg-transparent shadow-none ${
              currentView === 'tools'
                ? 'text-black dark:text-white'
                : 'text-gray-500 dark:text-gray-400'
            }`}
          >
            <Zap className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <span>Actions</span>
        </TooltipContent>
      </Tooltip>

      {showFilesTab && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="sm"
              onClick={() => onViewChange('files')}
              className={`relative z-10 h-7 w-7 p-0 rounded-xl bg-transparent hover:bg-transparent shadow-none ${
                currentView === 'files'
                  ? 'text-black dark:text-white'
                  : 'text-gray-500 dark:text-gray-400'
              }`}
            >
              <FolderOpen className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p>Files</p>
          </TooltipContent>
        </Tooltip>
      )}

      {!HIDE_BROWSER_TAB && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="sm"
              onClick={() => onViewChange('browser')}
              className={`relative z-10 h-7 w-7 p-0 rounded-xl bg-transparent hover:bg-transparent shadow-none ${
                currentView === 'browser'
                  ? 'text-black dark:text-white'
                  : 'text-gray-500 dark:text-gray-400'
              }`}
            >
              <Globe className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p>Browser</p>
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
});

ViewToggle.displayName = 'ViewToggle';

