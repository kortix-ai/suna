'use client';

import { GithubLogoIcon, MagnifyingGlassIcon, PlusIcon, SparkleIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { listConnectors, type Subproject } from '@kortix/sdk';
import { qk, useProjectSubprojects, useSubprojects } from '@kortix/sdk/react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { InfoBanner } from '@/components/ui/info-banner';
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
import { SubprojectCard } from './subprojects-card';
import { countLabel, subprojectMatchesQuery } from './subprojects-catalog';

/**
 * The project-scoped subprojects store — the **Marketplace** capability tab at
 * `/projects/[id]/customize/marketplace`. (`/projects/[id]/subprojects`
 * redirects here.)
 *
 * One page, one job: browse the catalog and install. It used to open with an
 * "Installed · N" list carrying each subproject's run counts, a link to its run
 * report and an on/off switch over its triggers. All three are gone. A
 * marketplace is where you get things, not where you operate them: enabling an
 * individual trigger already belongs to the Triggers capability page, and run
 * monitoring is not a subproject-scoped surface at all. What survives of the
 * installed state is the per-card `Installed` pill and the All/Installed/
 * Available filter — enough to answer "do I already have this?" without turning
 * the page into a console.
 *
 * Two things that list DID own had to land somewhere:
 *  - **Uninstall** moved into {@link SubprojectInstallModal}. That modal already
 *    shows what a subproject brings in, so it is where a person can judge what
 *    removing it takes out.
 *  - **The unreadable-manifest banner** stayed here. It is a diagnostic, not an
 *    operating control, and it cannot live on a card: a subproject the API could
 *    not parse has no card.
 *
 * It draws its own header rather than using `CapabilityPageShell` because the
 * `+ Add` control sits INLINE with search and the All/Installed/Available
 * filter, not stacked above them the way the shell's own header renders its
 * action slot. What it DOES borrow from the shell is every container and type
 * token: the `min-h-0 flex-1 overflow-y-auto` scroll root, `max-w-5xl`, the
 * `py-10 pb-20 lg:py-14` block, and `text-xl font-medium` on the `h1`. Those
 * are what a person compares when they switch tabs, so they match exactly.
 *
 * `+ Add` replaced a "Make your own" section (two dashed cards, always on
 * screen below the catalog) that used to own this job. Same two destinations —
 * `AddSubprojectModal` (index something that exists) and
 * `AuthorSubprojectModal` (describe one and have it built) — collapsed into one
 * menu next to the thing it adds to, instead of permanent real estate under a
 * catalog that is the actual reason someone opened this page.
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

  /** Installed subprojects whose manifest would not parse. */
  const errors = installedQuery.data?.errors ?? [];

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

        {/* A subproject whose manifest will not parse. This is the one piece of
            installed state that has to stay on the page: it is a diagnostic, not
            an operating control, and the card grid cannot show it — a subproject
            the API could not read has no card to carry the message. It sits above
            the catalog because it explains why the catalog may be short. */}
        {errors.length > 0 ? (
          <InfoBanner tone="warning" title="Some subprojects could not be read">
            {errors.map((entry) => (
              <span key={entry.slug} className="block">
                <span className="font-mono">{entry.slug}</span>: {entry.error}
              </span>
            ))}
          </InfoBanner>
        ) : null}

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

            {/* The two doors "Make your own" used to render as permanent dashed
              cards. They are genuinely different (index something that EXISTS
              vs. have one built), so a menu, not a single button with a mode
              switch buried inside it. */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" className="ml-auto">
                  <PlusIcon className="size-4" aria-hidden />
                  Add
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuItem
                  onSelect={() => setAdding(true)}
                  className="flex items-start gap-2.5 py-2"
                >
                  <GithubLogoIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
                  <span className="min-w-0">
                    <span className="block text-sm">Add from GitHub</span>
                    <span className="text-muted-foreground block text-xs">
                      Point at a repo, or upload a .zip.
                    </span>
                  </span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => setAuthoring(true)}
                  className="flex items-start gap-2.5 py-2"
                >
                  <SparkleIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
                  <span className="min-w-0">
                    <span className="block text-sm">Grow your own</span>
                    <span className="text-muted-foreground block text-xs">
                      Describe a subproject and Kortix builds it.
                    </span>
                  </span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
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

        <AddSubprojectModal open={adding} onOpenChange={setAdding} />
        <AuthorSubprojectModal projectId={projectId} open={authoring} onOpenChange={setAuthoring} />

        {open ? (
          <SubprojectInstallModal
            subproject={open}
            projectId={projectId}
            installed={installedSlugs.has(open.slug)}
            connectedApps={connectedApps}
            installing={installedQuery.install.isPending}
            uninstalling={installedQuery.uninstall.isPending}
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
            onUninstall={async (slug) => {
              try {
                const result = await installedQuery.uninstall.mutateAsync(slug);
                return result.session_id;
              } catch (error) {
                errorToast(
                  error instanceof Error ? error.message : 'Could not start the uninstall session',
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
