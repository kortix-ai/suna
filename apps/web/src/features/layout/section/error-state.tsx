'use client';

/**
 * Kortix <ErrorState> — centered error view.
 *
 * Minimal. An icon, a one-line headline, an optional body, and up to two
 * actions (primary + secondary). A calm failure moment — not an alarm bell.
 *
 *   <ErrorState
 *     title="Failed to load"
 *     description={error.message}
 *     action={<Button variant="outline" size="sm" onClick={refetch}>Retry</Button>}
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
import { AlertCircle, LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { IconType } from 'react-icons/lib';

export interface ErrorStateProps {
  icon?: LucideIcon | IconMynauiType | IconType;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  secondaryAction?: ReactNode;
  className?: string;
  size?: 'sm' | 'default';
}

export function ErrorState({
  icon: IconComponent = AlertCircle,
  title,
  description,
  action,
  secondaryAction,
  size = 'default',
  className,
}: ErrorStateProps) {
  const mediaSize = size === 'sm' ? 'size-8' : 'size-10';
  const iconSize = size === 'sm' ? 'size-4' : 'size-5';
  const maxW = size === 'sm' ? 'max-w-[240px]' : 'max-w-[320px]';

  return (
    <Empty className={cn('border-none px-6 py-12', className)}>
      <EmptyHeader className={maxW}>
        <EmptyMedia
          className={cn(
            'mb-4 flex items-center justify-center rounded-2xl bg-destructive/10',
            mediaSize,
          )}
        >
          <IconComponent className={cn(iconSize, 'text-destructive/60')} strokeWidth={1.75} />
        </EmptyMedia>
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
