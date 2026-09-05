'use client';

import { MagnifyingGlassIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { listConnectors } from '@kortix/sdk';
import { qk, useMarketplaceInstall, useMarketplaceTemplates } from '@kortix/sdk/react';

import { Button } from '@/components/ui/button';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { cn } from '@/lib/utils';
import { TemplateInstallModal } from './install-modal';
import { TemplateCard } from './template-card';
import { type MarketplaceTemplate, countLabel, templateMatchesQuery } from './templates-catalog';

/**
 * The project-scoped marketplace — the **Marketplace** capability tab at
 * `/projects/[id]/customize/marketplace`.
 *
 * One page, one job: browse the catalog and install. There is no installed
 * list, no filter and no uninstall: an install is a change request the agent
 * opens, everything the template adds lands in that one commit, and reverting
 * it is the uninstall. A marketplace is where you get things, not where you
 * operate them — enabling a trigger belongs to the Triggers page.
 *
 * It draws its own header rather than using `CapabilityPageShell`, but borrows
 * every container and type token: the `min-h-0 flex-1 overflow-y-auto` scroll
 * root, `max-w-5xl`, the `py-10 pb-20 lg:py-14` block, and `text-xl
 * font-medium` on the `h1`. Those are what a person compares when they switch
 * tabs, so they match exactly.
 *
 * Search filters CLIENT-SIDE over the loaded catalog rather than refetching per
 * keystroke: the catalog is a handful of templates, and a round trip per
 * character buys nothing at this size while costing the instant feel.
 */
export function MarketplaceStore({ projectId }: { projectId: string }) {
  const [query, setQuery] = useState('');
  const [openSlug, setOpenSlug] = useState<string | null>(null);

  const catalog = useMarketplaceTemplates();
  const install = useMarketplaceInstall(projectId);
  // `?? []` inline would be a fresh array each render, which changes every
  // useMemo below that depends on it. Memoized on the query payload instead.
  const templates: MarketplaceTemplate[] = useMemo(
    () => catalog.data?.templates ?? [],
    [catalog.data],
  );

  // The apps the project already has connected, for the install modal's
  // consent panel. Its own query rather than a prop: the store does not
  // otherwise need connectors, and this must not delay the grid.
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
      set.add(connector.slug.toLowerCase());
    }
    return set;
  }, [connectors.data]);

  const open = templates.find((template) => template.slug === openSlug) ?? null;
  const filtered = useMemo(
    () => templates.filter((template) => templateMatchesQuery(template, query)),
    [templates, query],
  );

  return (
    /* The scroll container. The `(capabilities)` layout is `overflow-hidden`,
       so a page without one of these does not scroll at all. */
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div
        data-marketplace-store
        className="mx-auto w-full max-w-5xl space-y-8 px-4 py-10 pb-20 lg:py-14"
      >
        <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <h1 className="text-foreground text-xl font-medium text-balance">Marketplace</h1>
            <p className="text-muted-foreground text-sm text-balance">
              Install a template — a working setup of agents, skills, connectors and triggers — from
              an open-source repo.
            </p>
          </div>
          {catalog.isLoading ? null : (
            <p className="text-muted-foreground shrink-0 text-sm tabular-nums">
              {filtered.length} of {countLabel(templates.length, 'template')}
            </p>
          )}
        </header>

        <div className="space-y-4">
          <InputGroupSearch className="sm:max-w-xs">
            <InputGroupSearchIcon>
              <MagnifyingGlassIcon />
            </InputGroupSearchIcon>
            <InputGroupSearchInput
              variant="popover"
              placeholder="Search templates"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <InputGroupSearchClear
              onClick={() => setQuery('')}
              className={cn(!query && 'pointer-events-none opacity-0')}
            />
          </InputGroupSearch>

          {catalog.isLoading ? (
            // Six skeletons at the card's own height, so the grid does not jump
            // when the response lands.
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: 6 }, (_, index) => (
                <li key={index}>
                  <Skeleton className="h-[122px] w-full rounded-md" />
                </li>
              ))}
            </ul>
          ) : catalog.isError ? (
            <ErrorState
              size="sm"
              title="Could not load the marketplace"
              description={catalog.error instanceof Error ? catalog.error.message : undefined}
              action={
                <Button variant="outline" size="sm" onClick={() => void catalog.refetch()}>
                  Retry
                </Button>
              }
            />
          ) : filtered.length === 0 ? (
            <EmptyState
              size="sm"
              title={query ? 'No templates match' : 'No templates yet'}
              description={
                query
                  ? 'Clear the search to see every template.'
                  : 'The catalog is curated. Check back soon.'
              }
            />
          ) : (
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {filtered.map((template) => (
                <li key={template.slug}>
                  <TemplateCard template={template} onOpen={() => setOpenSlug(template.slug)} />
                </li>
              ))}
            </ul>
          )}
        </div>

        {open ? (
          <TemplateInstallModal
            template={open}
            projectId={projectId}
            connectedApps={connectedApps}
            installing={install.isPending}
            onInstall={async (slug) => {
              try {
                const result = await install.mutateAsync(slug);
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
              if (!next) setOpenSlug(null);
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
