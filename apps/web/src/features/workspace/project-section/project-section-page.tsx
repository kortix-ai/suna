'use client';

/**
 * The one layout every project section screen uses.
 *
 * Connectors, Skills, Automations, Agents and Settings are all the same page:
 * a title, ONE line of description, a search field, a row of filter pills with
 * one primary action, then content. Rails, cards-in-cards and nested tab bars
 * are what this replaces — see ux-references/perplexity/{06,08,10,12}.
 *
 * `state` exists because every section view re-implemented the same five-branch
 * ladder (loading → forbidden → error → empty → no results → content) by hand;
 * schedule-view.tsx was ~60 lines of it. Passing the branch in means one
 * implementation, and one place to fix how a section fails.
 *
 * Deliberately NOT built on components/ui/page-header.tsx — that is a centered
 * marketing hero (AnimatedBg, py-16, text-4xl) owned by the public pages.
 */

import type { ReactNode } from 'react';

import { InfoBanner } from '@/components/ui/info-banner';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, type EmptyStateProps } from '@/features/layout/section/empty-state';
import { ErrorState, type ErrorStateProps } from '@/features/layout/section/error-state';
import { cn } from '@/lib/utils';

export type ProjectSectionState =
  | 'loading'
  | 'forbidden'
  | 'error'
  | 'empty'
  | 'no-results'
  | 'ready';

export interface ProjectSectionSearch {
  value: string;
  onChange: (value: string) => void;
  /** Defaults to "Search". Keep it to one or two words. */
  placeholder?: string;
}

export interface ProjectSectionPageProps {
  /** One `<h1>` per screen. */
  title: string;
  /**
   * ONE line. Say what the screen is for, not how it works.
   * Enforced at ≤90 characters by description-length.test.ts.
   */
  description: string;
  /** Optional "Learn more" target rendered inline after the description. */
  docsHref?: string;
  /** The persistent section tab strip, rendered above the header. */
  navTabs?: ReactNode;
  search?: ProjectSectionSearch;
  /** The single primary action. One per screen — not a toolbar. */
  action?: ReactNode;
  /** Filter pills, rendered left of the filter row. */
  filters?: ReactNode;
  state: ProjectSectionState;
  emptyProps?: EmptyStateProps;
  errorProps?: ErrorStateProps;
  /** Shown when `state` is 'forbidden'. */
  forbiddenMessage?: string;
  /** Shown when a search or filter matches nothing. */
  noResultsMessage?: string;
  /** Width of the scrolling body. Lists stay narrow; split views go wide. */
  width?: 'default' | 'wide' | 'full';
  children?: ReactNode;
}

const WIDTH_CLASS: Record<NonNullable<ProjectSectionPageProps['width']>, string> = {
  default: 'mx-auto w-full max-w-4xl px-6 py-6',
  wide: 'mx-auto w-full max-w-6xl px-6 py-6',
  full: 'h-full min-h-0 w-full',
};

const SKELETON_KEYS = ['a', 'b', 'c', 'd', 'e'];

function SectionBody({
  state,
  emptyProps,
  errorProps,
  forbiddenMessage,
  noResultsMessage,
  children,
}: Pick<
  ProjectSectionPageProps,
  'state' | 'emptyProps' | 'errorProps' | 'forbiddenMessage' | 'noResultsMessage' | 'children'
>) {
  if (state === 'loading') {
    return (
      <output aria-busy="true" aria-label="Loading" className="block space-y-2">
        {SKELETON_KEYS.map((key) => (
          <Skeleton key={key} className="h-14 w-full rounded-md" />
        ))}
      </output>
    );
  }

  // Deliberately not the overlay's old behaviour, which silently jumped the
  // user to the first section they *could* see. Say what happened instead.
  if (state === 'forbidden') {
    return (
      <InfoBanner tone="warning" title="You don't have access to this">
        {forbiddenMessage ?? 'Ask a project admin to grant you access.'}
      </InfoBanner>
    );
  }

  if (state === 'error') {
    return <ErrorState title="Failed to load" {...errorProps} />;
  }

  if (state === 'no-results') {
    return (
      <EmptyState
        size="sm"
        title="No matches"
        description={noResultsMessage ?? 'Try a different search or filter.'}
      />
    );
  }

  if (state === 'empty') {
    return <EmptyState title="Nothing here yet" {...emptyProps} />;
  }

  return <>{children}</>;
}

export function ProjectSectionPage({
  title,
  description,
  docsHref,
  navTabs,
  search,
  action,
  filters,
  state,
  emptyProps,
  errorProps,
  forbiddenMessage,
  noResultsMessage,
  width = 'default',
  children,
}: ProjectSectionPageProps) {
  const showFilterRow = Boolean(filters);

  return (
    <div className="bg-background flex h-full min-h-0 flex-col">
      {navTabs}

      <header className="border-border flex shrink-0 flex-col gap-3 border-b px-6 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0 space-y-1">
          <h1 className="text-foreground truncate text-2xl font-semibold tracking-tight">
            {title}
          </h1>
          <p className="text-muted-foreground text-sm">
            {description}
            {docsHref ? (
              <>
                {' '}
                <a
                  href={docsHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-foreground underline underline-offset-2"
                >
                  Learn more
                </a>
              </>
            ) : null}
          </p>
        </div>

        {search || action ? (
          <div className="flex shrink-0 items-center gap-2">
            {search ? (
              <InputGroupSearch className="w-full sm:w-64">
                <InputGroupSearchIcon />
                <InputGroupSearchInput
                  variant="popover"
                  value={search.value}
                  onChange={(event) => search.onChange(event.target.value)}
                  placeholder={search.placeholder ?? 'Search'}
                  aria-label={search.placeholder ?? `Search ${title.toLowerCase()}`}
                />
                {search.value ? (
                  <InputGroupSearchClear onClick={() => search.onChange('')} />
                ) : null}
              </InputGroupSearch>
            ) : null}
            {action}
          </div>
        ) : null}
      </header>

      {showFilterRow ? (
        <div className="border-border/60 flex shrink-0 items-center gap-2 border-b px-6 py-2.5">
          {filters}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={cn(WIDTH_CLASS[width])}>
          <SectionBody
            state={state}
            emptyProps={emptyProps}
            errorProps={errorProps}
            forbiddenMessage={forbiddenMessage}
            noResultsMessage={noResultsMessage}
          >
            {children}
          </SectionBody>
        </div>
      </div>
    </div>
  );
}

export default ProjectSectionPage;
