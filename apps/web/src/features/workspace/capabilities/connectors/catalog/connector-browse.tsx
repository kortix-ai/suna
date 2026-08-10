'use client';

import { ArrowLeftIcon, GlobeIcon, MonitorIcon, PlusIcon } from '@phosphor-icons/react';
import Image from 'next/image';
import { useCallback, useMemo, useState, type CSSProperties } from 'react';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ConnectorConnectedMark } from '@/features/workspace/capabilities/connectors/connector-identity';
import { useCapabilityScrollRoot } from '@/features/workspace/capabilities/shared/capability-scroll-root';

import { CatalogCard } from '@/features/workspace/capabilities/shared/catalog/catalog-card';
import { CatalogNoMatch } from '@/features/workspace/capabilities/shared/catalog/catalog-empty-state';
import {
  CatalogCardSkeleton,
  CatalogGrid,
} from '@/features/workspace/capabilities/shared/catalog/catalog-grid';
import { GRID_CLASSNAME } from '@/features/workspace/capabilities/shared/catalog/catalog-grid-tokens';
import { cn } from '@/lib/utils';
import { catalogSections, isCatalogEntryConnected, type CatalogEntry } from './catalog-entry';
import { catalogFootSummary } from './catalog-foot';
import { CATALOG_INITIAL_REVEAL, canRevealMore, nextRevealCount } from './catalog-paging';
import { CategoryIcon } from './category-icon';
import {
  ALL_CATEGORIES,
  CATEGORY_ROW_CAP,
  groupIntoSections,
  resolveActiveCategory,
  sectionTitle,
} from './connector-categories';
import type { CatalogState } from './use-catalog';
import { useCatalogAutoload } from './use-catalog-autoload';

/**
 * The `+` / `✓` a catalogue card carries in its `trailing` slot.
 *
 * Not a button. The whole `CatalogCard` is already a `<button>`, and nesting
 * an interactive element inside one is invalid HTML that browsers resolve by
 * splitting the outer button — which would break the card's own click target.
 * This is a glyph reporting state, and the card around it is what you press;
 * `aria-hidden` keeps it out of the accessible name, which the card's title
 * already supplies. That also means the 40x40 minimum-hit-area rule does not
 * apply here: there is one hit target, and it is card-sized.
 */
function CatalogAffordance({ connected }: { connected: boolean }) {
  if (connected) {
    return <ConnectorConnectedMark />;
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
 * The `outline` is `make-interfaces-feel-better`'s image rule: pure black at
 * 10% in light, pure white at 10% in dark. A tinted neutral would pick up the
 * surface colour behind it and read as dirt on the logo's edge.
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
    <span className="relative flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-sm">
      <Image
        src={icon}
        alt=""
        referrerPolicy="no-referrer"
        fill
        sizes="36px"
        className="object-contain"
        unoptimized
      />
    </span>
  );
}

/**
 * One catalogue card. Extracted only so the sectioned and flat shapes below
 * cannot drift in what a card shows or which flow it opens.
 *
 * `reveal` is an index into the cards a newly loaded page just appended, or
 * `null` for a card that was already on screen. It drives the enter animation
 * and nothing else.
 */
function CatalogEntryCard({
  entry,
  connectedKeys,
  onSelect,
  reveal = null,
}: {
  entry: CatalogEntry;
  connectedKeys: ReadonlySet<string>;
  onSelect: (entry: CatalogEntry) => void;
  reveal?: number | null;
}) {
  return (
    <CatalogCard
      leading={<ConnectorIcon icon={entry.icon} computer={entry.source === 'computer'} />}
      title={entry.name}
      description={entry.description}
      trailing={<CatalogAffordance connected={isCatalogEntryConnected(entry, connectedKeys)} />}
      onClick={() => onSelect(entry)}
      className={reveal === null ? undefined : 'kx-card-reveal'}
      style={reveal === null ? undefined : cardRevealDelay(reveal)}
    />
  );
}

/** Stagger step, in ms. The floor of the 30-80ms band on purpose: the band
 *  assumes a vertical list where each item is its own beat, and this is a 3-up
 *  grid where three cards share a row. At 40ms the row itself visibly
 *  diagonalled. */
