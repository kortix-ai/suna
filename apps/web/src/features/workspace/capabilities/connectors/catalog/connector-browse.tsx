'use client';

import { ArrowLeftIcon, GlobeIcon, MonitorIcon, PlusIcon } from '@phosphor-icons/react';
import { memo, useCallback } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { EmptyState } from '@/features/layout/section/empty-state';
import { useCapabilityScrollRoot } from '@/features/workspace/capabilities/shared/capability-scroll-root';

import { CatalogCard } from '@/features/workspace/capabilities/shared/catalog/catalog-card';
import { CatalogNoMatch } from '@/features/workspace/capabilities/shared/catalog/catalog-empty-state';
import {
  CatalogCardSkeleton,
  CatalogGrid,
} from '@/features/workspace/capabilities/shared/catalog/catalog-grid';
import { GRID_CLASSNAME } from '@/features/workspace/capabilities/shared/catalog/catalog-grid-tokens';
import { cn } from '@/lib/utils';
import { isCatalogEntryConnected, type CatalogEntry } from './catalog-entry';
import { catalogFootSummary } from './catalog-foot';
import { CategoryIcon } from './category-icon';
import { ALL_CATEGORIES } from './connector-categories';
import type { CatalogSection, CatalogState } from './use-catalog';
import { useCatalogAutoload } from './use-catalog-autoload';

/**
 * The connected marker on a catalogue card.
 *
 * A labelled badge, not a bare glyph. It was a 16px green check in the trailing
 * slot, which asked the user to decode a symbol whose only context was its
 * colour — reported as "the connected state is a bit too hidden". A word costs
 * one badge's width and needs no decoding.
 */
function CatalogAffordance({ connected }: { connected: boolean }) {
  if (connected) {
    return (
      <Badge variant="success" size="sm" data-testid="catalog-connected">
        Connected
      </Badge>
    );
  }
  return (
    <PlusIcon
      aria-hidden
      className="text-muted-foreground/80 group-hover:text-foreground size-4 shrink-0 transition-colors duration-150 ease-out"
      data-testid="catalog-add"
    />
  );
}

/**
 * A catalog favicon, or a neutral glyph tile when the record has none.
 *
 * A plain `<img>`, not `next/image`. These are third-party favicons on
 * arbitrary hosts, so the loader was already bypassed with `unoptimized` — which
 * left `fill` costing an absolutely-positioned child inside a `relative`
 * wrapper, per card, for no optimisation in return. Native `loading="lazy"`
 * defers every icon below the fold, which is most of them on a browse page.
 *
 * `width`/`height` are set so the box is reserved before the image arrives and
 * the grid never reflows around a late favicon.
 */
function ConnectorIcon({ icon, computer = false }: { icon: string | null; computer?: boolean }) {
  if (!icon) {
    return (
      <span className="bg-card flex size-9 shrink-0 items-center justify-center rounded-sm">
        {computer ? <MonitorIcon className="size-5" /> : <GlobeIcon className="size-5" />}
      </span>
    );
  }
  return (
    <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-sm">
      {/* eslint-disable-next-line @next/next/no-img-element -- third-party
          favicons on arbitrary hosts; the Next loader is bypassed anyway. */}
      <img
        src={icon}
        alt=""
        width={36}
        height={36}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        className="size-9 object-contain"
      />
    </span>
  );
}

/**
 * One catalogue card. Extracted only so the sectioned and flat shapes below
 * cannot drift in what a card shows or which flow it opens.
 *
 * `memo`'d because a browse page renders 72 of these and a flat category can
 * render several hundred. `entry` and `connectedKeys` are referentially stable
 * across a page landing (the arrays they come from are rebuilt, but the entry
 * objects inside them are not), so the comparison actually pays off.
 */
const CatalogEntryCard = memo(function CatalogEntryCard({
  entry,
  connectedKeys,
  onSelect,
}: {
  entry: CatalogEntry;
  connectedKeys: ReadonlySet<string>;
  onSelect: (entry: CatalogEntry) => void;
}) {
  return (
    <CatalogCard
      leading={<ConnectorIcon icon={entry.icon} computer={entry.source === 'computer'} />}
      title={entry.name}
      description={entry.description}
      trailing={<CatalogAffordance connected={isCatalogEntryConnected(entry, connectedKeys)} />}
      onClick={() => onSelect(entry)}
    />
  );
});

