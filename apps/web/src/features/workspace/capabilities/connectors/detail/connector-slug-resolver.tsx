'use client';

import { listConnectors, listDiscoverConnectors, listPipedreamApps } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect } from 'react';

import { catalogAppForConnector } from '../catalog/catalog-entry';
import { appConnectorHref, catalogSourceFromSearch } from '../connector-routes';
import { isManagedConnectorProvider } from '../provider-label';
import { Skeleton } from '@/components/ui/skeleton';

import { CatalogConnectorPage } from './catalog-connector-page';
import { ConnectedConnectorPage } from './connected-connector-page';
import { ConnectorDetailSkeleton } from './connector-detail-layout';

/**
 * The resolver's loading state, shaped like its most likely destination: the
 * SPLIT view. Left column carries the app-page bars, the right column the
 * connector pane's — so the forward into `/connectors/<app>/<slug>` fills the
 * columns in place instead of swapping a centered page for a split one.
 * Below `lg` the pane column hides, matching the split view's own collapse.
 */
function SplitResolveSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 overflow-hidden" aria-busy>
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <ConnectorDetailSkeleton />
      </div>
      <div className="border-border hidden w-2/5 shrink-0 flex-col gap-4 border-l px-5 py-6 lg:flex">
        <div className="flex items-center gap-3">
          <Skeleton className="size-10 shrink-0 rounded-md" />
          <Skeleton className="h-5 w-40 max-w-full rounded-sm" />
        </div>
        <Skeleton className="h-14 rounded-md" />
        <div className="space-y-2">
          <Skeleton className="h-4 w-24 rounded-sm" />
          <Skeleton className="h-10 rounded-md" />
          <Skeleton className="h-10 rounded-md" />
        </div>
      </div>
    </div>
  );
}

/** Providers whose app lives in the Discover catalogue. Managed OAuth
 *  providers resolve against the Easy Connect catalogue instead; channels and
 *  computer profiles have no app page to pair with. */
const DISCOVER_PROVIDERS = new Set(['mcp', 'openapi', 'graphql', 'postman', 'http']);

/**
 * The queries worth trying against a catalogue whose search is
 * "item field CONTAINS query". A default-named connector is LONGER than its
 * app ("Canva MCP server" vs "Canva"), so searching the full name finds
 * nothing — the app's own token is a PREFIX of the connector's. Lead with
 * the first word of the name and the first slug segment; keep the full
 * strings as a fallback for apps whose names are multiword.
 */
export function appResolutionQueries(record: { slug: string; name: string | null }): string[] {
  const name = record.name?.trim() || record.slug;
  return [...new Set([name.split(/\s+/)[0], record.slug.split('-')[0], name, record.slug])].filter(
    (candidate) => candidate.length >= 3,
  );
}

/**
 * `/projects/[id]/connectors/[slug]` — ONE segment, two meanings, resolved by
 * what the project actually contains:
 *
 * - The slug names a PROJECT CONNECTOR → its page. If the connector's
 *   catalogue app is identifiable (the reverse of the "In this project"
 *   join), forward to `/connectors/<app>/<slug>` so it opens in the split
 *   view — app context on the left, the connector on the right. Discover
 *   providers resolve against the Discover catalogue; managed OAuth
 *   providers against the Easy Connect one (the forward carries `?src=apps`
 *   so the left pane reads the right catalogue). A custom connector no app
 *   claims keeps the standalone page.
 * - Otherwise the slug is an APP → the catalogue page renders here directly
 *   (`/connectors/canva` IS the Canva page; the old
 *   `/connectors/catalog/discover/canva` spelling still works).
 *
 * The search string rides every forward untouched — `?connect=1` and the
 * OAuth `?oauth2=` return leg must land wherever the connector UI lands.
 */
export function ConnectorSlugPage({ projectId, slug }: { projectId: string; slug: string }) {
  const router = useRouter();
  const search = useSearchParams();

  const connectorsQuery = useQuery({
    queryKey: qk.project.connectors(projectId),
    queryFn: () => listConnectors(projectId),
    ...contract('config'),
  });
  const record =
    connectorsQuery.data?.connectors.find((connector) => connector.slug === slug) ?? null;
  const managed = record !== null && isManagedConnectorProvider(record.provider);
  const resolvable =
    record !== null && (managed || DISCOVER_PROVIDERS.has(record.provider));

  const appQuery = useQuery({
    queryKey: ['connector-app-resolution', projectId, slug],
    enabled: resolvable,
    // Best-effort: no match is a normal answer (custom connectors), so it
    // resolves to null, never throws.
    queryFn: async () => {
      if (!record) return null;
      for (const query of appResolutionQueries(record)) {
        try {
          if (managed) {
            const page = await listPipedreamApps(projectId, query);
            const app = catalogAppForConnector(page.apps, record);
            if (app) return { slug: app.slug, source: 'easy-connect' as const };
          } else {
            const page = await listDiscoverConnectors(projectId, query);
            const app = catalogAppForConnector(page.items, record);
            if (app) return { slug: app.slug, source: 'discover' as const };
          }
        } catch {
          return null;
        }
      }
      return null;
    },
    staleTime: 15 * 60_000,
    retry: false,
  });

  const resolvedApp = appQuery.data ?? null;
  useEffect(() => {
    if (!resolvedApp) return;
    const params = new URLSearchParams(search?.toString() ?? '');
    if (resolvedApp.source === 'easy-connect') params.set('src', 'apps');
    const suffix = params.toString();
    router.replace(
      `${appConnectorHref(projectId, resolvedApp.slug, slug)}${suffix ? `?${suffix}` : ''}`,
    );
  }, [projectId, resolvedApp, router, search, slug]);

  // Hold the skeleton while the meaning of the slug is still being decided —
  // list loading, app resolution in flight, or the forward about to fire.
  if (connectorsQuery.isLoading || (resolvable && (appQuery.isLoading || resolvedApp))) {
    return <SplitResolveSkeleton />;
  }

  if (record) {
    return <ConnectedConnectorPage projectId={projectId} slug={slug} />;
  }

  // Not a project connector: the slug is an app. `?src=` names the catalogue
  // (`apps` = Easy Connect, `computer` = computer profiles); Discover is the
  // default. The catalogue page owns its own loading, error, and not-found
  // states.
  return (
    <CatalogConnectorPage
      projectId={projectId}
      sourceValue={catalogSourceFromSearch(search?.get('src') ?? null)}
      slug={slug}
    />
  );
}
