'use client';

import { memo, useCallback } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';

interface NavigationControlsProps {
  displayIndex: number;
  displayTotalCalls: number;
  safeInternalIndex: number;
  latestIndex: number;
  isLiveMode: boolean;
  agentStatus: string;
  onPrevious: () => void;
  onNext: () => void;
  onSliderChange: (value: number[]) => void;
  onJumpToLive: () => void;
  onJumpToLatest: () => void;
  isMobile?: boolean;
}

export const NavigationControls = memo(function NavigationControls({
  displayIndex,
  displayTotalCalls,
  safeInternalIndex,
  latestIndex,
  isLiveMode,
  agentStatus,
  onPrevious,
  onNext,
  onSliderChange,
  onJumpToLive,
  onJumpToLatest,
  isMobile = false,
}: NavigationControlsProps) {
  const renderStatusButton = useCallback(() => {
    const baseClasses = "flex items-center justify-center gap-1.5 px-2.5 py-0.5 rounded-full whitespace-nowrap";
    const dotClasses = "w-1.5 h-1.5 rounded-full flex-shrink-0";
    const textClasses = "text-xs font-medium";

    if (isLiveMode) {
      if (agentStatus === 'running') {
        return (
          <div
            className={`${baseClasses} bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 hover:bg-blue-100 dark:hover:bg-blue-900/30 transition-colors cursor-pointer`}
            onClick={onJumpToLive}
          >
            <div className={`${dotClasses} bg-blue-500 animate-pulse`} />
            <span className={`${textClasses} text-zinc-700 dark:text-zinc-400`}>Live Updates</span>
          </div>
        );
      } else {
        return (
          <div className={`${baseClasses} bg-neutral-50 dark:bg-neutral-900/20 border border-neutral-200 dark:border-neutral-800`}>
            <div className={`${dotClasses} bg-neutral-500`} />
            <span className={`${textClasses} text-neutral-700 dark:text-neutral-400`}>Latest Tool</span>
          </div>
        );
      }
    } else {
      if (agentStatus === 'running') {
        return (
          <div
            className={`${baseClasses} bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 hover:bg-blue-100 dark:hover:bg-blue-900/30 transition-colors cursor-pointer`}
            onClick={onJumpToLive}
          >
            <div className={`${dotClasses} bg-blue-500 animate-pulse`} />
            <span className={`${textClasses} text-zinc-700 dark:text-zinc-400`}>Jump to Live</span>
          </div>
        );
      } else {
        return (
          <div
            className={`${baseClasses} bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors cursor-pointer`}
            onClick={onJumpToLatest}
          >
            <div className={`${dotClasses} bg-zinc-500`} />
            <span className={`${textClasses} text-zinc-700 dark:text-zinc-300`}>Jump to Latest</span>
          </div>
        );
      }
    }
  }, [isLiveMode, agentStatus, onJumpToLive, onJumpToLatest]);

  if (isMobile) {
    return (
      <div className="border-t border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 p-3">
        <div className="flex items-center justify-between">
          <Button
            variant="outline"
            size="sm"
            onClick={onPrevious}
            disabled={displayIndex <= 0}
            className="h-8 px-2.5 text-xs"
          >
            <ChevronLeft className="h-3.5 w-3.5 mr-1" />
            <span>Prev</span>
          </Button>

          <div className="flex items-center gap-1.5">
            <span className="text-xs text-zinc-600 dark:text-zinc-400 font-medium tabular-nums min-w-[44px]">
              {safeInternalIndex + 1}/{displayTotalCalls}
            </span>
            {renderStatusButton()}
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={onNext}
            disabled={displayIndex >= displayTotalCalls - 1}
            className="h-8 px-2.5 text-xs"
          >
            <span>Next</span>
            <ChevronRight className="h-3.5 w-3.5 ml-1" />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="border-t border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 px-4 py-2.5">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={onPrevious}
            disabled={displayIndex <= 0}
            className="h-7 w-7 text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-xs text-zinc-600 dark:text-zinc-400 font-medium tabular-nums px-1 min-w-[44px] text-center">
            {displayIndex + 1}/{displayTotalCalls}
          </span>
          <Button
            variant="ghost"
            size="icon"
            onClick={onNext}
            disabled={safeInternalIndex >= latestIndex}
            className="h-7 w-7 text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex-1 relative">
          <Slider
            min={0}
            max={Math.max(0, displayTotalCalls - 1)}
            step={1}
            value={[safeInternalIndex]}
            onValueChange={onSliderChange}
            className="w-full [&>span:first-child]:h-1.5 [&>span:first-child]:bg-zinc-200 dark:[&>span:first-child]:bg-zinc-800 [&>span:first-child>span]:bg-zinc-500 dark:[&>span:first-child>span]:bg-zinc-400 [&>span:first-child>span]:h-1.5"
          />
        </div>

        <div className="flex items-center gap-1.5">
          {renderStatusButton()}
        </div>
      </div>
    </div>
  );
});

NavigationControls.displayName = 'NavigationControls';

