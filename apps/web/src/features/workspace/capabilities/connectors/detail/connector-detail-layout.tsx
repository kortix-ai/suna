'use client';

import { ArrowSquareOutIcon, CaretLeft } from '@phosphor-icons/react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from '@/components/ui/item';
import { Skeleton } from '@/components/ui/skeleton';
import { useTranslations as useI18nTranslations } from '@/i18n/use-translations';
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
  status,
  headerAction,
  closeAction,
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
  status?: ReactNode;
  /** Rendered in the header row's right cluster — the page-level verb
   *  (start a session with this connector). */
  headerAction?: ReactNode;
  /** The split view's close (X), rendered LAST in the header row's right
   *  cluster — after the header action (Jay, 2026-09-16: on the title line,
   *  after New session). Scoped to THIS page's column, so it can never stack
   *  on top of a nested column's own header X (Jay, 2026-09-14: double X). */
  closeAction?: ReactNode;
  /** Omit BOTH primary props to skip the primary panel entirely — the
   *  catalogue app page renders its own Linear-style meta card instead. */
  primaryTitle?: string;
  /** A node so the error state can stack its translated reason and the raw
   *  reported text inside ONE card instead of floating prose below it. */
  primaryDescription?: ReactNode;
  primaryAction?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <main className={cn('mx-auto w-full max-w-3xl space-y-6 px-4 pt-8 pb-20', className)}>
        {/* ONE centered row, and only one — icon, title, status, then the
            right cluster: the page verb, Go back, and the split view's X
            (Jay, 2026-09-16: the exits live ON the title line, extreme
            right, not on their own row above it). Both split-view panes use
            this same row, so their headers stay level by construction.
            There is deliberately no description slot: prose lives in each
            page's own sections (Overview, the primary panel), so the two
            split-view headers stay the same height and every block below
            them lines up rail-to-rail. */}
        <header className="flex min-w-0 items-center gap-3">
          {icon}
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <span className="text-foreground text-2xl font-semibold tracking-tight text-balance">
              {title}
            </span>
            {status}
          </div>
          {headerAction || backHref || closeAction ? (
            <div className="ml-auto flex shrink-0 items-center gap-1.5 self-start">
              {headerAction}
              {backHref ? (
                <Button
                  asChild
                  size="xs"
                  variant="ghost"
                  className="text-muted-foreground hover:text-foreground gap-1.5"
                >
                  <Link href={backHref}>
                    <CaretLeft className="size-3.5 shrink-0" />
                    {tI18nComplete.raw('text6aadac2f2b7a')}
                  </Link>
                </Button>
              ) : null}
              {closeAction}
            </div>
          ) : null}
        </header>

        {primaryTitle ? (
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
              <ItemActions className="max-sm:basis-full max-sm:*:w-full">
                {primaryAction}
              </ItemActions>
            ) : null}
          </Item>
        ) : null}

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
  /** Matches the loaded header's icon tile — `size-10` everywhere now. */
  iconClassName?: string;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" aria-busy>
      <main className="mx-auto w-full max-w-3xl space-y-6 px-4 pt-8 pb-20">
        {/* One header ROW, like both loaded pages — a second bar here would
            push every block below out of parallel with the sibling pane. */}
        <header className="flex min-w-0 items-center gap-3">
          <Skeleton className={cn('shrink-0 rounded-md', iconClassName)} />
          <Skeleton className="h-6 w-44 max-w-full rounded-sm" />
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
 * Connect. Quiet text links in a two-column grid (Jay, 2026-09-17): the
 * bordered row-list gave four external links the visual weight of primary
 * content — a full-width button apiece, mostly dead space — and the
 * earlier chip-per-link approach read as a pile of buttons. References get
 * reference typography: muted, compact, underline on hover, the external
 * mark always faintly visible instead of a hover surprise.
 */
export function ConnectorDocumentationLinks({
  links,
}: {
  links: readonly ConnectorDocumentationLink[];
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  if (links.length === 0) return null;
  return (
    <section className="space-y-2" aria-labelledby="connector-docs-title">
      <h2 id="connector-docs-title" className="text-foreground text-sm font-medium">
        {tI18nComplete.raw('textc205924de0fe')}
      </h2>
      <ul className="grid gap-x-8 sm:grid-cols-2">
        {links.map((link) => (
          <li key={`${link.label}:${link.href}`} className="min-w-0">
            <Link
              href={link.href}
              {...(link.external ? { target: '_blank', rel: 'noreferrer' } : {})}
              className="group text-muted-foreground hover:text-foreground inline-flex max-w-full items-center gap-1.5 py-1.5 text-sm transition-colors hover:underline"
            >
              <span className="truncate">{link.label}</span>
              {link.external ? (
                <ArrowSquareOutIcon className="size-3.5 shrink-0 opacity-50 transition-opacity group-hover:opacity-100" />
              ) : null}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
