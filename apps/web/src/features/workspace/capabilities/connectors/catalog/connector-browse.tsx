'use client';

import { useTranslations } from '@/i18n/use-translations';
import { GlobeIcon, MonitorIcon } from '@phosphor-icons/react';
import { memo } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { EmptyState } from '@/features/layout/section/empty-state';

import { CatalogCard } from '@/features/workspace/capabilities/shared/catalog/catalog-card';
import { CatalogNoMatch } from '@/features/workspace/capabilities/shared/catalog/catalog-empty-state';
import {
  CatalogCardSkeleton,
  CatalogGrid,
} from '@/features/workspace/capabilities/shared/catalog/catalog-grid';
import {
  DENSE_GRID_CLASSNAME,
  DENSE_GRID_CONTAINER_CLASSNAME,
} from '@/features/workspace/capabilities/shared/catalog/catalog-grid-tokens';
import { cn } from '@/lib/utils';
import type { InstallAudience } from '../install/install';
import { InstallMenu } from '../install/install-menu';
import { catalogEntryKindLabel, isCatalogEntryConnected, type CatalogEntry } from './catalog-entry';
import { catalogFootSummary } from './catalog-foot';
import type { CatalogState } from './use-catalog';
import { useCatalogAutoload } from './use-catalog-autoload';

/** Everything a catalogue card needs to run Install. One stable object per page. */
export interface CatalogInstall {
  /** The project's connector list has loaded. Until it has, an install cannot
   *  tell an app the project already has from a new one. */
  ready: boolean;
  canWrite: boolean;
  canShare: boolean;
  onlyYou: string;
  everyone: string;
  /** The app slug being installed, or `null`. */
  pendingKey: string | null;
  onInstall: (entry: CatalogEntry, audience: InstallAudience) => void;
}

/** The Install control is offered only where the caller may add the app, and
 *  never on the computer card: a computer is paired, not installed. */
function canInstallEntry(entry: CatalogEntry, install: CatalogInstall): boolean {
  return install.canWrite && entry.source !== 'computer';
}

/**
 * What a catalogue card offers on its right edge: "Added" when the project has
 * the app, the Install control when the caller may add it, nothing otherwise.
 *
 * The connected marker is a labelled badge, not a bare glyph. It was a 16px
 * green check in the trailing slot, which asked the user to decode a symbol
 * whose only context was its colour — reported as "the connected state is a
 * bit too hidden". A word costs one badge's width and needs no decoding.
 */
function CatalogAffordance({
  entry,
  connected,
  install,
}: {
  entry: CatalogEntry;
  connected: boolean;
  install: CatalogInstall;
}) {
  const t = useTranslations('connectorPages');
  if (connected) {
    return (
      <Badge variant="success" size="sm" data-testid="catalog-connected">
        {t('added')}
      </Badge>
    );
  }
  if (!canInstallEntry(entry, install)) return null;
  return (
    <InstallMenu
      label={t('install')}
      variant="outline"
      className="gap-1 rounded-full"
      // A page holds dozens of these; the name says which app each installs.
      aria-label={t('installNamed', { name: entry.name })}
      canShare={install.canShare}
      onlyYou={install.onlyYou}
      everyone={install.everyone}
      onInstall={(audience) => install.onInstall(entry, audience)}
      pending={install.pendingKey === entry.slug}
      // `pendingKey` holds one install. A second one started beside it would
      // clear the first one's pending state when it settles.
      disabled={!install.ready || install.pendingKey !== null}
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
 * One catalogue card: icon and title on the bare page — no border, no
 * description — with one quiet line under the title saying how the entry
 * connects.
 *
 * `memo`'d because the grid renders several hundred of these. `entry` and `connectedKeys` are referentially stable
 * across a page landing (the arrays they come from are rebuilt, but the entry
 * objects inside them are not), so the comparison actually pays off.
 * `hrefFor`, `onOpen` and `install` must be stable for the same reason;
 * `install` changes identity only when an install starts or ends.
 */
const CatalogEntryCard = memo(function CatalogEntryCard({
  entry,
  connectedKeys,
  hrefFor,
  onOpen,
  install,
}: {
  entry: CatalogEntry;
  connectedKeys: ReadonlySet<string>;
  hrefFor: (entry: CatalogEntry) => string | null;
  onOpen: (entry: CatalogEntry) => void;
  install: CatalogInstall;
}) {
  const href = hrefFor(entry);
  const connected = isCatalogEntryConnected(entry, connectedKeys);
  const shared = {
    variant: 'plain' as const,
    leading: <ConnectorIcon icon={entry.icon} computer={entry.source === 'computer'} />,
    title: entry.name,
    subtitle: <span className="text-muted-foreground text-xs">{catalogEntryKindLabel(entry)}</span>,
    trailing: <CatalogAffordance entry={entry} connected={connected} install={install} />,
  };
  // An entry with no page of its own (the computer card) opens in place.
  return href ? (
    // Only the Install control needs to sit beside the link. The "Added" badge
    // stays inside it, so a click on the badge still opens the page.
    <CatalogCard
      {...shared}
      href={href}
      trailingInteractive={!connected && canInstallEntry(entry, install)}
    />
  ) : (
    <CatalogCard {...shared} onClick={() => onOpen(entry)} />
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
          className="transition-transform duration-(--duration-normal) ease-out active:scale-[0.96]"
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
 * **One paging mechanism.** Scrolling to the foot fetches the next page, and so
 * does the button beside it. Nothing else fetches: no eager first-paint budget,
 * no per-category deepening loop, no reveal window uncovering already-loaded
 * cards.
 */
export function ConnectorBrowse({
  state,
  connectedKeys,
  hrefFor,
  onOpen,
  install,
  emptyTitle,
  emptyDescription,
}: {
  state: CatalogState;
  connectedKeys: ReadonlySet<string>;
  /** The card's page, or `null` for an entry that opens in place. */
  hrefFor: (entry: CatalogEntry) => string | null;
  onOpen: (entry: CatalogEntry) => void;
  install: CatalogInstall;
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
  // documented order, so those three states are delegated here and the grid
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
        'space-y-6 transition-opacity duration-(--duration-normal) ease-out',
        state.isRefreshing && 'pointer-events-none opacity-60',
      )}
    >
      <div className={DENSE_GRID_CONTAINER_CLASSNAME}>
        <div className={DENSE_GRID_CLASSNAME}>
          {entries.map((entry) => (
            <CatalogEntryCard
              key={entry.key}
              entry={entry}
              connectedKeys={connectedKeys}
              hrefFor={hrefFor}
              onOpen={onOpen}
              install={install}
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
