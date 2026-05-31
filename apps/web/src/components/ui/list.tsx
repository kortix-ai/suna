'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Kortix <List> / <ListRow> — the one standard list.
 *
 * A flush, divider-separated list of rows. Drop it inside a <SectionCard
 * flush> for the canonical "panel with a list" layout. Each row has a
 * leading slot (pass <UserAvatar> for people, <EntityAvatar> for things),
 * a title with optional inline badges, an optional subtitle (an
 * <InlineMeta> strip reads well here) and a trailing slot for status
 * badges + a kebab menu.
 *
 *   <SectionCard title="Members" count={3} flush>
 *     <List>
 *       <ListRow
 *         leading={<UserAvatar email={m.email} />}
 *         title={m.email}
 *         badges={isSelf && <Badge size="sm" variant="outline">You</Badge>}
 *         subtitle={<InlineMeta><span>Joined 2d ago</span></InlineMeta>}
 *         trailing={<RoleBadge role={m.role} />}
 *       />
 *     </List>
 *   </SectionCard>
 *
 * A clickable row is a keyboard-accessible <div role="button">, so it can
 * still hold a trailing kebab or action button (wrap those in a stopPropagation
 * handler so they don't trigger the row's onClick).
 */

export function List({ className, ...props }: React.ComponentProps<'ul'>) {
  return (
    <ul
      data-slot="list"
      className={cn('divide-y divide-border/60', className)}
      {...props}
    />
  );
}

export interface ListRowProps {
  leading?: React.ReactNode;
  title: React.ReactNode;
  /** Small badges shown inline, right after the title. */
  badges?: React.ReactNode;
  /** Secondary line — an <InlineMeta> strip or plain text. */
  subtitle?: React.ReactNode;
  /** Trailing slot — status badges and/or a kebab menu. */
  trailing?: React.ReactNode;
  onClick?: () => void;
  className?: string;
}

export function ListRow({
  leading,
  title,
  badges,
  subtitle,
  trailing,
  onClick,
  className,
}: ListRowProps) {
  const interactive = !!onClick;

  return (
    <li>
      <div
        {...(interactive
          ? {
              role: 'button',
              tabIndex: 0,
              onClick,
              onKeyDown: (e: React.KeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onClick?.();
                }
              },
            }
          : {})}
        className={cn(
          'group flex items-center gap-3 px-6 py-3',
          interactive &&
            'cursor-pointer transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none',
          className,
        )}
      >
        {leading ? <div className="shrink-0">{leading}</div> : null}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">
              {title}
            </span>
            {badges}
          </div>
          {subtitle ? <div className="mt-0.5">{subtitle}</div> : null}
        </div>
        {trailing ? (
          <div className="flex shrink-0 items-center gap-1.5">{trailing}</div>
        ) : null}
      </div>
    </li>
  );
}
