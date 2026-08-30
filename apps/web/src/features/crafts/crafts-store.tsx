'use client';

import { MagnifyingGlassIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { listConnectors, type Craft } from '@kortix/sdk';
import { qk, useCrafts, useProjectCrafts } from '@kortix/sdk/react';

import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import { Tabs, TabsListCompact, TabsTriggerCompact } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { cn } from '@/lib/utils';
import { AddCraftModal } from './add-craft-modal';
import { AuthorCraftModal } from './author-craft-modal';
import { CraftBuildCard, CraftCard } from './crafts-card';
import { InstalledCrafts } from './installed-crafts';
import { countLabel, craftMatchesQuery } from './crafts-catalog';
import { CraftInstallModal } from './install-modal';

/**
 * The project-scoped crafts store (`/projects/[id]/crafts`).
 *
 * Reads the real index through `useCrafts()` and the project's installed set
 * through `useProjectCrafts()`. The two are separate on purpose: the index is
 * account-global, an install is per-project, and the same craft is installed in
 * one project and not another.
 *
 * Search filters CLIENT-SIDE over the loaded page rather than refetching per
 * keystroke. The store is a few dozen crafts, the SDK's `q` parameter exists for
 * when it is not, and a debounced round trip per character buys nothing at this
 * size while costing the instant feel.
 */
/** Which slice of the catalog the grid shows. */
type CraftFilter = 'all' | 'installed' | 'available';

export function CraftsStore({ projectId }: { projectId: string }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<CraftFilter>('all');
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [authoring, setAuthoring] = useState(false);

  const store = useCrafts();
  const installedQuery = useProjectCrafts(projectId);
  // `?? []` inline would be a fresh array each render, which changes every
  // useMemo below that depends on it. Memoized on the query payload instead.
  const crafts: Craft[] = useMemo(() => store.data?.crafts ?? [], [store.data]);

  /** Slugs this project has, so the card can show the pill and skip Install. */
  const installedSlugs = useMemo(
    () => new Set((installedQuery.data?.crafts ?? []).map((entry) => entry.slug)),
    [installedQuery.data],
  );

  // The apps the project already has connected, for the install modal's consent
  // panel. Its own query rather than a prop: the store does not otherwise need
  // connectors, and this must not delay the grid.
  const connectors = useQuery({
    queryKey: qk.project.connectors(projectId),
    queryFn: () => listConnectors(projectId),
    enabled: !!projectId,
  });
  const connectedApps = useMemo(() => {
    if (!connectors.data) return undefined;
    const set = new Set<string>();
    for (const connector of connectors.data.connectors ?? []) {
      // Only `active` counts. `needs_auth` and `error` mean the connector row
      // exists but cannot be used, which is exactly the state the install has
      // to resolve — marking it "Connected" would be the one wrong answer.
      if (connector.status !== 'active') continue;
      // `AdminConnector` carries no toolkit field, so the join is the manifest
      // slug both sides share: a craft's connector entry names the connector
      // the project ends up with. `CraftConnectors` also tries the toolkit id.
      set.add(connector.slug.toLowerCase());
    }
    return set;
  }, [connectors.data]);

  const open = crafts.find((craft) => craft.craft_id === openId) ?? null;

  /**
   * Search and the installed filter compose — both narrow the same list.
   *
   * `installedSlugs` is the join, not a field on the craft: the index row is
   * account-global, so the same craft is installed in one project and not
   * another.
   */
  const filtered = useMemo(
    () =>
      crafts.filter((craft) => {
        if (!craftMatchesQuery(craft, query)) return false;
        if (filter === 'installed') return installedSlugs.has(craft.slug);
        if (filter === 'available') return !installedSlugs.has(craft.slug);
        return true;
      }),
    [crafts, query, filter, installedSlugs],
  );

  /** Counts for the tab labels, over the whole catalog rather than the search. */
  const counts = useMemo(() => {
    const installed = crafts.filter((craft) => installedSlugs.has(craft.slug)).length;
    return { all: crafts.length, installed, available: crafts.length - installed };
  }, [crafts, installedSlugs]);

  /**
   * The filter appears only once something IS installed.
   *
   * With nothing installed the three tabs read `All 9 / Installed 0 /
   * Available 9` — two of them identical and one dead, which is chrome that
   * teaches nothing. `installedQuery.isLoading` keeps it from flickering in
   * after the grid has already painted.
   */
  const showFilter = !installedQuery.isLoading && counts.installed > 0;
  const FILTERS: ReadonlyArray<{ key: CraftFilter; label: string }> = [
    { key: 'all', label: `All ${counts.all}` },
    { key: 'installed', label: `Installed ${counts.installed}` },
    { key: 'available', label: `Available ${counts.available}` },
  ];

  return (
    <div data-crafts-store className="mx-auto w-full max-w-6xl space-y-8 px-4 pt-8 pb-16 sm:px-6">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-foreground text-2xl font-semibold tracking-tight">Crafts</h1>
          <p className="text-muted-foreground text-sm text-balance">
            Open-source crafts you can install into this project — pick one, install it, review what
            it delivers.
          </p>
        </div>
        {store.isLoading ? null : (
          <p className="text-muted-foreground shrink-0 text-sm tabular-nums">
            {filtered.length} of {countLabel(crafts.length, 'craft')}
          </p>
        )}
      </header>

      {/* What this project already has, above the catalog: someone arriving here
          is far more often checking on their own crafts than shopping. */}
      <InstalledCrafts projectId={projectId} />

      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <InputGroupSearch className="sm:max-w-xs">
            <InputGroupSearchIcon>
              <MagnifyingGlassIcon />
            </InputGroupSearchIcon>
            <InputGroupSearchInput
              variant="popover"
              placeholder="Search crafts"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <InputGroupSearchClear
              onClick={() => setQuery('')}
              className={cn(!query && 'pointer-events-none opacity-0')}
            />
          </InputGroupSearch>

          {showFilter ? (
            <Tabs value={filter} onValueChange={(next) => setFilter(next as CraftFilter)}>
              <TabsListCompact aria-label="Filter crafts by whether this project has them">
                {FILTERS.map((entry) => (
                  <TabsTriggerCompact key={entry.key} value={entry.key}>
                    {entry.label}
                  </TabsTriggerCompact>
                ))}
              </TabsListCompact>
            </Tabs>
          ) : null}
        </div>

        {store.isLoading ? (
          // Six skeletons at the card's own height, so the grid does not jump
          // when the response lands.
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }, (_, index) => (
              <li key={index}>
                <Skeleton className="h-[122px] w-full rounded-md" />
              </li>
            ))}
          </ul>
        ) : store.isError ? (
          <ErrorState
            size="sm"
            title="Could not load crafts"
            description={store.error instanceof Error ? store.error.message : undefined}
            action={
              <Button variant="outline" size="sm" onClick={() => void store.refetch()}>
                Retry
              </Button>
            }
          />
        ) : filtered.length === 0 ? (
          // The description has to name the reason, or "No crafts match" on a
          // full catalog reads as "the store is broken" when the real cause is
          // an Installed filter with a search on top of it.
          <EmptyState
            size="sm"
            title={
              filter === 'installed'
                ? 'No installed craft matches'
                : filter === 'available'
                  ? 'No available craft matches'
                  : query
                    ? 'No crafts match'
                    : 'No crafts yet'
            }
            description={
              filter !== 'all'
                ? query
                  ? 'Clear the search, or switch to All.'
                  : 'Switch to All to see the whole catalog.'
                : query
                  ? 'Clear the search to see every craft.'
                  : 'Add one from a GitHub repo or a .zip, or describe what you want built.'
            }
          />
        ) : (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {filtered.map((craft) => (
              <li key={craft.craft_id}>
                <CraftCard
                  craft={craft}
                  installed={installedSlugs.has(craft.slug)}
                  onOpen={() => setOpenId(craft.craft_id)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      <section className="space-y-3">
        <h2 className="text-foreground text-sm font-medium">Make your own</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {/* Two doors, and they are genuinely different: one indexes a craft
              that EXISTS, the other has one built. Collapsing them into one
              button would put a mode switch in front of both. */}
          <CraftBuildCard onClick={() => setAuthoring(true)} />
          <CraftBuildCard
            variant="add"
            onClick={() => setAdding(true)}
          />
        </div>
      </section>

      <AddCraftModal open={adding} onOpenChange={setAdding} />
      <AuthorCraftModal projectId={projectId} open={authoring} onOpenChange={setAuthoring} />

      {open ? (
        <CraftInstallModal
          craft={open}
          projectId={projectId}
          installed={installedSlugs.has(open.slug)}
          connectedApps={connectedApps}
          installing={installedQuery.install.isPending}
          onInstall={async (craftId) => {
            try {
              const result = await installedQuery.install.mutateAsync(craftId);
              return result.session_id;
            } catch (error) {
              errorToast(
                error instanceof Error ? error.message : 'Could not start the install session',
              );
              return null;
            }
          }}
          open
          onOpenChange={(next) => {
            if (!next) setOpenId(null);
          }}
        />
      ) : null}
    </div>
  );
}
