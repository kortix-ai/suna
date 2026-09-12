'use client';

import { ArrowLeftIcon, ArrowSquareOutIcon, CheckIcon } from '@phosphor-icons/react';
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
import {
  Stepper,
  StepperDescription,
  StepperIndicator,
  StepperItem,
  StepperSeparator,
  StepperTitle,
  StepperTrigger,
} from '@/components/ui/stepper';
import { cn } from '@/lib/utils';

import type { ConnectorSetupStep } from './connector-detail-copy';

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
  primaryTitle,
  primaryDescription,
  primaryAction,
  children,
  className,
}: {
  backHref: string;
  icon: ReactNode;
  title: ReactNode;
  description?: string | null;
  status?: ReactNode;
  primaryTitle: string;
  primaryDescription: string;
  primaryAction?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {/* Back sits at the container's extreme top-left, OUTSIDE the centered
          column — it navigates the page, it is not part of the page's
          content, so it anchors to the surface's corner like a window
          control. */}
      <div className="px-4 pt-3">
        <Button asChild variant="ghost" size="sm" className="-ml-2 w-fit gap-1.5">
          <Link href={backHref}>
            <ArrowLeftIcon className="size-3.5 shrink-0" />
            Back to connectors
          </Link>
        </Button>
      </div>

      <main
        className={cn('mx-auto w-full max-w-3xl space-y-6 px-4 pt-4 pb-20 lg:pt-6', className)}
      >
        <header className="flex min-w-0 items-start gap-3">
          {icon}
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-foreground text-2xl font-semibold tracking-tight text-balance">
                {title}
              </h1>
              {status}
            </div>
            {description ? (
              // Clamped: catalogue descriptions are third-party prose and some
              // run to a paragraph — the header is an identity line, not a
              // reading assignment.
              <p className="text-muted-foreground line-clamp-3 max-w-[64ch] text-base text-pretty sm:text-sm">
                {description}
              </p>
            ) : null}
          </div>
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
 * The loading state, shape-matched to the loaded page: real back link (its
 * target is known before any data), then quiet bars where the header, the
 * Connection panel, and a short list will land. No placeholder sentences —
 * words in a skeleton read as content and then get replaced, which is worse
 * than gray.
 */
export function ConnectorDetailSkeleton({
  backHref,
  iconClassName = 'size-10',
}: {
  backHref: string;
  /** Matches the loaded header's icon tile — `size-14` on the connected page. */
  iconClassName?: string;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" aria-busy>
      <div className="px-4 pt-3">
        <Button asChild variant="ghost" size="sm" className="-ml-2 w-fit gap-1.5">
          <Link href={backHref}>
            <ArrowLeftIcon className="size-3.5 shrink-0" />
            Back to connectors
          </Link>
        </Button>
      </div>

      <main className="mx-auto w-full max-w-3xl space-y-6 px-4 pt-4 pb-20 lg:pt-6">
        <header className="flex items-start gap-3">
          <Skeleton className={cn('shrink-0 rounded-md', iconClassName)} />
          <div className="min-w-0 flex-1 space-y-2 pt-1">
            <Skeleton className="h-6 w-44 max-w-full rounded-sm" />
            <Skeleton className="h-4 w-72 max-w-full rounded-sm" />
          </div>
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
 * "Connection flow" — a LIVE stepper, not a printed list.
 *
 * `currentStep` is the 0-based index of the step the user is on, derived by
 * the caller from real state (`connected`, `added`, …). Steps before it show
 * a green check, the current one is emphasized, the rest wait muted — so the
 * page answers "where am I?" at a glance instead of re-printing the same
 * static instructions before and after connecting. Pass `steps.length` when
 * everything is done.
 */
export function ConnectorSetupGuide({
  steps,
  currentStep = 0,
}: {
  steps: readonly ConnectorSetupStep[];
  currentStep?: number;
}) {
  if (steps.length === 0) return null;
  return (
    <section className="space-y-3" aria-labelledby="connector-setup-title">
      <h2 id="connector-setup-title" className="text-foreground text-sm font-medium">
        Connection flow
      </h2>
      <Stepper
        orientation="vertical"
        value={currentStep + 1}
        count={steps.length}
        className="flex w-full flex-col"
      >
        {steps.map((step, index) => (
          <div key={step.title} className="flex gap-3.5">
            <StepperItem step={index + 1} className="items-center">
              <StepperTrigger asChild>
                <span className="flex shrink-0">
                  <StepperIndicator
                    className={cn(
                      'size-7 text-sm font-medium tabular-nums',
                      'data-[state=completed]:bg-kortix-green/15 data-[state=completed]:text-kortix-green',
                    )}
                  >
                    <span className="group-data-[state=completed]/step:hidden">{index + 1}</span>
                    <CheckIcon
                      weight="bold"
                      className="hidden size-3.5 group-data-[state=completed]/step:block"
                    />
                  </StepperIndicator>
                </span>
              </StepperTrigger>
              <StepperSeparator className="bg-secondary m-0" />
            </StepperItem>
            {/* Titles keep ONE weight and ONE color in every state — the
                indicator alone carries progress. `pt-1` centers the first
                text line (20px) against the 28px circle. */}
            <div
              className={cn(
                'min-w-0 flex-1 space-y-0.5 pt-1',
                index === steps.length - 1 ? 'pb-0' : 'pb-8',
              )}
            >
              <StepperTitle className="text-foreground text-base font-medium sm:text-sm">
                {step.title}
              </StepperTitle>
              <StepperDescription className="text-base text-pretty sm:text-sm">
                {step.description}
              </StepperDescription>
            </div>
          </div>
        ))}
      </Stepper>
    </section>
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
