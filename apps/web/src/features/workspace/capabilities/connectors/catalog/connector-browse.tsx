'use client';

import {
  BriefcaseIcon,
  ChartBarIcon,
  ChatCircleIcon,
  CodeIcon,
  CurrencyDollarIcon,
  FolderIcon,
  GearIcon,
  GlobeIcon,
  LifebuoyIcon,
  MegaphoneIcon,
  PaletteIcon,
  PlusIcon,
  ShoppingCartIcon,
  TrendUpIcon,
  UsersIcon,
} from '@phosphor-icons/react';
import Image from 'next/image';
import { useMemo, useState, type ComponentType, type CSSProperties } from 'react';

import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ConnectorConnectedMark } from '@/features/workspace/capabilities/connectors/connector-identity';

import { CatalogCard } from '@/features/workspace/capabilities/shared/catalog/catalog-card';
import { CatalogGrid } from '@/features/workspace/capabilities/shared/catalog/catalog-grid';
import { cn } from '@/lib/utils';
import { GRID_CLASSNAME } from '@/features/workspace/capabilities/shared/catalog/catalog-grid-tokens';
import { CatalogNoMatch } from '@/features/workspace/capabilities/shared/catalog/catalog-empty-state';
import { catalogSections, isCatalogEntryConnected, type CatalogEntry } from './catalog-entry';
import {
  ALL_CATEGORIES,
  CATEGORY_ROW_CAP,
  groupIntoSections,
  resolveActiveCategory,
  sectionTitle,
} from './connector-categories';
import type { CatalogState } from './use-catalog';

/**
 * A glyph per section heading, keyed by the FOLDED section key.
 *
 * The first block is one entry per `CURATED_SECTIONS` key, so every curated
 * heading is drawn deliberately. The second is a courtesy for the uncurated
 * tail — raw catalogue values no section claims but that turn up often enough
 * to be worth a glyph.
 *
 * Deliberately partial beyond that. The live catalogue publishes long-tail
 * categories nobody has drawn an icon for, and inventing a loose visual match
 * for each ("Malwarebytes" -> a shield?) would be worse than one honest
 * default. Anything unlisted gets `FolderIcon`.
 *
 * Icons live here rather than on `CatalogSectionDef` on purpose:
 * `connector-categories.ts` is a pure module its tests import without React,
 * and putting components in it would drag that whole tree into them.
 */
const CATEGORY_ICON: Record<string, ComponentType<{ className?: string }>> = {
  // One per curated section, folded: `data-analytics` -> `dataanalytics`.
  popular: TrendUpIcon,
  productivity: BriefcaseIcon,
  operations: GearIcon,
  finance: CurrencyDollarIcon,
  dataanalytics: ChartBarIcon,
  communication: ChatCircleIcon,
  salesmarketing: MegaphoneIcon,
  customersupport: LifebuoyIcon,
  commerce: ShoppingCartIcon,
  contentdesign: PaletteIcon,
  developertools: CodeIcon,
  // Uncurated raw values common enough to be worth a glyph. `business` and
  // `businessmanagement` are what the live Easy Connect feed leads with, and
  // they now sit in the tail rather than at the top.
  business: BriefcaseIcon,
  businessmanagement: BriefcaseIcon,
  hr: UsersIcon,
  humanresources: UsersIcon,
  analytics: ChartBarIcon,
  data: ChartBarIcon,
  marketing: MegaphoneIcon,
  sales: MegaphoneIcon,
  developer: CodeIcon,
  engineering: CodeIcon,
};

function categoryIcon(category: string): ComponentType<{ className?: string }> {
  return CATEGORY_ICON[category.toLowerCase().replace(/[^a-z0-9]/g, '')] ?? FolderIcon;
}

/**
 * The category filter. Lives in the page's filter row, right of the tabs, and
 * only while a catalogue tab is active — the project's own connector list is
 * short enough that filtering it by category is dead weight.
 *
 * `categories` is handed in rather than derived here, and that is the fix for
 * a real bug rather than a preference. This control and `ConnectorBrowse` each
 * used to call `groupIntoSections` on the same entries independently, so the
 * options offered and the options the grid could honour were two derivations
 * that could disagree — and a value that survived into an entry set without it
 * filtered the grid to nothing while this trigger showed its placeholder. The
 * page derives the list once (`catalogCategoryKeys`) and both read it.
 */
