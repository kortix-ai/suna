'use client';

import React from 'react';
import { CardHeader, CardTitle } from '@/components/ui/card';
import { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface ToolViewHeaderProps {
  /** The icon to display */
  icon: LucideIcon;
  /** The title text */
  title: string;
  /** Optional subtitle or description */
  subtitle?: string;
  /** Children to render on the right side of the header */
  children?: React.ReactNode;
  /** Additional classes for the header */
  className?: string;
}

/**
 * Standardized header component for tool views.
 * Provides consistent styling across all tool views with neutral black/white colors.
 */
export function ToolViewHeader({
  icon: Icon,
  title,
  subtitle,
  children,
  className,
}: ToolViewHeaderProps) {
  return (
    <CardHeader className={cn(
      // Minimal header: bare row with a hairline bottom border, no muted fill,
      // no chunky icon wrapper. Icon sits inline with the title text.
      "h-11 bg-background border-b border-border/50 px-3 py-0 space-y-0 flex justify-center",
      className
    )}>
      <div className="flex flex-row items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <Icon className="w-3.5 h-3.5 text-muted-foreground/80 flex-shrink-0" />
          <div className="min-w-0 flex-1 flex items-baseline gap-2">
            <CardTitle className="text-sm font-medium text-foreground tracking-tight truncate">
              {title}
            </CardTitle>
            {subtitle && (
              <p className="text-xs text-muted-foreground/70 truncate">
                {subtitle}
              </p>
            )}
          </div>
        </div>
        {children && (
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {children}
          </div>
        )}
      </div>
    </CardHeader>
  );
}

