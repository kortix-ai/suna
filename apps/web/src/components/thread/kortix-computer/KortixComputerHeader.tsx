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
    <div className="h-10 bg-background border-b border-border/50 px-3 flex items-center justify-between flex-shrink-0 max-w-full min-w-0">
      {/* Left: Icon + Title/Breadcrumbs/FileName */}
      <div className="flex items-center gap-2 overflow-x-auto min-w-0 scrollbar-hide max-w-full">
        {onIconClick ? (
          <button
            onClick={onIconClick}
            className="flex-shrink-0 p-1 rounded-md text-muted-foreground/80 hover:text-foreground hover:bg-foreground/[0.04] transition-colors cursor-pointer touch-manipulation"
            title={iconTitle}
          >
            <Icon className="w-3.5 h-3.5" />
          </button>
        ) : (
          <Icon className="w-3.5 h-3.5 text-muted-foreground/80 flex-shrink-0" />
        )}

        {title && (
          <span className="text-sm font-medium text-foreground tracking-tight">
            {title}
          </span>
        )}

        {fileName && (
          <>
            <ChevronRight className="h-3 w-3 text-muted-foreground/40 flex-shrink-0" />
            <span className="text-sm font-medium text-foreground tracking-tight truncate max-w-[140px] sm:max-w-[200px]">
              {fileName}
            </span>
          </>
        )}

        {breadcrumbs && breadcrumbs.length > 0 && (
          <div className="flex items-center gap-1 min-w-0">
            {breadcrumbs.map((segment, index) => (
              <Fragment key={segment.path}>
                {index > 0 && (
                  <span className="text-muted-foreground/40">/</span>
                )}
                <button
                  onClick={() => onBreadcrumbClick?.(segment.path)}
                  className={cn(
                    "text-sm tracking-tight transition-colors truncate max-w-[100px] sm:max-w-[150px] touch-manipulation cursor-pointer",
                    segment.isLast
                      ? "text-foreground font-medium"
                      : "text-muted-foreground/70 hover:text-foreground"
                  )}
                >
                  {segment.name}
                </button>
              </Fragment>
            ))}
          </div>
        )}
      </div>

      {/* Right: Actions */}
      <div className="flex items-center gap-1 flex-shrink-0 ml-2">
        {actions}
      </div>
    </div>
  );
}
