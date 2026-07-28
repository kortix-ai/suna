'use client';

/**
 * Connectors — the catalogue screen.
 *
 * Replaces the 288px rail + detail pane that used to be the whole section. The
 * rail's four jobs all still exist, in the page header instead: its search is
 * the header search, its "Add app" button is the primary action, and "Global
 * rules" and "Sync from repo" are the two items in the overflow menu. Its list
 * of connectors is the grid's Connected group.
 *
 * Selection still lives in `?c=` — `?c=<slug>`, `?c=global`, `?c=add` open the
 * existing detail panes untouched. No `?c=` at all is this catalogue, which is
 * why the section now has a landing page rather than auto-selecting whichever
 * connector happened to sort first.
 *
 *
 */

import {
  createConnector,
  getConnectStatus,
  listConnectors,
  listPipedreamApps,
  syncConnectors,
} from '@kortix/sdk';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MoreHorizontal, Plug, Plus, RefreshCw, ShieldCheck } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import Loading from '@/components/ui/loading';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { errorToast, successToast, warningToast } from '@/components/ui/toast';
import {
  ProjectSectionPage,
  type ProjectSectionState,
} from '@/features/workspace/project-section/project-section-page';
import { isConnectorsEnabled } from '@/lib/config';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';

import {
  CATALOGUE_PILLS,
  type CatalogueEntry,
  type CataloguePill,
  buildCatalogueEntries,
  catalogueCategories,
  filterCatalogue,
  groupCatalogue,
} from './connector-catalogue';
import { ConnectorCatalogueGrid, ConnectorCatalogueGroups } from './connector-catalogue-grid';

/** Slack ships as a built-in channel, so it never appears as a catalogue app. */
const BUILT_IN_CHANNEL_APP_SLUGS = new Set(['slack', 'slack_v2']);

const ALL_CATEGORIES = '__all__';

function useDebounced(value: string, delay = 300): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export interface ConnectorsCatalogueProps {
  projectId: string;
  /** The persistent section tab strip, forwarded to the shared shell. */
  navTabs?: ReactNode;
  /** Open one of the existing detail panes: a slug, "global" or "add". */
  onSelect: (key: string) => void;
}

