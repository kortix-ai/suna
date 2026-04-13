'use client';

/**
 * Kortix <EmptyState> — centered empty view.
 *
 * Minimal. An icon, a one-line headline, an optional body, and up to two
 * actions (primary + secondary). A calm teaching moment rather than a
 * brick wall.
 *
 *   <EmptyState
 *     icon={IconInbox}
 *     title="No issues yet"
 *     description="Create your first issue with C, or press N in any tab."
 *     action={<Button>New issue</Button>}
 *   />
 */

import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';
import type { Icon } from '@/components/ui/kortix-icons';

export interface EmptyStateProps {
  icon?: Icon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  secondaryAction?: ReactNode;
  className?: string;
  size?: 'sm' | 'default';
}

export function EmptyState({
  icon: IconComponent,
  title,
  description,
  action,
  secondaryAction,
  size = 'default',
  className,
}: EmptyStateProps) {
  const iconSize = size === 'sm' ? 'h-8 w-8' : 'h-10 w-10';
  const maxW = size === 'sm' ? 'max-w-[240px]' : 'max-w-[320px]';

  return (
    <div className={cn('flex flex-1 items-center justify-center px-6 py-12', className)}>
      <div className={cn('text-center', maxW)}>
        {IconComponent && (
          <div className="flex justify-center mb-4">
            <IconComponent className={cn(iconSize, 'text-muted-foreground/20')} strokeWidth={1.25} />
          </div>
        )}
        <h3 className="text-[15px] font-semibold text-foreground tracking-tight">
          {title}
        </h3>
        {description && (
          <p className="mt-1.5 text-[13px] text-muted-foreground/80 leading-relaxed">
            {description}
          </p>
        )}
        {(action || secondaryAction) && (
          <div className="mt-5 flex items-center justify-center gap-2">
            {action}
            {secondaryAction}
          </div>
        )}
      </div>
    </div>
  );
}
