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
import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

import type { HubTarget } from '@/stores/account-panel-store';

import { HubLink } from './account-hub-location';
import type { AccountPaneWidth } from './sections';

const WIDTH_CLASS: Record<AccountPaneWidth, string> = {
  default: 'max-w-2xl',
  wide: 'max-w-3xl',
  full: 'max-w-6xl',
  fluid: 'max-w-none',
};

export interface AccountPaneProps {
  /** The one way out of this pane — rendered below `md` only, where the
   *  sidebar is a sheet. Omit on the pane that IS the way out. */
  back?: { to: HubTarget; label: string };
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
            <HubLink to={back.to}>
              <ArrowLeftIcon className="size-3.5 shrink-0" />
              {back.label}
            </HubLink>
          </Button>
        </div>
      ) : null}
      <div
        className={cn(
          'px-4 pb-12',
          // Fluid panes run edge to edge with Linear's gutter (~34px).
          width === 'fluid' ? 'sm:px-9' : 'sm:px-12',
          back ? 'md:pt-12' : 'pt-12',
        )}
      >
        {/* A fluid pane is a working table: its toolbar sits close under the title. */}
        <div
          className={cn(
            'mx-auto w-full',
            width === 'fluid' ? 'space-y-5' : 'space-y-10',
            WIDTH_CLASS[width],
          )}
        >
          {title ? (
            <header className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0 space-y-1">
                <h1 className="text-foreground text-2xl font-medium tracking-tight text-balance">{title}</h1>
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
 * The pane's loading shape, drawn like the Settings pane the hub opens on:
 * the title block (when the route does not know its title yet), then
 * sections of a muted label over a bordered card whose rows hold a title and
 * a description on the left and a control on the right. Same borders and
 * gaps as the loaded cards, so the hand-over paints in place.
 */
export function AccountPaneSkeleton({ withTitle = false }: { withTitle?: boolean }) {
  return (
    <div className="space-y-10" aria-hidden>
      {withTitle ? (
        <div className="space-y-2">
          <Skeleton className="h-7 w-40 rounded-md" />
          <Skeleton className="h-4 w-64 rounded-md" />
        </div>
      ) : null}
      {SKELETON_SECTIONS.map((rows, s) => (
        <section key={s} className="space-y-3">
          <div className="space-y-1.5">
            <Skeleton className="h-3.5 w-20 rounded-sm" />
            {s > 0 ? <Skeleton className="h-3 w-56 rounded-sm" /> : null}
          </div>
          <div className="divide-y rounded-lg border">
            {rows.map((row, i) => (
              <div key={i} className="flex items-center gap-4 px-4 py-4">
                <div className="min-w-0 flex-1 space-y-2">
                  <Skeleton className={cn('h-3.5 rounded-sm', row.titleWidth)} />
                  <Skeleton className={cn('h-3 rounded-sm', row.bodyWidth)} />
                </div>
                <Skeleton className={cn('shrink-0 rounded-md', row.control)} />
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/** Two sections like General and Security: a field row, then toggle and
 *  input rows, with title widths that vary like real copy. */
const SKELETON_SECTIONS: Array<Array<{ titleWidth: string; bodyWidth: string; control: string }>> = [
  [
    { titleWidth: 'w-28', bodyWidth: 'w-72', control: 'h-8 w-16' },
    { titleWidth: 'w-32', bodyWidth: 'w-24', control: 'h-8 w-14' },
  ],
  [
    { titleWidth: 'w-52', bodyWidth: 'w-80', control: 'h-5 w-9 rounded-full' },
    { titleWidth: 'w-44', bodyWidth: 'w-64', control: 'h-8 w-24' },
    { titleWidth: 'w-28', bodyWidth: 'w-72', control: 'h-8 w-24' },
    { titleWidth: 'w-48', bodyWidth: 'w-80', control: 'h-5 w-9 rounded-full' },
  ],
];
