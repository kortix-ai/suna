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
  className,
}: ToolViewIconTitleProps) {
  return (
    <div className={cn("flex items-center gap-2 min-w-0", className)}>
      <div className="relative p-2 rounded-lg border bg-zinc-100 dark:bg-zinc-800 border-zinc-200 dark:border-zinc-700 flex-shrink-0">
        <Icon className="w-5 h-5 text-zinc-700 dark:text-zinc-300" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-base font-medium text-zinc-900 dark:text-zinc-100 truncate">
          {title}
        </div>
        {subtitle && (
          <div className="text-xs text-zinc-500 dark:text-zinc-400 truncate">
            {subtitle}
          </div>
        )}
      </div>
    </div>
  );
}

