import React, { Fragment } from 'react';
import { LucideIcon, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface BreadcrumbSegment {
  name: string;
  path: string;
  isLast: boolean;
}

interface KortixComputerHeaderProps {
  /** Icon to display in the header */
  icon: LucideIcon;
  /** Click handler for the icon button */
  onIconClick?: () => void;
  /** Tooltip/title for the icon button */
  iconTitle?: string;
  
  /** Simple title to display (mutually exclusive with breadcrumbs and fileName) */
  title?: string;
  
  /** File name to display with chevron separator (for file viewer) */
  fileName?: string;
  
  /** Breadcrumb segments to display (mutually exclusive with title and fileName) */
  breadcrumbs?: BreadcrumbSegment[];
  /** Click handler for breadcrumb navigation */
  onBreadcrumbClick?: (path: string) => void;
  
  /** Actions to display on the right side */
  actions?: React.ReactNode;
}

/**
 * Shared header component for all Kortix Computer views (Files, File Viewer, Browser).
 * Ensures consistent styling and prevents layout jumps when switching tabs.
 * 
 * ALL styling is controlled here - consumers only pass data props.
 */
export function KortixComputerHeader({
  icon: Icon,
  onIconClick,
  iconTitle,
  title,
  fileName,
  breadcrumbs,
  onBreadcrumbClick,
  actions,
}: KortixComputerHeaderProps) {
  return (
    <div className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 flex items-center justify-between flex-shrink-0 max-w-full min-w-0">
      {/* Left section: Icon + Title/Breadcrumbs/FileName */}
      <div className="flex items-center gap-3 overflow-x-auto min-w-0 scrollbar-hide max-w-full">
        {/* Icon Button - ALWAYS same styling */}
        {onIconClick ? (
          <button
            onClick={onIconClick}
            className="relative p-2 rounded-lg border flex-shrink-0 bg-zinc-200/60 dark:bg-zinc-900 border-zinc-300 dark:border-zinc-700 hover:bg-zinc-300/60 dark:hover:bg-zinc-800 transition-colors"
            title={iconTitle}
          >
            <Icon className="h-5 w-5 text-zinc-600 dark:text-zinc-400" />
          </button>
        ) : (
          <div className="relative p-2 rounded-lg border flex-shrink-0 bg-zinc-200/60 dark:bg-zinc-900 border-zinc-300 dark:border-zinc-700">
            <Icon className="h-5 w-5 text-zinc-600 dark:text-zinc-400" />
          </div>
        )}

        {/* Simple Title */}
        {title && (
          <span className="text-base font-medium text-zinc-900 dark:text-zinc-100">
            {title}
          </span>
        )}

        {/* File Name with Chevron (for file viewer) */}
        {fileName && (
          <>
            <ChevronRight className="h-3 w-3 text-muted-foreground/50 flex-shrink-0" />
            <span className="text-base font-medium text-zinc-900 dark:text-zinc-100 truncate max-w-[200px]">
              {fileName}
            </span>
          </>
        )}

        {/* Breadcrumbs */}
        {breadcrumbs && breadcrumbs.length > 0 && (
          <div className="flex items-center gap-1.5 min-w-0">
            {breadcrumbs.map((segment, index) => (
              <Fragment key={segment.path}>
                {index > 0 && (
                  <span className="text-zinc-400 dark:text-zinc-600">/</span>
                )}
                <button
                  onClick={() => onBreadcrumbClick?.(segment.path)}
                  className={cn(
                    "text-base transition-colors truncate max-w-[150px]",
                    segment.isLast 
                      ? "text-zinc-900 dark:text-zinc-100 font-medium" 
                      : "text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100"
                  )}
                >
                  {segment.name}
                </button>
              </Fragment>
            ))}
          </div>
        )}
      </div>

      {/* Right section: Actions */}
      <div className="flex items-center gap-1.5 flex-shrink-0 ml-2">
        {actions}
      </div>
    </div>
  );
}
