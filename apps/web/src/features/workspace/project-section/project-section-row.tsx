'use client';

/**
 * One row in a project section list.
 *
 * Four screens hand-rolled their own row (members, changes, sandbox,
 * schedules) and drifted apart. This is the shared shape: a tinted leading
 * tile, a title with optional badges, one line of supporting text, and
 * trailing controls.
 *
 * Composes components/ui/item.tsx. Note that components/ui/list.tsx is banned
 * by the design system — do not reach for it here.
 */

import type { ReactNode } from 'react';

import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { cn } from '@/lib/utils';

export interface ProjectSectionRowProps {
  /** Icon or avatar. Rendered in a size-9 tinted tile. */
  leading?: ReactNode;
  title: ReactNode;
  /** Badges rendered inline after the title. */
  badges?: ReactNode;
  /** ONE line. Truncates rather than wrapping — the row stays a row. */
  subtitle?: ReactNode;
  /** Controls on the right: a switch, a menu, a button. */
  trailing?: ReactNode;
  onClick?: () => void;
  /** Muted styling for a paused or disabled entity. */
  dimmed?: boolean;
  className?: string;
}

export function ProjectSectionRow({
  leading,
  title,
  badges,
  subtitle,
  trailing,
  onClick,
  dimmed,
  className,
}: ProjectSectionRowProps) {
  const interactive = Boolean(onClick);

  return (
    <Item
      variant="outline"
      size="sm"
      // A row that opens something is a button; a static row is not. Without
      // this, keyboard users cannot reach half the lists in the product.
      {...(interactive
        ? {
            asChild: false,
            role: 'button',
            tabIndex: 0,
            onClick,
            onKeyDown: (event: React.KeyboardEvent) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onClick?.();
              }
            },
          }
        : {})}
      className={cn(
        interactive && 'hover:bg-accent/50 cursor-pointer transition-colors',
        dimmed && 'opacity-60',
        className,
      )}
    >
      {leading ? (
        <ItemMedia variant="icon" className="size-9">
          {leading}
        </ItemMedia>
      ) : null}

      <ItemContent className="min-w-0">
        <ItemTitle className="flex min-w-0 items-center gap-2">
          <span className="truncate">{title}</span>
          {badges}
        </ItemTitle>
        {subtitle ? <ItemDescription className="truncate">{subtitle}</ItemDescription> : null}
      </ItemContent>

      {trailing ? (
        // Stop a switch or menu click from also triggering the row.
        <ItemActions
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {trailing}
        </ItemActions>
      ) : null}
    </Item>
  );
}

/** Vertical list wrapper. `<ul>` + spacing, per the design system's entity-row pattern. */
export function ProjectSectionList({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn('space-y-2', className)}>{children}</div>;
}

export default ProjectSectionRow;
