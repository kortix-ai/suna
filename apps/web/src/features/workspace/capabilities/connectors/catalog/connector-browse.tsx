'use client';

import { useTranslations } from '@/i18n/use-translations';
import { CaretDownIcon, GlobeIcon, MonitorIcon } from '@phosphor-icons/react';
import type { AdminConnector } from '@kortix/sdk';
import { useRouter } from 'next/navigation';
import { memo } from 'react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import Loading from '@/components/ui/loading';
import { EmptyState } from '@/features/layout/section/empty-state';

import { CatalogCard } from '@/features/workspace/capabilities/shared/catalog/catalog-card';
import { CatalogNoMatch } from '@/features/workspace/capabilities/shared/catalog/catalog-empty-state';
import {
  CatalogCardSkeleton,
  CatalogGrid,
} from '@/features/workspace/capabilities/shared/catalog/catalog-grid';
import { DENSE_GRID_CLASSNAME } from '@/features/workspace/capabilities/shared/catalog/catalog-grid-tokens';
import { cn } from '@/lib/utils';
import { catalogEntryConnectors, catalogEntryKindLabel, type CatalogEntry } from './catalog-entry';
import { catalogFootSummary } from './catalog-foot';
import type { CatalogState } from './use-catalog';
import { useCatalogAutoload } from './use-catalog-autoload';

/**
 * The card's one action: Install, with its scope decided up front (the Clerk
 * reference). The button is ALWAYS present — installed state lives inside the
 * menu, where the done scope reads "Installed" and disables while the other
 * stays one click away.
 */
function CatalogAffordance({
  entry,
  connectors,
  installHref,
}: {
  entry: CatalogEntry;
  connectors: readonly AdminConnector[];
  installHref: string;
}) {
  const router = useRouter();
  // Which scopes this entry is ALREADY installed for. The button never
  // disappears (the Clerk reference): an installed scope just reads
  // "Installed" and disables; the other stays one click away. Adding another
  // of an installed scope remains possible from the app page.
  const matches = catalogEntryConnectors(connectors, entry);
  const projectInstalled = matches.some((match) => match.authorizationStrategy === 'project');
  const userInstalled = matches.some((match) => match.authorizationStrategy === 'user');
  const installedHint = (
    <span className="text-muted-foreground ml-auto pl-4 text-xs">Installed</span>
  );
  // `installHref` may already carry `?src=` (easy-connect / computer apps).
  const installWith = (scope: 'project' | 'me') =>
    `${installHref}${installHref.includes('?') ? '&' : '?'}add=1&for=${scope}`;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline" className="gap-1 rounded-full" data-testid="catalog-add">
          Install
          <CaretDownIcon className="size-3.5 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          disabled={projectInstalled}
          onClick={() => router.push(installWith('project'))}
        >
          For the whole project
          {projectInstalled ? installedHint : null}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={userInstalled}
          onClick={() => router.push(installWith('me'))}
        >
          Just for me
          {userInstalled ? installedHint : null}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
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
  connectors,
  getHref,
}: {
  entry: CatalogEntry;
  connectors: readonly AdminConnector[];
  getHref: (entry: CatalogEntry) => string;
}) {
  return (
    // Minimal card by request: icon and title on the bare page — no border,
    // no description. The one thing worth a mark is the promoted kind
    // (COR-17), emphasized on its own row under the title; every other kind
    // stays unlabelled — a chip on every card is a taxonomy, not a signal.
    <CatalogCard
      variant="plain"
      leading={<ConnectorIcon icon={entry.icon} computer={entry.source === 'computer'} />}
      title={entry.name}
      subtitle={
        // Plain muted text, per the reference card ("1 MCP") — a quiet fact
        // line on EVERY card: how the entry connects.
        <span className="text-muted-foreground text-xs">{catalogEntryKindLabel(entry)}</span>
      }
      trailing={
        <CatalogAffordance entry={entry} connectors={connectors} installHref={getHref(entry)} />
      }
      trailingInteractive
      href={getHref(entry)}
    />
  );
});

/** Skeletons appended to a growing grid while a request is in flight. Six —
 *  two full rows of the widest layout — so the placeholder block is the same
 *  shape as the batch about to replace it. */
const LOADING_MORE_SKELETONS = 6;

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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
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
          className="transition-transform duration-normal ease-out active:scale-[0.96]"
        >
          {tI18nComplete.raw('textac8991ef0101')}
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
 * The catalogue body: one flat, paginated, searchable grid.
 *
 * The sectioned browse shape (the Discovery tab's curated category slices)
 * was removed with that tab (2026-09-13, Jay) — the dense grid plus
 * server-side search covers the same ground without a second presentation of
 * the same list.
 *
 * **One paging mechanism.** Scrolling to the foot fetches the next page, and so
 * does the button beside it. Nothing else fetches: no eager first-paint budget,
 * no per-category deepening loop, no reveal window uncovering already-loaded
 * cards. Those existed to let the client fake a category filter, and the server
 * performs it now.
 */
export function ConnectorBrowse({
  state,
  connectors,
  getHref,
  emptyTitle,
  emptyDescription,
}: {
  state: CatalogState;
  connectors: readonly AdminConnector[];
  getHref: (entry: CatalogEntry) => string;
  emptyTitle: string;
  emptyDescription: string;
}) {
  const { activeQuery, entries, total } = state;
  const searching = activeQuery.length > 0;

  const hasMore = state.hasMore;
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

  const isEmpty = entries.length === 0;

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

  const summary = catalogFootSummary({
    shown: entries.length,
    loaded: entries.length,
    total,
    categoryLabel: null,
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
        'space-y-6 transition-opacity duration-normal ease-out',
        state.isRefreshing && 'pointer-events-none opacity-60',
      )}
    >
      <div className={DENSE_GRID_CLASSNAME}>
        {entries.map((entry) => (
          <CatalogEntryCard
            key={entry.key}
            entry={entry}
            connectors={connectors}
            getHref={getHref}
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
