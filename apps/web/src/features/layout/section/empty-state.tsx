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

import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { cn } from '@/lib/utils';
import { Icon as IconMynauiType } from '@mynaui/icons-react';
import { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { IconType } from 'react-icons/lib';

export interface EmptyStateProps {
  icon?: LucideIcon | IconMynauiType | IconType;
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
    <Empty className={cn('', className)}>
      <EmptyHeader className={maxW}>
        {IconComponent && (
          <EmptyMedia className="mb-4">
            <IconComponent
              className={cn(iconSize, 'text-muted-foreground/20')}
              strokeWidth={1.25}
            />
          </EmptyMedia>
        )}
        <EmptyTitle className="text-foreground text-sm font-semibold tracking-tight">
          {title}
        </EmptyTitle>
        {description && (
          <EmptyDescription className="text-muted-foreground/80 mt-1.5">
            {description}
          </EmptyDescription>
        )}
      </EmptyHeader>
      {(action || secondaryAction) && (
        <EmptyContent className="flex-row justify-center gap-2">
          {action}
          {secondaryAction}
        </EmptyContent>
      )}
    </Empty>
  );
}