const REVEAL_STEP_MS = 30;

/** Cards past this all start together. With 3 columns that is the first row
 *  leading and everything behind it arriving as one — a cascade, not a crawl.
 *  Holds the whole reveal to 90 + 200 = 290ms, inside the 300ms UI budget
 *  however many cards a page appends. */
const REVEAL_MAX_STEPS = 3;

/**
 * The delay for the nth appended card, as a custom property.
 *
 * A property rather than `animationDelay` directly, because an inline style
 * outranks a stylesheet declaration: setting the delay inline meant the
 * `prefers-reduced-motion` rule could strip the movement but never the
 * stagger, so a user who asked for less motion still got a staged reveal.
 * `.kx-card-reveal` reads this through `var()`, which its media query can
 * override.
 */
function cardRevealDelay(reveal: number): CSSProperties {
  return {
    '--kx-card-reveal-delay': `${Math.min(reveal, REVEAL_MAX_STEPS) * REVEAL_STEP_MS}ms`,
  } as CSSProperties;
}

/** Skeletons appended to a growing grid while a request is in flight. Six —
 *  two full rows of the widest layout — so the placeholder block is the same
 *  shape as the batch about to replace it. Three left a visibly half-empty row
 *  that then reflowed as the real cards landed. */
const LOADING_MORE_SKELETONS = 6;

/** Skeletons for a focused category with nothing loaded for it yet. Six, to
 *  match `CatalogGridSkeleton` — this is a cold grid, not a growing one. */
const PENDING_SKELETONS = 6;

/**
 * One category section on the Discovery tab: a heading, the first
 * `CATEGORY_ROW_CAP` cards, and "View all".
 *
 * **"View all" opens the category; it does not expand the section.** In-place
 * expansion could never keep the promise the label makes — a section holds only
 * what the loaded pages happen to contain, so "View all" on Finance opened 8
 * cards out of a 2,713-item catalogue. Opening the category is what puts it in
 * front of `useCatalog`'s `focusCategory`, which keeps fetching, and in front of
 * the scroll sentinel, which keeps fetching for as long as the user scrolls. The
 * label now means what it says.
 *
 * What the earlier expansion was protecting against — a page that silently
 * swapped every section for one grid — is handled by `CategoryView`'s own
 * heading and Back control, not by refusing to open the category.
 *
 * No count on the heading, and none on the button. "Productivity 26" would
 * describe the pages that happen to be loaded, not the catalogue, and would
 * get worse the more the user loads.
 *
 * The button appears on `items.length > CATEGORY_ROW_CAP` alone, with no
 * `POPULAR_SECTION` exemption. That case is closed one level up instead:
 * `catalogSections` is called with `popularCap: CATEGORY_ROW_CAP`, so Popular
 * cannot exceed the cap and cannot reach the condition. Pinned in
 * `catalog-entry.test.ts`, because it is the caller's argument — not anything
 * visible here — that keeps it true.
 */
