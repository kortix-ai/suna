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
      "px-3 h-9 bg-background border-t border-border/50 flex justify-between items-center gap-4",
      className
    )}>
      <div className="h-full flex items-center gap-2 text-[11.5px] text-muted-foreground/80">
        {children}
      </div>
      {displayTimestamp && (
        <div className="text-[11px] text-muted-foreground/60 flex items-center gap-1.5">
          <Clock className="h-3 w-3" />
          {displayTimestamp}
        </div>
      )}
    </div>
  );
}