/** Skeletons appended to a growing grid while a request is in flight. Six —
 *  two full rows of the widest layout — so the placeholder block is the same
 *  shape as the batch about to replace it. */
const LOADING_MORE_SKELETONS = 6;

/**
 * One category section on the browse page: a heading, its true size, a fixed
 * slice of it, and one way in.
 *
 * **The section does not grow.** Its cards are a fixed top slice the server
 * chose from the complete category, and `total` is that category's real count.
 * Previously a section was a client-side bucketing of whatever pages had
 * loaded, so it gained cards while the user was reading it and reflowed the
 * page under them — Marko's "you keep adding stuff to the different categories
 * and expanding them so it's quite weird".
 *
 * **The count is on the heading now.** It was deliberately omitted before,
 * because the only number available described the loaded pages rather than the
 * catalogue, and got less true the more you loaded. `total` is the catalogue's
 * own count, so the heading can state it.
 *
 * **"View all" opens the category; it does not expand the section.** Opening it
 * puts a real server-side filter in front of the grid, so the label means what
 * it says even for a 348-app category.
 */
function CategorySection({
  section,
  connectedKeys,
  onSelect,
  onViewAll,
}: {
  section: CatalogSection;
  connectedKeys: ReadonlySet<string>;
  onSelect: (entry: CatalogEntry) => void;
  onViewAll: (category: string) => void;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-sm font-medium">
          <CategoryIcon category={section.key} className="size-4 shrink-0" />
          <span className="truncate">{section.label}</span>
          {/* `tabular-nums` so the figure does not jitter the heading's width
              if the catalogue count changes between refreshes. */}
          <span className="text-muted-foreground/40" aria-hidden>
            &bull;
          </span>
          <span className="text-muted-foreground/70 tabular-nums">
            {section.total.toLocaleString()}
          </span>
        </h2>
        {section.total > section.items.length ? (
          <Button
            variant="ghost"
            size="sm"
            aria-label={`View all ${section.label} connectors`}
            onClick={() => onViewAll(section.key)}
            // `size="sm"` is `h-8` — 29.44px at this repo's `--spacing: 0.23rem`,
            // under the 40px minimum hit area. `-inset-y-1.5` adds 5.52px top
            // and bottom for 40.48px. Vertical only: the label already makes
            // the control ~64px wide, and widening it would push the target
            // toward the heading it sits opposite.
            className="relative shrink-0 transition-transform duration-150 ease-out before:absolute before:-inset-y-1.5 before:content-[''] active:scale-[0.96]"
          >
            View all
          </Button>
        ) : null}
      </div>
      <div className={GRID_CLASSNAME}>
        {section.items.map((entry) => (
          <CatalogEntryCard
            key={entry.key}
            entry={entry}
            connectedKeys={connectedKeys}
            onSelect={onSelect}
          />
        ))}
      </div>
    </section>
  );
}

/**
 * The heading of an open category: where you are, and one control back.
 *
 * Deliberately NOT a persistent filter strip. A row of every category sitting
 * above the catalogue at all times is a second navigation layer on a page that
 * already has tabs, and it turns a place you go into a switch you have to
 * notice is flipped. This appears only while a category is open.
 *
 * `ArrowLeftIcon`, not `CaretLeftIcon`: a caret pair reads as paging through a
 * sequence, which is exactly the gesture this catalogue does not have.
 */
function CategoryViewHeader({
  category,
  label,
  total,
  onBack,
}: {
  category: string;
  label: string;
  total: number | null;
  onBack: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Button
        variant="ghost"
        size="sm"
        onClick={onBack}
        aria-label="Back to all connectors"
        // `-inset-1.5` on all sides here, unlike the section buttons: this
        // control sits at the row's left edge with nothing to its left.
        className="text-muted-foreground hover:text-foreground relative -ml-2 transition-transform duration-150 ease-out before:absolute before:-inset-1.5 before:content-[''] active:scale-[0.96]"
      >
        <ArrowLeftIcon className="size-3.5" />
        Back
      </Button>
      <span aria-hidden className="bg-border h-4 w-px shrink-0" />
      <h2 className="text-foreground flex min-w-0 items-center gap-1.5 text-sm font-medium">
        <CategoryIcon category={category} className="size-4 shrink-0" />
        <span className="truncate">{label}</span>
        {total !== null ? (
          <>
            <span className="text-muted-foreground/40" aria-hidden>
              &bull;
            </span>
            <span className="text-muted-foreground/70 tabular-nums">{total.toLocaleString()}</span>
          </>
        ) : null}
      </h2>
    </div>
  );
}

