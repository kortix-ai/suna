'use client';

import React from 'react';
import { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface ToolViewIconTitleProps {
  /** The icon to display */
  icon: LucideIcon;
  /** The title text */
  title: string;
  /** Optional subtitle or description */
  subtitle?: string;
  /** Optional click handler for the title (e.g. to open a file) */
  onTitleClick?: () => void;
  /** Additional classes for the container */
  className?: string;
}

/**
 * Standardized icon + title component for tool views.
 * Provides consistent styling for the icon wrapper and title text.
 * Leaves flexibility for each tool view to add custom actions, tabs, etc.
 */
export function ToolViewIconTitle({
  icon: Icon,
  title,
  subtitle,
  onTitleClick,
  className,
}: ToolViewIconTitleProps) {
  return (
    <div className={cn("flex items-center gap-2 min-w-0 overflow-hidden flex-1", className)}>
      <Icon className="w-3.5 h-3.5 text-muted-foreground/80 flex-shrink-0" />
      <div className="min-w-0 flex-1 overflow-hidden flex items-baseline gap-2">
        {onTitleClick ? (
          <div
            className="text-[12.5px] font-medium text-foreground tracking-tight truncate cursor-pointer hover:text-foreground/70 transition-colors"
            onClick={onTitleClick}
            title={subtitle || undefined}
          >
            {title}
          </div>
        ) : (
          <div className="text-[12.5px] font-medium text-foreground tracking-tight truncate">
            {title}
          </div>
        )}
        {subtitle && (
          <div className="text-[11.5px] text-muted-foreground/70 truncate" title={subtitle}>
            {subtitle}
          </div>
        )}
      </div>
    </div>
  );
}

