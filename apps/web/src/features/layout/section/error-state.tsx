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
import { DangerTriangleSolid, Icon as IconMynauiType } from '@mynaui/icons-react';
import { LucideIcon } from 'lucide-react';
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
  icon: IconComponent = DangerTriangleSolid,
  title,
  description,
  action,
  secondaryAction,
  size = 'default',
  className,
}: ErrorStateProps) {
  const maxW = size === 'sm' ? 'max-w-[240px]' : 'max-w-[320px]';

  return (
    <Empty className={cn('border-none', className)}>
      <EmptyHeader className={maxW}>
        <EmptyMedia className="mb-4">
          <div
            className={cn(
              'inline-flex size-10 shrink-0 items-center justify-center rounded-sm border',
              'bg-kortix-red/10 text-kortix-red',
            )}
          >
            <IconComponent className="size-6 shrink-0" />
          </div>
        </EmptyMedia>
        <EmptyTitle className="text-base font-semibold">{title}</EmptyTitle>
        {description && <EmptyDescription className="mt-1.5">{description}</EmptyDescription>}
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
