'use client';

import { ArrowLeftIcon, ArrowSquareOutIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from '@/components/ui/item';
import { cn } from '@/lib/utils';


export interface ConnectorDocumentationLink {
  label: string;
  href: string;
  external?: boolean;
}

export function ConnectorDetailLayout({
  backHref,
  icon,
  title,
  description,
  status,
  headerAction,
  primaryTitle,
  primaryDescription,
  primaryAction,
  children,
  className,
}: {
  /** `null` hides the back row — the split view's right pane closes via its
   *  column, so a Go back inside it is a second, redundant exit. */
  backHref: string | null;
  icon: ReactNode;
  title: ReactNode;
  description?: string | null;
  status?: ReactNode;
  /** Rendered at the right end of the icon+title row — the page-level verb
   *  (start a session with this connector). */
  headerAction?: ReactNode;
  primaryTitle: string;
  primaryDescription: string;
  primaryAction?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <main
        className={cn('mx-auto w-full max-w-3xl space-y-6 px-4 py-8 pb-20 lg:py-12', className)}
      >
        {backHref ? (
          <div className="flex justify-start">
            {/* `-ml-2.5` cancels the button's own padding so the label sits
                flush with the column's left edge. */}
            <Button
              asChild
              size="xs"
              variant="ghost"
              className="text-muted-foreground hover:text-foreground -ml-2.5 w-fit gap-1.5"
            >
              <Link href={backHref}>
                <ArrowLeftIcon className="size-3.5 shrink-0" />
                Go back
              </Link>
            </Button>
          </div>
        ) : null}

        {/* Icon and title share ONE centered row — top-aligning a 40/56px
            tile against a 32px title line left them visually adrift. The
            description gets its own full-width line below, flush with the
            icon's left edge, like the reference connection pages. */}
        <header className="min-w-0 space-y-1.5">
          <div className="flex min-w-0 items-center gap-3">
            {icon}
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
              <span className="text-foreground text-2xl font-semibold tracking-tight text-balance">
                {title}
              </span>
              {status}
            </div>
            {headerAction ? <div className="ml-auto shrink-0 self-start">{headerAction}</div> : null}
          </div>
          {description ? (
            // Clamped: catalogue descriptions are third-party prose and some
            // run to a paragraph — the header is an identity line, not a
            // reading assignment.
            <p className="text-muted-foreground line-clamp-3 max-w-[64ch] text-base text-pretty sm:text-sm">
              {description}
            </p>
          ) : null}
        </header>

        <Item variant="outline" size="sm" className="bg-popover">
          <ItemContent>
            <ItemTitle className="text-base sm:text-sm">{primaryTitle}</ItemTitle>
            <ItemDescription className="max-w-[64ch] text-base sm:text-sm">
              {primaryDescription}
            </ItemDescription>
          </ItemContent>
          {primaryAction ? (
            // `basis-full` on phones: the wrap-enabled Item drops the action
            // to its own full-width row instead of squeezing beside the text.
            <ItemActions className="max-sm:basis-full max-sm:*:w-full">{primaryAction}</ItemActions>
          ) : null}
        </Item>

        {children}
      </main>
    </div>
  );
}

/**
 * The loading state, shape-matched to the loaded page: quiet bars where the
 * header, the Connection panel, and a short list will land. No controls and
 * no placeholder sentences — a Go back button on gray bars reads as content
 * that then jumps, which is worse than waiting.
 */
export function ConnectorDetailSkeleton({
  iconClassName = 'size-10',
}: {
  /** Matches the loaded header's icon tile — `size-14` on the connected page. */
  iconClassName?: string;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" aria-busy>
      <main className="mx-auto w-full max-w-3xl space-y-6 px-4 py-8 pb-20 lg:py-12">

        <header className="min-w-0 space-y-2">
          <div className="flex items-center gap-3">
            <Skeleton className={cn('shrink-0 rounded-md', iconClassName)} />
            <Skeleton className="h-6 w-44 max-w-full rounded-sm" />
          </div>
          <Skeleton className="h-4 w-72 max-w-full rounded-sm" />
        </header>

        {/* The Connection Item. */}
        <Skeleton className="h-16 rounded-md" />

        {/* A section label and a short list — the shape every state of the
            page settles into (stepper, matches, or accounts). */}
        <div className="space-y-2">
          <Skeleton className="h-4 w-28 rounded-sm" />
          <Skeleton className="h-11 rounded-md" />
          <Skeleton className="h-11 rounded-md" />
          <Skeleton className="h-11 rounded-md" />
        </div>
      </main>
    </div>
  );
}

/**
 * Reference links. Rendered at the BOTTOM of the detail pages — docs are
 * where you go when a step needs them, never the thing between the user and
 * Connect. Outline buttons by request: the text-link variant read worse.
 */
export function ConnectorDocumentationLinks({
  links,
}: {
  links: readonly ConnectorDocumentationLink[];
}) {
  if (links.length === 0) return null;
  return (
    <section className="space-y-3" aria-labelledby="connector-docs-title">
      <h2 id="connector-docs-title" className="text-foreground text-sm font-medium">
        Documentation
      </h2>
      <div className="flex flex-wrap gap-2">
        {links.map((link) =>
          link.external ? (
            <Button key={`${link.label}:${link.href}`} asChild variant="outline" size="sm">
              <a href={link.href} target="_blank" rel="noreferrer">
                {link.label}
                <ArrowSquareOutIcon className="size-3.5 shrink-0" />
              </a>
            </Button>
          ) : (
            <Button key={`${link.label}:${link.href}`} asChild variant="outline" size="sm">
              <Link href={link.href}>{link.label}</Link>
            </Button>
          ),
        )}
      </div>
    </section>
  );
}