export function ConnectorsCatalogue({ projectId, navTabs, onSelect }: ConnectorsCatalogueProps) {
  const queryClient = useQueryClient();
  const connectorsKey = useMemo(() => ['project-connectors', projectId], [projectId]);
  const [query, setQuery] = useState('');
  const [pill, setPill] = useState<CataloguePill>('discover');
  const [category, setCategory] = useState(ALL_CATEGORIES);
  const debouncedQuery = useDebounced(query);

  const canWrite =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE).allowed === true;
  const canRead = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_READ);

  const connectorsQuery = useQuery({
    queryKey: connectorsKey,
    queryFn: () => listConnectors(projectId),
    staleTime: 10_000,
  });

  // Self-host without Pipedream configured: the catalogue half is simply
  // absent, and the screen falls back to whatever the project already has.
  const connectorsEnabled = isConnectorsEnabled();
  const connectStatus = useQuery({
    queryKey: ['connect-status'],
    queryFn: getConnectStatus,
    staleTime: 5 * 60_000,
    enabled: connectorsEnabled,
  });
  const catalogueAvailable = connectorsEnabled && connectStatus.data?.configured === true;

  const appsQuery = useInfiniteQuery({
    queryKey: ['easy-connect-apps', projectId, debouncedQuery],
    queryFn: ({ pageParam }) =>
      listPipedreamApps(projectId, debouncedQuery || undefined, pageParam as string | undefined),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.hasMore ? last.nextCursor : undefined),
    staleTime: 60_000,
    enabled: catalogueAvailable,
  });

  const connectors = useMemo(() => connectorsQuery.data?.connectors ?? [], [connectorsQuery.data]);
  const apps = useMemo(
    () =>
      (appsQuery.data?.pages ?? [])
        .flatMap((page) => page.apps)
        .filter((app) => !BUILT_IN_CHANNEL_APP_SLUGS.has(app.slug)),
    [appsQuery.data],
  );

  const entries = useMemo(() => buildCatalogueEntries({ connectors, apps }), [connectors, apps]);
  const categories = useMemo(() => catalogueCategories(entries), [entries]);
  const activeCategory = category === ALL_CATEGORIES ? '' : category;
  const filtered = useMemo(
    () => filterCatalogue(entries, { query, pill, category: activeCategory }),
    [entries, query, pill, activeCategory],
  );

  // Grouping only survives an unfiltered Discover view: once you search or pick
  // a category the sections would each collapse to one or two cards, which
  // reads as noise rather than structure.
  const grouped = pill === 'discover' && !query.trim() && !activeCategory;
  const groups = useMemo(() => (grouped ? groupCatalogue(filtered) : []), [grouped, filtered]);

  const addApp = useMutation({
    mutationFn: (entry: CatalogueEntry) =>
      createConnector(projectId, {
        slug: entry.slug,
        provider: 'pipedream',
        app: entry.slug,
        account: 'default',
      }).then(() => entry),
    onSuccess: (entry) => {
      successToast(`Added ${entry.name} — connect it to authorize`);
      void queryClient.invalidateQueries({ queryKey: connectorsKey });
      onSelect(entry.slug);
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to add'),
  });

  const sync = useMutation({
    mutationFn: () => syncConnectors(projectId),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: connectorsKey });
      if (res.errors.length) warningToast(`Synced ${res.synced}, ${res.errors.length} with issues`);
      else successToast(`Synced ${res.synced} connector(s)`);
    },
    onError: (err: Error) => errorToast(err.message || 'Sync failed'),
  });

  const forbidden =
    (connectorsQuery.isError &&
      /403|forbidden/i.test((connectorsQuery.error as Error)?.message ?? '')) ||
    (canRead.allowed === false && !canRead.isLoading);

  const state: ProjectSectionState = (() => {
    if (forbidden) return 'forbidden';
    if (connectorsQuery.isLoading || (catalogueAvailable && appsQuery.isLoading)) return 'loading';
    if (connectorsQuery.isError) return 'error';
    if (entries.length === 0) return 'empty';
    if (filtered.length === 0) return 'no-results';
    return 'ready';
  })();

  const addAction = canWrite ? (
    <Button type="button" size="sm" onClick={() => onSelect('add')}>
      <Plus className="size-4" />
      Add connector
    </Button>
  ) : null;

  return (
    <ProjectSectionPage
      navTabs={navTabs}
      title="Connectors"
      description="Connect the tools your agent is allowed to act in."
      width="wide"
      search={{ value: query, onChange: setQuery, placeholder: 'Search all connectors' }}
      action={
        <div className="flex items-center gap-2">
          {addAction}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" size="icon" variant="outline" aria-label="More connector tools">
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => onSelect('global')}>
                <ShieldCheck className="size-4" />
                Global rules
              </DropdownMenuItem>
              {canWrite ? (
                <DropdownMenuItem
                  disabled={sync.isPending}
                  onSelect={(event) => {
                    event.preventDefault();
                    sync.mutate();
                  }}
                >
                  {sync.isPending ? (
                    <Loading className="size-4 shrink-0" />
                  ) : (
                    <RefreshCw className="size-4" />
                  )}
                  Sync from repo
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      }
      filters={
        <>
          <div className="flex items-center gap-1">
            {CATALOGUE_PILLS.map((option) => (
              <Button
                key={option.id}
                type="button"
                size="sm"
                variant={pill === option.id ? 'secondary' : 'ghost'}
                onClick={() => setPill(option.id)}
                className="rounded-full"
              >
                {option.label}
              </Button>
            ))}
          </div>
          {categories.length > 0 ? (
            <div className="ml-auto">
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger size="sm" className="w-44" aria-label="Filter by category">
                  <SelectValue placeholder="All categories" />
                </SelectTrigger>
                <SelectContent align="end">
                  <SelectItem value={ALL_CATEGORIES}>All categories</SelectItem>
                  {categories.map((name) => (
                    <SelectItem key={name} value={name}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
        </>
      }
      state={state}
      forbiddenMessage="Only project members with connector access can see this."
      errorProps={{
        title: 'Could not load connectors',
        description:
          connectorsQuery.error instanceof Error
            ? connectorsQuery.error.message
            : 'Could not load connectors.',
        action: (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => connectorsQuery.refetch()}
          >
            Retry
          </Button>
        ),
      }}
      emptyProps={{
        icon: Plug,
        title: 'No connectors yet',
        description: canWrite
          ? 'Add a tool your agent may act in — an app, a channel, or your own API.'
          : 'You have read-only access. Ask a project manager to add one.',
        action: addAction ?? undefined,
      }}
      noResultsMessage="No connectors match that search."
    >
      {grouped ? (
        <ConnectorCatalogueGroups
          groups={groups}
          onOpen={onSelect}
          onAdd={canWrite ? (entry) => addApp.mutate(entry) : undefined}
          pendingSlug={addApp.isPending ? addApp.variables?.slug : null}
        />
      ) : (
        <ConnectorCatalogueGrid
          entries={filtered}
          onOpen={onSelect}
          onAdd={canWrite ? (entry) => addApp.mutate(entry) : undefined}
          pendingSlug={addApp.isPending ? addApp.variables?.slug : null}
        />
      )}

      {pill !== 'connected' && appsQuery.hasNextPage ? (
        <div className="flex justify-center pt-6">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9 px-8"
            disabled={appsQuery.isFetchingNextPage}
            onClick={() => appsQuery.fetchNextPage()}
          >
            {appsQuery.isFetchingNextPage ? <Loading className="size-4 shrink-0" /> : null}
            Load more
          </Button>
        </div>
      ) : null}
    </ProjectSectionPage>
  );
}

export default ConnectorsCatalogue;
