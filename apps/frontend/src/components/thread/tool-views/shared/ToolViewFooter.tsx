'use client';

import React from 'react';
import { Clock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatTimestamp } from '../utils';

export interface ToolViewFooterProps {
  /** Children to render on the left side of the footer */
  children?: React.ReactNode;
  /** Assistant message timestamp */
  assistantTimestamp?: string;
  /** Tool result timestamp */
  toolTimestamp?: string;
  /** Whether the tool is currently streaming */
  isStreaming?: boolean;
  /** Additional classes for the footer */
  className?: string;
}

/**
 * Standardized footer component for tool views.
 * Provides consistent styling with timestamp on the right.
 */
export function ToolViewFooter({
  children,
  assistantTimestamp,
  toolTimestamp,
  isStreaming = false,
  className,
}: ToolViewFooterProps) {
  const displayTimestamp = toolTimestamp && !isStreaming
    ? formatTimestamp(toolTimestamp)
    : assistantTimestamp
      ? formatTimestamp(assistantTimestamp)
      : '';

  return (
    <div className={cn(
      "px-4 py-2 h-10 bg-gradient-to-r from-zinc-50/90 to-zinc-100/90 dark:from-zinc-900/90 dark:to-zinc-800/90 backdrop-blur-sm border-t border-zinc-200 dark:border-zinc-800 flex justify-between items-center gap-4",
      className
    )}>
      <div className="h-full flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
        {children}
      </div>
      {displayTimestamp && (
        <div className="text-xs text-zinc-500 dark:text-zinc-400 flex items-center gap-2">
          <Clock className="h-3.5 w-3.5" />
          {displayTimestamp}
        </div>
      )}
    </div>
  );
}

