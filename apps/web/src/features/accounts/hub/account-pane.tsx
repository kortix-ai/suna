'use client';

/**
 * The content column of every `/accounts/**` route — what sits to the right
 * of the settings sidebar, under the breadcrumb bar.
 *
 * A centred column (`max-w-2xl` by default) whose first block is the page
 * title and its one-line description, followed by the section's own panels.
 * The column is the same on every route so switching sections never moves
 * the title.
 *
 * Below `md` the sidebar is a sheet, so the pane also carries a 48px row with
 * the one "back" link; on desktop the sidebar answers that question and the
 * row is not rendered — the column takes the same 48px as top padding instead,
 * so the title sits at one height on every viewport.
 */

import { ArrowLeftIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

import type { AccountPaneWidth } from './sections';

const WIDTH_CLASS: Record<AccountPaneWidth, string> = {
  default: 'max-w-2xl',
  wide: 'max-w-3xl',
  full: 'max-w-6xl',
};

export interface AccountPaneProps {
  /** The one way out of this pane — rendered below `md` only. Omit on the routes that ARE the way out. */
  back?: { href: string; label: string };
  title?: ReactNode;
  description?: ReactNode;
  /** One control, right of the title. */
  action?: ReactNode;
  width?: AccountPaneWidth;
  className?: string;
  children?: ReactNode;
}

export function AccountPane({
  back,
  title,
  description,
  action,
  width = 'default',
  className,
  children,
}: AccountPaneProps) {
  return (
    <div className={cn('flex w-full flex-col', className)}>
      {back ? (
        <div className="flex h-12 shrink-0 items-center px-4 md:hidden">
          <Button
            asChild
            variant="ghost"
            size="xs"
            className="text-muted-foreground hover:text-foreground -ml-2 gap-1 text-xs"
          >
            <Link href={back.href}>
              <ArrowLeftIcon className="size-3.5 shrink-0" />
              {back.label}
            </Link>
          </Button>
        </div>
      ) : null}
      <div className={cn('px-4 pb-12 sm:px-12', back ? 'md:pt-12' : 'pt-12')}>
        <div className={cn('mx-auto w-full space-y-10', WIDTH_CLASS[width])}>
          {title ? (
            <header className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0 space-y-1">
                <h1 className="text-foreground text-xl font-medium text-balance">{title}</h1>
                {description ? (
                  <p className="text-muted-foreground text-sm text-pretty">{description}</p>
                ) : null}
              </div>
              {action ? <div className="shrink-0">{action}</div> : null}
            </header>
          ) : null}
          {children}
        </div>
      </div>
    </div>
  );
}

/**
 * The pane's loading shape: the title block (when the route does not know its
 * title yet) and four panel-height rows. Used by the route `loading.tsx`
 * boundaries and by the hub while its account query is in flight, so the
 * hand-over paints in place.
 */
export function AccountPaneSkeleton({ withTitle = false }: { withTitle?: boolean }) {
  return (
    <div className="space-y-10">
      {withTitle ? (
        <div className="space-y-2">
          <Skeleton className="h-7 w-40 rounded-md" />
          <Skeleton className="h-4 w-64 rounded-md" />
        </div>
      ) : null}
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full rounded-md" />
        ))}
      </div>
    </div>
  );
}
