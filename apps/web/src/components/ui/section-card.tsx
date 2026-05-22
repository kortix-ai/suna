'use client';

import * as React from 'react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/**
 * Kortix <SectionCard> — the one panel pattern.
 *
 * Composes the design-system <Card> (rounded-2xl surface) and adds the
 * divided header every settings/list panel needs: a title, an optional
 * muted count, a description, and a trailing action. Use `flush` to let a
 * <List> sit edge-to-edge; otherwise the body gets standard padding.
 * `tone="destructive"` is the standard danger-zone — no separate component.
 *
 *   <SectionCard title="Members" count={3} description="People with access"
 *     action={<Button size="sm">Invite</Button>} flush>
 *     <List>…</List>
 *   </SectionCard>
 *
 *   <SectionCard tone="destructive" title="Danger zone"
 *     description="Irreversible actions.">
 *     …
 *   </SectionCard>
 */

export interface SectionCardProps {
  title?: React.ReactNode;
  /** Muted "(n)" rendered next to the title. */
  count?: number;
  description?: React.ReactNode;
  /** Trailing header slot — usually a button. */
  action?: React.ReactNode;
  tone?: 'default' | 'destructive';
  /** Render children edge-to-edge (for <List>) instead of a padded body. */
  flush?: boolean;
  className?: string;
  bodyClassName?: string;
  children?: React.ReactNode;
}

export function SectionCard({
  title,
  count,
  description,
  action,
  tone = 'default',
  flush = false,
  className,
  bodyClassName,
  children,
}: SectionCardProps) {
  const destructive = tone === 'destructive';
  const hasHeader = title != null || description != null || action != null;

  // Danger zones stay calm: red is the brake, not the paint. The panel is a
  // neutral surface with only a faint warm hairline to mark it — the title and
  // description read normally, and the single red action lives on the final
  // confirm (a ConfirmDialog/AlertDialog), never on the panel itself.
  return (
    <Card
      className={cn(
        'gap-0 overflow-hidden py-0',
        destructive && 'border-destructive/25',
        className,
      )}
    >
      {hasHeader && (
        <div className="flex items-start justify-between gap-3 border-b border-border/60 px-6 py-4">
          <div className="min-w-0">
            {title != null && (
              <h2 className="text-base font-semibold text-foreground">
                {title}
                {count != null && (
                  <span className="font-normal text-muted-foreground"> ({count})</span>
                )}
              </h2>
            )}
            {description != null && (
              <p className="mt-0.5 text-xs text-muted-foreground">
                {description}
              </p>
            )}
          </div>
          {action != null && <div className="shrink-0">{action}</div>}
        </div>
      )}
      {flush ? children : <div className={cn('px-6 py-5', bodyClassName)}>{children}</div>}
    </Card>
  );
}
