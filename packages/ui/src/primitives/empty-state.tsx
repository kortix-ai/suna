'use client';

/**
 * Kortix <EmptyState> — centered empty view.
 *
 * Minimal. The fanned-card artwork (`EmptyArt`, with `icon` on its front card,
 * or a blank document without one), a one-line headline, an optional body,
 * and up to two actions (primary + secondary). Every empty view draws the
 * same picture, title and body; only the glyph and the words change.
 *
 *   <EmptyState
 *     icon={IconInbox}
 *     title="No issues yet"
 *     description="Create your first issue with C, or press N in any tab."
 *     action={<Button>New issue</Button>}
 *   />
 */

import { EmptyArt } from './empty-art';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from './empty';
import { cn } from '../lib/utils';
import {
  type Icon as IconMynauiType,
  type Icon as IconType,
  type Icon as LucideIcon,
} from '@phosphor-icons/react';
import type { ReactNode } from 'react';

export interface EmptyStateProps {
  icon?: LucideIcon | IconMynauiType | IconType;
  /** Custom artwork in place of `EmptyArt`. */
  media?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  secondaryAction?: ReactNode;
  className?: string;
  size?: 'sm' | 'default';
}

export function EmptyState({
  icon: IconComponent,
  media,
  title,
  description,
  action,
  secondaryAction,
  size = 'default',
  className,
}: EmptyStateProps) {
  const maxW = size === 'sm' ? 'max-w-[240px]' : 'max-w-[320px]';

  return (
    <Empty className={cn('', className)}>
      <EmptyHeader className={maxW}>
        <EmptyMedia className="mb-5">{media ?? <EmptyArt icon={IconComponent} />}</EmptyMedia>
        <EmptyTitle className="text-foreground text-sm font-semibold tracking-tight">
          {title}
        </EmptyTitle>
        {description && (
          <EmptyDescription className="text-muted-foreground mt-1.5">
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