/**
 * The foot of the catalogue: how much is on screen, and how to get more.
 *
 * **Why there is a button under a scroll-driven grid.** The sentinel above it
 * covers the pointer. A control is what covers everything else — keyboard
 * users, who never scroll a container they have not focused, and assistive
 * tech, where "more content appeared somewhere below" is not an interaction.
 *
 * A pointer user rarely sees it: the sentinel fires 400px early, so by the time
 * this scrolls into view a fetch is usually already running and the button has
 * been replaced by its own pending state.
 */
function CatalogFoot({
  summary,
  hasMore,
  isLoadingMore,
  loadMore,
}: {
  summary: string | null;
  hasMore: boolean;
  isLoadingMore: boolean;
  loadMore: () => void;
}) {
  if (!hasMore && summary === null) return null;
  return (
    <div className="flex flex-col items-center gap-2 pt-2">
      {/* The button is hidden while a request is in flight rather than
          disabled: a disabled control still occupies the row, so the status
          line would sit under a dead button that says "Load more" while more is
          demonstrably already loading. */}
      {hasMore && !isLoadingMore ? (
        <Button
          variant="outline"
          size="sm"
          onClick={loadMore}
          className="transition-transform duration-150 ease-out active:scale-[0.96]"
        >
          Load more
        </Button>
      ) : null}
      {/* ONE line, spinner included. `tabular-nums` because these quantities
          change as batches land, and proportional digits would jitter the
          line's width under them. `aria-live` only while loading: announcing
          every idle count change would narrate the whole scroll. */}
      {summary ? (
        <p
          className="text-muted-foreground/70 flex items-center gap-2 text-xs tabular-nums"
          role={isLoadingMore ? 'status' : undefined}
          aria-live={isLoadingMore ? 'polite' : undefined}
        >
          {isLoadingMore ? <Loading className="size-3.5 shrink-0" /> : null}
          {summary}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The catalogue body, in one of two shapes.
 *
 * `sectioned` (the Discovery tab) is the browse page: a fixed top slice of each
 * of the largest categories, each stating its true size. `flat` (the All tab, a
 * search, and any open category) is one paginated grid.
 *
 * A text search always collapses to flat: the search runs server-side across
 * the whole catalogue, so category headings would fragment a result set the
 * user asked to see as one list. An open category collapses to flat for the
 * same reason — the heading would restate what the header already says.
 *
 * **One paging mechanism.** Scrolling to the foot fetches the next page, and so
 * does the button beside it. Nothing else fetches: no eager first-paint budget,
 * no per-category deepening loop, no reveal window uncovering already-loaded
 * cards. Those existed to let the client fake a category filter, and the server
 * performs it now.
 */
export function ConnectorBrowse({
  state,
  connectedKeys,
  mode,
  category,
  onCategoryChange,
  onSelect,
  emptyTitle,
  emptyDescription,
}: {
  state: CatalogState;
  connectedKeys: ReadonlySet<string>;
  mode: 'sectioned' | 'flat';
  /** The open category, or `ALL_CATEGORIES` while browsing everything. */
  category: string;
  onCategoryChange: (category: string) => void;
  onSelect: (entry: CatalogEntry) => void;
  emptyTitle: string;
  emptyDescription: string;
}) {
  const { activeQuery, entries, total, sections } = state;
  const searching = activeQuery.length > 0;
  // A search hides the category header and ignores the filter, so a category
  // must not survive into a searching render as an invisible constraint.
  const activeCategory = searching ? ALL_CATEGORIES : category;
  const openCategoryFacet = state.categories.find((facet) => facet.key === activeCategory) ?? null;

  const scrollRootRef = useCapabilityScrollRoot();
  // Opening a category replaces the browse page with one grid, and going Back
  // replaces it again. Without this the user keeps their scroll offset into
  // content that no longer exists, landing mid-grid on a view they just
  // arrived at the top of.
  const openCategory = useCallback(
    (next: string) => {
      onCategoryChange(next);
      scrollRootRef.current?.scrollTo({
        top: 0,
        behavior:
          typeof window !== 'undefined' &&
          window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
            ? 'auto'
            : 'smooth',
      });
    },
    [onCategoryChange, scrollRootRef],
  );

  const showSections = mode === 'sectioned' && !searching && activeCategory === ALL_CATEGORIES;

  const hasMore = !showSections && state.hasMore;
  // Depends on `state.loadMore`, NOT on `state`. `useCatalog` returns a fresh
  // object every render, so closing over `state` would give this a new identity
  // every render, and `useCatalogAutoload` lists it in its observer effect's
  // deps — the observer would be torn down and rebuilt on every render.
  const loadMore = state.loadMore;

  const sentinelRef = useCatalogAutoload({
    hasMore,
    isLoadingMore: state.isLoadingMore,
    loadMore,
  });

  const isEmpty = showSections ? sections.length === 0 : entries.length === 0;

  // Loading, error and "nothing to show" are `CatalogGrid`'s contract in its
  // documented order; only the *content* branch differs between the sectioned
  // and flat shapes, so those three states are delegated here and the grid
  // gets no children it could render.
  if (state.isLoading || state.isError || isEmpty) {
    return (
      <CatalogGrid
        isLoading={state.isLoading}
        isError={state.isError}
        error={state.error}
        onRetry={state.refetch}
        isEmpty
        empty={
          searching ? (
            <CatalogNoMatch query={activeQuery} excludedNoActions={state.excludedNoActions} />
          ) : (
            <EmptyState
              icon={GlobeIcon}
              size="sm"
              title={emptyTitle}
              description={emptyDescription}
            />
          )
        }
      >
        {null}
      </CatalogGrid>
    );
  }

  const summary = showSections
    ? null
    : catalogFootSummary({
        shown: entries.length,
        loaded: entries.length,
        total,
        categoryLabel: activeCategory === ALL_CATEGORIES ? null : (openCategoryFacet?.label ?? activeCategory),
        searching,
        hasMore,
        isLoadingMore: state.isLoadingMore,
      });

  return (
    <div
      // Search-as-you-type keeps the previous results and dims them, rather
      // than swapping the whole catalogue for six skeleton cards on every
      // debounced keystroke. `aria-busy` is the same statement for assistive
      // tech, and `pointer-events-none` stops a click landing on a card that is
      // about to be replaced by a different one in the same position.
      aria-busy={state.isRefreshing || undefined}
      className={cn(
        'space-y-6 transition-opacity duration-150 ease-out',
        state.isRefreshing && 'pointer-events-none opacity-60',
      )}
    >
      {/* Only while a category is open. There is no persistent filter strip
          above the catalogue — the page is the catalogue, and a category is a
          place you go rather than a switch you leave flipped. */}
      {!searching && activeCategory !== ALL_CATEGORIES ? (
        <CategoryViewHeader
          category={activeCategory}
          label={openCategoryFacet?.label ?? activeCategory}
          total={openCategoryFacet?.count ?? null}
          onBack={() => openCategory(ALL_CATEGORIES)}
        />
      ) : null}

      {showSections ? (
        sections.map((section) => (
          <CategorySection
            key={section.key}
            section={section}
            connectedKeys={connectedKeys}
            onSelect={onSelect}
            onViewAll={openCategory}
          />
        ))
      ) : (
        <div className={GRID_CLASSNAME}>
          {entries.map((entry) => (
            <CatalogEntryCard
              key={entry.key}
              entry={entry}
              connectedKeys={connectedKeys}
              onSelect={onSelect}
            />
          ))}
          {/* Inside the grid, not under it, so the next page's cards land
              exactly where these sit and the row does not reflow when they
              swap. */}
          {state.isLoadingMore
            ? Array.from({ length: LOADING_MORE_SKELETONS }, (_, index) => (
                <CatalogCardSkeleton key={`loading-${index}`} />
              ))
            : null}
        </div>
      )}

      {/* The scroll trigger. Zero-height and empty: it is a position, not a
          thing to look at, and `useCatalogAutoload` gives it 400px of lead so
          it is already working while it is still below the fold. */}
      {hasMore ? <div ref={sentinelRef} aria-hidden className="h-px" /> : null}

      <CatalogFoot
        summary={summary}
        hasMore={hasMore}
        isLoadingMore={state.isLoadingMore}
        loadMore={loadMore}
      />
    </div>
  );
}