function CategorySection({
  category,
  items,
  connectedKeys,
  onSelect,
  onViewAll,
}: {
  category: string;
  items: CatalogEntry[];
  connectedKeys: ReadonlySet<string>;
  onSelect: (entry: CatalogEntry) => void;
  onViewAll: (category: string) => void;
}) {
  const label = sectionTitle(category);
  const visible = items.slice(0, CATEGORY_ROW_CAP);

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-muted-foreground flex items-center gap-1.5 text-sm font-medium">
          <CategoryIcon category={category} className="size-4" />
          {label}
        </h2>
        {items.length > CATEGORY_ROW_CAP ? (
          <Button
            variant="ghost"
            size="sm"
            aria-label={`View all ${label} connectors`}
            onClick={() => onViewAll(category)}
            // `size="sm"` is `h-8` — 29.44px at this repo's `--spacing: 0.23rem`,
            // under the 40px minimum hit area. `-inset-y-1.5` adds 5.52px top
            // and bottom for 40.48px. Vertical only: the label already makes
            // the control ~64px wide, and widening it would push the target
            // toward the heading it sits opposite.
            className="relative transition-transform duration-150 ease-out before:absolute before:-inset-y-1.5 before:content-[''] active:scale-[0.96]"
          >
            View all
          </Button>
        ) : null}
      </div>
      <div className={GRID_CLASSNAME}>
        {visible.map((entry) => (
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
 * This is the whole reason "View all" can open a category instead of expanding
 * a section in place. The objection to opening one was never the grid — it was
 * that the page silently replaced every section with one list and gave no
 * account of itself. A heading naming the category and a Back button beside it
 * is that account, and it costs one row.
 *
 * Deliberately NOT a persistent filter strip. A row of every category sitting
 * above the catalogue at all times is a second navigation layer on a page that
 * already has tabs, and it turns a place you go into a switch you have to
 * notice is flipped. This appears only while a category is open.
 *
 * `ArrowLeftIcon`, not `CaretLeftIcon`: a caret pair reads as paging through a
 * sequence, which is exactly the gesture this catalogue does not have.
 */
function CategoryViewHeader({ category, onBack }: { category: string; onBack: () => void }) {
  const label = sectionTitle(category);
  return (
    <div className="flex items-center gap-2">
      <Button
        variant="ghost"
        size="sm"
        onClick={onBack}
        aria-label="Back to all connectors"
        // `size="sm"` is `h-8` — 29.44px at `--spacing: 0.23rem`, under the
        // 40px minimum. `-inset-y-1.5` adds 5.52px top and bottom for 40.48px.
        // Horizontal too here, unlike the section buttons: this control sits at
        // the row's left edge with nothing to its left to overlap.
        className="text-muted-foreground hover:text-foreground relative -ml-2 transition-transform duration-150 ease-out before:absolute before:-inset-1.5 before:content-[''] active:scale-[0.96]"
      >
        <ArrowLeftIcon className="size-3.5" />
        Back
      </Button>
      <span aria-hidden className="bg-border h-4 w-px shrink-0" />
      <h2 className="text-foreground flex min-w-0 items-center gap-1.5 text-sm font-medium">
        <CategoryIcon category={category} className="size-4 shrink-0" />
        <span className="truncate">{label}</span>
      </h2>
    </div>
  );
}

/**
 * The foot of the catalogue: how much is on screen, and how to get more.
 *
 * **Why there is a button under a scroll-driven grid.** The sentinel above it
 * covers the pointer. A control is what covers everything else — keyboard
 * users, who never scroll a container they have not focused; assistive tech,
 * where "more content appeared somewhere below" is not an interaction; and the
 * one case the sentinel genuinely cannot serve, a focused category that has
 * hit `CATALOG_AUTOLOAD_MAX_PAGES` with its sentinel still in view. The button
 * is not a fallback for a broken observer; it is the accessible path, and it
 * is always rendered while there is more to fetch.
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
      {/* ONE line, spinner included — not a spinner line stacked on a count
          line. `tabular-nums` because these quantities change as batches land,
          and proportional digits would jitter the line's width under them.
          `aria-live` only while loading: announcing every idle count change
          would narrate the whole scroll. */}
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
 * `sectioned` (the Discovery tab) groups into capped category sections, Popular
 * first. `flat` (the All tab, and any focused category) is one grid.
 *
 * A text search always collapses to flat, in both modes: the search runs
 * server-side across the whole catalogue, so category headings would fragment
 * a result set the user asked to see as one list. Focusing a category collapses
 * to flat for the same reason — the heading would restate the chip.
 *
 * **The catalogue paginates, by both gestures.** Scrolling to the foot loads
 * the next page (`useCatalogAutoload`), and the foot carries a real button for
 * everyone who does not reach it by scrolling. Neither is capped: the ceiling
 * in `catalog-paging.ts` bounds only the fetching the page does on its own.
 * This reverses an earlier decision to let browsing show one page and leave
 * search as the only way to reach the rest — with ~2,700 apps behind a
 * 48-per-page cursor, that made every category section a sample and made "View
 * all" a label the page could not honour.
 */
export function ConnectorBrowse({
  state,
  connectedKeys,
  mode,
  category,
  availableCategories,
  onCategoryChange,
  onSelect,
  emptyTitle,
  emptyDescription,
}: {
  state: CatalogState;
  connectedKeys: ReadonlySet<string>;
  mode: 'sectioned' | 'flat';
  /** What the user picked. `ALL_CATEGORIES` when unfiltered — and NOT
   *  necessarily what gets applied; see `resolveActiveCategory`. */
  category: string;
  /** From `catalogCategoryKeys`, the same list the rail is built from. A
   *  `category` missing from it is stale and gets dropped rather than applied
   *  to a set that no longer contains it. */
  availableCategories: readonly string[];
  onCategoryChange: (category: string) => void;
  onSelect: (entry: CatalogEntry) => void;
  emptyTitle: string;
  emptyDescription: string;
}) {
  const { activeQuery, entries, total } = state;
  const searching = activeQuery.length > 0;
  // Derived, never taken at face value. A picked category outlives a search
  // (during which the rail is hidden) and outlives the entry set that produced
  // it (a refetch, or `useCatalog` swapping source and with it the whole
  // category vocabulary). Resolving against the list the rail shows means the
  // grid and that rail cannot disagree about what is applied.
  const activeCategory = resolveActiveCategory(category, availableCategories, { searching });

  const scrollRootRef = useCapabilityScrollRoot();
  // Opening a category replaces a page of sections with one grid, and going
  // Back replaces it again. Without this the user keeps their scroll offset
  // into content that no longer exists, landing mid-grid on a view they just
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

  const sections = useMemo(
    () => (mode === 'sectioned' ? catalogSections(entries, { popularCap: CATEGORY_ROW_CAP }) : []),
    [mode, entries],
  );

  const flat = useMemo(() => {
    if (activeCategory === ALL_CATEGORIES) return entries;
    return (
      groupIntoSections(entries, (entry) => entry.categories).find(
        (group) => group.category === activeCategory,
      )?.items ?? []
    );
  }, [activeCategory, entries]);

  const showSections = mode === 'sectioned' && !searching && activeCategory === ALL_CATEGORIES;

  // The reveal window over the flat grid — see `CATALOG_REVEAL_STEP`. Reset
  // whenever the list underneath it becomes a different list, because a window
  // is an offset into one list and means nothing against another: leaving it at
  // 96 after opening a category would skip that category's first 96 cards
  // straight past the fold.
  //
  // Keyed on what the user did, not on `flat` itself. `flat` changes identity
  // every time a page lands, and resetting on that would claw the window back
  // to 24 in the middle of a scroll.
  const [revealed, setRevealed] = useState(CATALOG_INITIAL_REVEAL);
  const revealKey = `${activeCategory}:${activeQuery}:${mode}`;
  const [seenRevealKey, setSeenRevealKey] = useState(revealKey);
  if (seenRevealKey !== revealKey) {
    setSeenRevealKey(revealKey);
    setRevealed(CATALOG_INITIAL_REVEAL);
  }

  // Sections are their own window — each caps at `CATEGORY_ROW_CAP` and grows
  // as pages land — so the reveal step applies to the flat grid alone. Without
  // this guard the sentinel would "uncover" cards in a shape that is not
  // showing `flat` at all, and scrolling the Discovery tab would do nothing.
  const canReveal = !showSections && canRevealMore(revealed, flat.length);
  const visibleFlat = useMemo(
    () => (showSections ? flat : flat.slice(0, revealed)),
    [showSections, flat, revealed],
  );

  // Uncovering beats fetching, always: the cards are already in memory, so the
  // grid grows in the same frame with no request at all. Only once the window
  // has caught up with everything loaded does a scroll cost a round trip.
  const hasMore = canReveal || state.hasMore;
  // Depends on `state.loadMore`, NOT on `state`. `useCatalog` returns a fresh
  // object every render, so closing over `state` would give this a new identity
  // every render, and `useCatalogAutoload` lists it in its observer effect's
  // deps — the observer would be torn down and rebuilt on every render of the
  // page. `state.loadMore` is a `useCallback` and is stable.
  const fetchMore = state.loadMore;
  const loadMore = useCallback(() => {
    if (canReveal) {
      setRevealed((current) => nextRevealCount(current, flat.length));
      return;
    }
    fetchMore();
  }, [canReveal, flat.length, fetchMore]);

  const sentinelRef = useCatalogAutoload({
    hasMore,
    isLoadingMore: state.isLoadingMore,
    loadMore,
  });

  const isEmpty = showSections ? sections.length === 0 : flat.length === 0;
  // A focused category with nothing loaded for it yet is NOT empty — the page
  // is still fetching pages to fill it. Rendering "no connectors" over a grid
  // about to receive cards is the one state this surface must never show.
  const isPending = isEmpty && state.hasMore && activeCategory !== ALL_CATEGORIES;

  // Loading, error and "nothing to show" are `CatalogGrid`'s contract in its
  // documented order; only the *content* branch differs between the sectioned
  // and flat shapes, so those three states are delegated here and the grid
  // gets no children it could render.
  if (state.isLoading || state.isError || (isEmpty && !isPending)) {
    return (
      <CatalogGrid
        isLoading={state.isLoading}
        isError={state.isError}
        error={state.error}
        onRetry={state.refetch}
        isEmpty
        empty={
          searching ? (
            <CatalogNoMatch query={activeQuery} />
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

  const summary = catalogFootSummary({
    shown: showSections ? entries.length : visibleFlat.length,
    loaded: entries.length,
    total,
    categoryLabel: activeCategory === ALL_CATEGORIES ? null : sectionTitle(activeCategory),
    searching,
    hasMore,
    isLoadingMore: state.isLoadingMore,
  });

  return (
    <div
      // Search-as-you-type keeps the previous results and dims them, rather
      // than swapping the whole catalogue for six skeleton cards on every
      // debounced keystroke (which is what `isLoading` did before
      // `placeholderData: keepPreviousData` split the cold state out of it).
      // `aria-busy` is the same statement for assistive tech, and
      // `pointer-events-none` stops a click landing on a card that is about to
      // be replaced by a different one in the same position.
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
        <CategoryViewHeader category={activeCategory} onBack={() => openCategory(ALL_CATEGORIES)} />
      ) : null}

      {showSections ? (
        sections.map((section) => (
          <CategorySection
            key={section.category}
            category={section.category}
            items={section.items}
            connectedKeys={connectedKeys}
            onSelect={onSelect}
            onViewAll={openCategory}
          />
        ))
      ) : (
        <div className={GRID_CLASSNAME}>
          {visibleFlat.map((entry) => (
            <CatalogEntryCard
              key={entry.key}
              entry={entry}
              connectedKeys={connectedKeys}
              onSelect={onSelect}
            />
          ))}
          {/* Inside the grid, not under it, so the next page's cards land
              exactly where these sit and the row does not reflow when they
              swap. Only in the flat shape: the sectioned one has no single
              grid for a page to append to.
              A category the catalogue is still fetching for gets a full grid
              of them rather than three, because there is nothing above them to
              read — this is that category's cold state, and it should look
              like every other cold state on the page. */}
          {isPending || state.isLoadingMore
            ? Array.from(
                { length: isPending ? PENDING_SKELETONS : LOADING_MORE_SKELETONS },
                (_, index) => <CatalogCardSkeleton key={`loading-${index}`} />,
              )
            : null}
        </div>
      )}

      {/* The scroll trigger. Zero-height and empty: it is a position, not a
          thing to look at, and `useCatalogAutoload` gives it 400px of lead so
          it is already working while it is still below the fold. */}
      {hasMore ? <div ref={sentinelRef} aria-hidden className="h-px" /> : null}

      {/* Suppressed while the grid is nothing but skeletons: they already say
          "fetching", and a "Load more" button under them offers to fetch what
          is already on its way. */}
      {isPending ? null : (
        <CatalogFoot
          summary={summary}
          hasMore={hasMore}
          isLoadingMore={state.isLoadingMore}
          loadMore={loadMore}
        />
      )}
    </div>
  );
}
