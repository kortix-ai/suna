'use client';

import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface DocsBreadcrumbItem {
  title: string;
  href?: string;
  onClick?: () => void;
}

export interface DocsHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  title: string;
  subtitle?: string;
  description?: string;
  breadcrumbs?: DocsBreadcrumbItem[];
  badge?: string;
  badgeVariant?: 'default' | 'secondary' | 'destructive' | 'outline';
  lastUpdated?: string;
  author?: string;
  readTime?: string;
  showSeparator?: boolean;
  size?: 'sm' | 'default' | 'lg';
}

export const DocsHeader = React.forwardRef<HTMLDivElement, DocsHeaderProps>(
  ({
    title,
    subtitle,
    description,
    breadcrumbs,
    badge,
    badgeVariant = 'secondary',
    lastUpdated,
    author,
    readTime,
    showSeparator = false,
    size = 'default',
    className,
    ...props
  }, ref) => {
    const titleSizes = {
      sm: 'text-2xl',
      default: 'text-3xl',
      lg: 'text-4xl lg:text-5xl'
    };

    const subtitleSizes = {
      sm: 'text-sm',
      default: 'text-base',
      lg: 'text-base'
    };

    const descriptionSizes = {
      sm: 'text-sm',
      default: 'text-base',
      lg: 'text-base'
    };

    return (
      <div ref={ref} className={cn("space-y-4", className)} {...props}>
        {breadcrumbs && breadcrumbs.length > 0 && (
          <nav className="flex items-center space-x-1 text-sm text-muted-foreground overflow-x-auto">
            {breadcrumbs.map((crumb, index) => (
              <React.Fragment key={index}>
                {crumb.href || crumb.onClick ? (
                  <button
                    onClick={crumb.onClick}
                    className="hover:text-foreground transition-colors whitespace-nowrap"
                  >
                    {crumb.title}
                  </button>
                ) : (
                  <span className={`whitespace-nowrap ${index === breadcrumbs.length - 1 ? 'text-foreground' : ''}`}>
                    {crumb.title}
                  </span>
                )}
                {index < breadcrumbs.length - 1 && (
                  <ChevronRight className="h-4 w-4 flex-shrink-0" />
                )}
              </React.Fragment>
            ))}
          </nav>
        )}

        <div className="space-y-3">
          <div className="space-y-2">
            {badge && (
              <Badge variant={badgeVariant}>
                {badge}
              </Badge>
            )}
            <h1 className={cn(
              "font-bold tracking-tight",
              titleSizes[size]
            )}>
              {title}
            </h1>
            {subtitle && (
              <p className={cn(
                "text-muted-foreground",
                subtitleSizes[size]
              )}>
                {subtitle}
              </p>
            )}
          </div>

          {description && (
            <p className={cn(
              "text-muted-foreground leading-relaxed max-w-3xl",
              descriptionSizes[size]
            )}>
              {description}
            </p>
          )}

          {(lastUpdated || author || readTime) && (
            <div className="flex items-center gap-4 text-sm text-muted-foreground/60">
              {lastUpdated && (
                <span>Last updated: {lastUpdated}</span>
              )}
              {author && (
                <span>By {author}</span>
              )}
              {readTime && (
                <span>{readTime}</span>
              )}
            </div>
          )}
        </div>

        {showSeparator && (
          <Separator className="mt-6" />
        )}
      </div>
    );
  }
);

DocsHeader.displayName = 'DocsHeader'; 