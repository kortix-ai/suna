'use client';

import { ArrowClockwiseIcon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { cn } from '@/lib/utils';

/**
 * The content column for one /admin page.
 *
 * The shell (`admin-shell.tsx`) owns the frame — the aside, the `main` scroll
 * container, its `Admin / <page>` breadcrumb, and the outer gutters that mirror
 * the settings inset. This component only lays out the page's OWN header and
 * body inside that column: a centred `space-y-5` block, the settings inset's
 * `px-4 py-10 sm:px-12 sm:py-12` rhythm, and the header grammar
 * `CapabilityPageShell` uses (title left, description under it, search + action
 * as one right-hand group, then an optional filters row).
 *
 * ## Width
 *
 * `default` is `max-w-5xl`, the capability shell's own value. `wide`
 * (`max-w-7xl`) is for the three routes whose primary content is a six-column
 * operator table — Accounts, Projects, Sandboxes — where `max-w-5xl` forces
 * account emails and session ids to wrap. It changes the container width and
 * nothing else, so the two widths still read as one system.
 */
export function AdminPageShell({
  title,
  description,
  action,
  search,
  filters,
  width = 'default',
  children,
}: {
  title: string;
  description?: ReactNode;
  /** Page-level action(s). Rendered after `search` in the header's right group.
   *  Pass several by wrapping them in one element. */
  action?: ReactNode;
  search?: ReactNode;
  /** A row between the header and the body — tabs, chips, a range picker. */
  filters?: ReactNode;
  width?: 'default' | 'wide';
  children: ReactNode;
}) {
  return (
    // THE scroll container for every admin page. `main` in `admin-shell.tsx` is
    // `overflow-hidden` and its breadcrumb header is `shrink-0`, so this element
    // — a `flex-1 min-h-0` child of that flex column — is what actually scrolls.
    // Without `min-h-0` a flex child refuses to shrink below its content and the
    // overflow never engages, which is why every page read as unscrollable.
    <div className="min-h-0 w-full flex-1 overflow-y-auto px-4 py-10 sm:px-12 sm:py-12">
      <div
        className={cn(
          'mx-auto w-full space-y-5',
          width === 'wide' ? 'max-w-7xl' : 'max-w-5xl',
        )}
      >
        <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-1">
            <h1 className="text-foreground text-xl font-medium text-balance">{title}</h1>
            {description ? (
              <p className="text-muted-foreground text-sm text-balance">{description}</p>
            ) : null}
          </div>
          {search || action ? (
            <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto">
              {search ? <div className="min-w-0 flex-1 sm:w-64 sm:flex-none">{search}</div> : null}
              {action}
            </div>
          ) : null}
        </header>
        {filters ? (
          <div className="flex flex-wrap items-center justify-between gap-2">{filters}</div>
        ) : null}
        {children}
      </div>
    </div>
  );
}

/**
 * The header's refresh control, shared by every console that polls.
 *
 * `Loading` replaces the icon while a refetch is in flight — it does NOT spin
 * the arrow. `Loading` is the codebase's only spinner; `animate-spin` on a
 * Phosphor glyph is a rejected default, and all three admin consoles carried
 * one.
 */
export function AdminRefreshButton({
  busy,
  onRefresh,
  label = 'Refresh',
}: {
  busy: boolean;
  onRefresh: () => void;
  label?: string;
}) {
  return (
    // `size="default"` (h-9), not `sm` (h-8): this button shares a row with the
    // h-9 search field and the h-9 select, and a shorter button in that row
    // reads as misaligned.
    <Button variant="outline" onClick={onRefresh} disabled={busy} className="gap-1.5">
      {busy ? (
        <Loading className="size-4 shrink-0" />
      ) : (
        <ArrowClockwiseIcon className="size-4 shrink-0" />
      )}
      {label}
    </Button>
  );
}
