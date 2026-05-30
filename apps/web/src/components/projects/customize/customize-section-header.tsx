'use client';

/**
 * CustomizeSectionHeader — the one header bar every Customize section uses.
 *
 * A slim `h-12` row: leading icon + title, an optional count badge, and an
 * optional actions slot (e.g. a "New" button) pinned right. Keeping it in one
 * place is what makes Agents, Connectors, Secrets, Members, … read as the same
 * product instead of eleven slightly-different pages.
 */

import type { LucideIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export function CustomizeSectionHeader({
  icon: Icon,
  title,
  count,
  actions,
  className,
}: {
  icon: LucideIcon;
  title: string;
  /** Optional count badge — hidden when null/undefined or 0. */
  count?: number | null;
  /** Right-aligned actions (buttons, etc.). */
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex h-12 shrink-0 items-center gap-2 border-b border-border/60 px-4',
        className,
      )}
    >
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
      <h1 className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
        {title}
      </h1>
      {typeof count === 'number' && count > 0 && (
        <Badge variant="secondary" size="sm" className="tabular-nums">
          {count}
        </Badge>
      )}
      {actions}
    </div>
  );
}
