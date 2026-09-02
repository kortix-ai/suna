'use client';

import { MagnifyingGlassIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { listConnectors, type Subproject } from '@kortix/sdk';
import { qk, useProjectSubprojects, useSubprojects } from '@kortix/sdk/react';

import { Button } from '@/components/ui/button';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsListCompact, TabsTriggerCompact } from '@/components/ui/tabs';
import { errorToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { cn } from '@/lib/utils';
import { AddSubprojectModal } from './add-subproject-modal';
import { AuthorSubprojectModal } from './author-subproject-modal';
import { SubprojectInstallModal } from './install-modal';
import { InstalledSubprojects } from './installed-subprojects';
import { SubprojectBuildCard, SubprojectCard } from './subprojects-card';
import { countLabel, subprojectMatchesQuery } from './subprojects-catalog';

/**
 * The project-scoped subprojects store — the **Marketplace** capability tab at
 * `/projects/[id]/marketplace`. (`/projects/[id]/subprojects` redirects here.)
 *
 * It draws its own header rather than using `CapabilityPageShell`, because the
 * shell renders search and filters ABOVE its children and this page's first
 * section is `InstalledSubprojects` — a search box over that list, filtering
 * only the catalog below it, is a control that appears to do something it does
 * not. What it DOES borrow from the shell is every container and type token:
 * the `min-h-0 flex-1 overflow-y-auto` scroll root, `max-w-5xl`, the
 * `py-10 pb-20 lg:py-14` block, and `text-xl font-medium` on the `h1`. Those
 * are what a person compares when they switch tabs, so they match exactly.
 * `space-y-8` is the one departure from the shell's `space-y-5`: this body is
 * three sections each under its own heading, not a header over one list.
 *
 * Reads the real index through `useSubprojects()` and the project's installed set
 * through `useProjectSubprojects()`. The two are separate on purpose: the index is
 * account-global, an install is per-project, and the same subproject is installed in
 * one project and not another.
 *
 * Search filters CLIENT-SIDE over the loaded page rather than refetching per
 * keystroke. The store is a few dozen subprojects, the SDK's `q` parameter exists for
 * when it is not, and a debounced round trip per character buys nothing at this
 * size while costing the instant feel.
 */
/** Which slice of the catalog the grid shows. */
type SubprojectFilter = 'all' | 'installed' | 'available';

export function SubprojectsStore({ projectId }: { projectId: string }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<SubprojectFilter>('all');
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [authoring, setAuthoring] = useState(false);

  const store = useSubprojects();
  const installedQuery = useProjectSubprojects(projectId);
  // `?? []` inline would be a fresh array each render, which changes every
  // useMemo below that depends on it. Memoized on the query payload instead.
  const subprojects: Subproject[] = useMemo(() => store.data?.subprojects ?? [], [store.data]);

  /** Slugs this project has, so the card can show the pill and skip Install. */
  const installedSlugs = useMemo(
    () => new Set((installedQuery.data?.subprojects ?? []).map((entry) => entry.slug)),
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
      // slug both sides share: a subproject's connector entry names the connector
      // the project ends up with. `SubprojectConnectors` also tries the toolkit id.
      set.add(connector.slug.toLowerCase());
    }
    return set;
  }, [connectors.data]);

  const open = subprojects.find((subproject) => subproject.subproject_id === openId) ?? null;

  /**
   * Search and the installed filter compose — both narrow the same list.
   *
   * `installedSlugs` is the join, not a field on the subproject: the index row is
   * account-global, so the same subproject is installed in one project and not
   * another.
   */
  const filtered = useMemo(
    () =>
      subprojects.filter((subproject) => {
        if (!subprojectMatchesQuery(subproject, query)) return false;
        if (filter === 'installed') return installedSlugs.has(subproject.slug);
        if (filter === 'available') return !installedSlugs.has(subproject.slug);
        return true;
      }),
    [subprojects, query, filter, installedSlugs],
  );

  /** Counts for the tab labels, over the whole catalog rather than the search. */
  const counts = useMemo(() => {
    const installed = subprojects.filter((subproject) =>
      installedSlugs.has(subproject.slug),
    ).length;
    return { all: subprojects.length, installed, available: subprojects.length - installed };
  }, [subprojects, installedSlugs]);

  /**
   * The filter appears only once something IS installed.
   *
   * With nothing installed the three tabs read `All 9 / Installed 0 /
   * Available 9` — two of them identical and one dead, which is chrome that
   * teaches nothing. `installedQuery.isLoading` keeps it from flickering in
   * after the grid has already painted.
   */
  const showFilter = !installedQuery.isLoading && counts.installed > 0;
  const FILTERS: ReadonlyArray<{ key: SubprojectFilter; label: string }> = [
    { key: 'all', label: `All ${counts.all}` },
    { key: 'installed', label: `Installed ${counts.installed}` },
    { key: 'available', label: `Available ${counts.available}` },
  ];

  return (
    /* The scroll container. The `(capabilities)` layout is `overflow-hidden`,
       so a page without one of these does not scroll at all — its overflow is
       clipped and the bottom of the catalog is unreachable. */
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div
        data-subprojects-store
        className="mx-auto w-full max-w-5xl space-y-8 px-4 py-10 pb-20 lg:py-14"
      >
        <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            {/* "Marketplace" is the tab's label, so the page says it too — a tab
              whose heading names something else reads as a mis-click. The
              product noun still has to be taught, so the sentence below carries
              it. */}
            <h1 className="text-foreground text-xl font-medium text-balance">Marketplace</h1>
            <p className="text-muted-foreground text-sm text-balance">
              Install a subproject — a whole working setup of agents, skills, connectors and
              triggers — from an open-source repo.
            </p>
          </div>
          {store.isLoading ? null : (
            <p className="text-muted-foreground shrink-0 text-sm tabular-nums">
              {filtered.length} of {countLabel(subprojects.length, 'subproject')}
            </p>
          )}
        </header>

        {/* What this project already has, above the catalog: someone arriving here
          is far more often checking on their own subprojects than shopping. */}
        <InstalledSubprojects projectId={projectId} />

        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <InputGroupSearch className="sm:max-w-xs">
              <InputGroupSearchIcon>
                <MagnifyingGlassIcon />
              </InputGroupSearchIcon>
              <InputGroupSearchInput
                variant="popover"
                placeholder="Search subprojects"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <InputGroupSearchClear
                onClick={() => setQuery('')}
                className={cn(!query && 'pointer-events-none opacity-0')}
              />
            </InputGroupSearch>

            {showFilter ? (
              <Tabs value={filter} onValueChange={(next) => setFilter(next as SubprojectFilter)}>
                <TabsListCompact aria-label="Filter subprojects by whether this project has them">
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
              title="Could not load subprojects"
              description={store.error instanceof Error ? store.error.message : undefined}
              action={
                <Button variant="outline" size="sm" onClick={() => void store.refetch()}>
                  Retry
                </Button>
              }
            />
          ) : filtered.length === 0 ? (
            // The description has to name the reason, or "No subprojects match" on a
            // full catalog reads as "the store is broken" when the real cause is
            // an Installed filter with a search on top of it.
            <EmptyState
              size="sm"
              title={
                filter === 'installed'
                  ? 'No installed subproject matches'
                  : filter === 'available'
                    ? 'No available subproject matches'
                    : query
                      ? 'No subprojects match'
                      : 'No subprojects yet'
              }
              description={
                filter !== 'all'
                  ? query
                    ? 'Clear the search, or switch to All.'
                    : 'Switch to All to see the whole catalog.'
                  : query
                    ? 'Clear the search to see every subproject.'
                    : 'Add one from a GitHub repo or a .zip, or describe what you want built.'
              }
            />
          ) : (
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {filtered.map((subproject) => (
                <li key={subproject.subproject_id}>
                  <SubprojectCard
                    subproject={subproject}
                    installed={installedSlugs.has(subproject.slug)}
                    onOpen={() => setOpenId(subproject.subproject_id)}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>

        <section className="space-y-3">
          <h2 className="text-foreground text-sm font-medium">Make your own</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {/* Two doors, and they are genuinely different: one indexes a subproject
              that EXISTS, the other has one built. Collapsing them into one
              button would put a mode switch in front of both. */}
            <SubprojectBuildCard onClick={() => setAuthoring(true)} />
            <SubprojectBuildCard variant="add" onClick={() => setAdding(true)} />
          </div>
        </section>

        <AddSubprojectModal open={adding} onOpenChange={setAdding} />
        <AuthorSubprojectModal projectId={projectId} open={authoring} onOpenChange={setAuthoring} />

        {open ? (
          <SubprojectInstallModal
            subproject={open}
            projectId={projectId}
            installed={installedSlugs.has(open.slug)}
            connectedApps={connectedApps}
            installing={installedQuery.install.isPending}
            onInstall={async (subprojectId) => {
              try {
                const result = await installedQuery.install.mutateAsync(subprojectId);
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
    </div>
  );
}