export function CategorySelect({
  categories,
  value,
  onChange,
}: {
  /** From `catalogCategoryKeys` — the same list `ConnectorBrowse` validates
   *  the active category against. */
  categories: readonly string[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger variant="outline" className="w-48 text-xs">
        <SelectValue placeholder="All categories" />
      </SelectTrigger>
      <SelectContent align="end">
        <SelectItem value={ALL_CATEGORIES}>All categories</SelectItem>
        {categories.map((category) => (
          <SelectItem key={category} value={category}>
            {sectionTitle(category)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

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
function IntegrationIcon({ icon }: { icon: string | null }) {
  if (!icon) {
    return (
      <span className="bg-card flex size-9 shrink-0 items-center justify-center rounded-sm">
        <GlobeIcon className="size-5" />
      </span>
    );
  }
  return (
    <span className="  relative flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-sm">
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
 * `reveal` is an index into the cards a "View all" just uncovered, or `null`
 * for a card that was already on screen. It drives the enter animation and
 * nothing else — see `CategorySection`.
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
      leading={<IntegrationIcon icon={entry.icon} />}
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
 *  however many cards a "View all" uncovers. */
const REVEAL_MAX_STEPS = 3;

/**
 * The delay for the nth uncovered card, as a custom property.
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

/**
 * One category section: a heading, the first `CATEGORY_ROW_CAP` cards, and a
 * "View all" that expands the section **in place**.
 *
 * Two rules this encodes, both learned the hard way:
 *
 * **No `‹ ›` paging, and no carousel.** Arrows made the user operate the
 * section to see it — one keypress per two rows through 26 productivity apps —
 * and a horizontally scrolling row would hide cards behind a gesture and break
 * the grid's column rhythm. Expansion shows everything at once and needs no
 * state the user has to keep in their head.
 *
 * **Expansion is local state, not a filter.** "View all" used to set the
 * page's shared `category`, which flipped the whole page to a flat grid and
 * deleted every other section from the screen — asking for more of one
 * category took away all the others. The section owns `expanded` instead, so
 * nothing outside it changes. The category `Select` is still there for the
 * user who does want the page narrowed to one category; the two are separate
 * gestures now rather than one control quietly doing both.
 *
 * What "all" can honestly mean here: every entry loaded so far. Neither
 * catalogue API accepts a category, so there is no request that fetches "all
 * of Productivity" — scrolling loads more pages, and an expanded section grows
 * as they land.
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
}: {
  category: string;
  items: CatalogEntry[];
  connectedKeys: ReadonlySet<string>;
  onSelect: (entry: CatalogEntry) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const label = sectionTitle(category);
  const Icon = categoryIcon(category);
  const visible = expanded ? items : items.slice(0, CATEGORY_ROW_CAP);

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-muted-foreground flex items-center gap-1.5 text-sm font-medium">
          <Icon className="size-4" />
          {label}
        </h2>
        {items.length > CATEGORY_ROW_CAP ? (
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={expanded}
            aria-label={
              expanded ? `Show fewer ${label} connectors` : `View all ${label} connectors`
            }
            onClick={() => setExpanded((open) => !open)}
            // `size="sm"` is `h-8` — 29.44px at this repo's `--spacing: 0.23rem`,
            // under the 40px minimum hit area. `-inset-y-1.5` adds 5.52px top
            // and bottom for 40.48px. Vertical only: the label already makes
            // the control ~72px wide, and widening it would push the target
            // toward the heading it sits opposite.
            className="relative transition-transform duration-150 ease-out before:absolute before:-inset-y-1.5 before:content-[''] active:scale-[0.96]"
          >
            {expanded ? 'Show less' : 'View all'}
          </Button>
        ) : null}
      </div>
      <div className={GRID_CLASSNAME}>
        {visible.map((entry, index) => (
          <CatalogEntryCard
            key={entry.key}
            entry={entry}
            connectedKeys={connectedKeys}
            onSelect={onSelect}
            // Only cards past the cap animate, and those mount only when the
            // section is expanded (or when a later page adds to an
            // already-expanded one). The first `CATEGORY_ROW_CAP` are on
            // screen from first paint and must not animate there.
            reveal={index >= CATEGORY_ROW_CAP ? index - CATEGORY_ROW_CAP : null}
          />
        ))}
      </div>
    </section>
  );
}

/**
 * The catalogue body, in one of two shapes.
 *
 * `sectioned` (the Discovery tab) groups into capped category sections, Popular
 * first. `flat` (the All tab) is one grid.
 *
 * A text search always collapses to flat, in both modes: the search runs
 * server-side across the whole catalogue, so category headings would fragment
 * a result set the user asked to see as one list. Picking a category collapses
 * to flat for the same reason — the heading would restate the filter.
 *
 * Section headings deliberately carry **no counts**. A heading reading
 * "Productivity 26" would describe the pages that happen to be loaded, not the
 * catalogue — with 5,758 items behind a 48-per-page cursor it would be a lie
 * that gets worse the more the user loads.
 *
 * **The catalogue does not paginate, by either gesture.** There is no "Load
 * more" button and no scroll auto-load; both were tried on this page and both
 * were rejected. What is left is deliberate rather than unfinished: browsing
 * shows the first page as curated sections, and SEARCH is what reaches the
 * rest — it runs server-side across the whole catalogue, so it is the only
 * affordance here that ever sees all 5,758 items. Paging a browse surface only
 * ever grew the same sections taller.
 *
 * The one thing that would be dishonest is saying nothing, so the foot of the
 * page states what is on screen against what exists and points at search.
 */
export function ConnectorBrowse({
  state,
  connectedKeys,
  mode,
  category,
  availableCategories,
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
  /** From `catalogCategoryKeys`, the same list the `Select` is built from. A
   *  `category` missing from it is stale and gets dropped rather than applied
   *  to a set that no longer contains it. */
  availableCategories: readonly string[];
  onSelect: (entry: CatalogEntry) => void;
  emptyTitle: string;
  emptyDescription: string;
}) {
  const { activeQuery, entries, total } = state;
  const searching = activeQuery.length > 0;
  // Derived, never taken at face value. A picked category outlives a search
  // (during which the `Select` is hidden) and outlives the entry set that
  // produced it (a refetch, or `useCatalog` swapping source and with it the
  // whole category vocabulary). Resolving against the list the dropdown shows
  // means the grid and that dropdown cannot disagree about what is applied.
  const activeCategory = resolveActiveCategory(category, availableCategories, { searching });

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
  const isEmpty = showSections ? sections.length === 0 : flat.length === 0;

  // Loading, error and "nothing to show" are `CatalogGrid`'s contract in its
  // documented order; only the *content* branch differs between the sectioned
  // and flat shapes, so those three states are delegated here and the grid
  // gets no children it could render.
  if (state.isLoading || state.isError || isEmpty) {
    return (
      <CatalogGrid
        isLoading={state.isLoading}
        isError={state.isError}
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
      {showSections ? (
        sections.map((section) => (
          <CategorySection
            key={section.category}
            category={section.category}
            items={section.items}
            connectedKeys={connectedKeys}
            onSelect={onSelect}
          />
        ))
      ) : (
        <div className={GRID_CLASSNAME}>
          {flat.map((entry) => (
            <CatalogEntryCard
              key={entry.key}
              entry={entry}
              connectedKeys={connectedKeys}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}

      {/* What is on screen, against what exists. Without pagination the grid
          simply stops, and a page that ends at 48 of 5,758 with no remark
          reads as a catalogue of 48 — so this line is the replacement for the
          control that was removed, not decoration left behind by it.

          Three things disqualify it, each because the ratio would stop being
          exact:
            - a picked category (the grid is a client-side slice of the loaded
              page, so the loaded count overstates what is on screen),
            - Easy Connect, whose paged response carries no true total, so
              `total` there is just the loaded count,
            - a loaded count that already equals the total, where there is
              nothing to say.
          `tabular-nums` because these are quantities read against each other. */}
      {activeCategory === ALL_CATEGORIES &&
      state.source === 'discover' &&
      entries.length < total ? (
        <p className="text-muted-foreground/70 pt-2 text-center text-xs">
          Showing <span className="tabular-nums">{entries.length.toLocaleString()}</span> of{' '}
          <span className="tabular-nums">{total.toLocaleString()}</span>. Search to reach the rest.
        </p>
      ) : null}
    </div>
  );
}
