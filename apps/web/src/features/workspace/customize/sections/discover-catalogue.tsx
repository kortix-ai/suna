'use client';

import { useTranslations } from '@/i18n/use-translations';
import {
  createConnector,
  getConnectStatus,
  getDiscoverConnector,
  listDiscoverConnectors,
  listPipedreamApps,
  type ConnectorDraftInput,
  type DiscoverConnector,
  type DiscoverConnectorVariant,
  type PipedreamApp,
} from '@kortix/sdk';
import { MagnifyingGlassIcon as Search } from '@phosphor-icons/react';
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast, warningToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { useDebounce } from '@/hooks/use-debounce';
import { isConnectorsEnabled } from '@/lib/config';

import {
  buildDiscoverConnectorDraft,
  connectorSyncErrorForSlug,
  createOnlyConnectorDraft,
  proposeConnectorConnectionSlug,
  type EasyConnectConnectionInput,
} from './connector-connection-form';
import { DiscoverCatalogueCard, type DiscoverCard } from './discover-catalogue-card';
import { DiscoverCatalogueDetail } from './discover-catalogue-detail';
import { ConnectorConnectionModal } from './connector-connection-modal';

const BUILT_IN_CHANNEL_APP_SLUGS = new Set(['slack', 'slack_v2']);

type DiscoverConnectorTarget =
  | { source: 'connector'; item: DiscoverConnector; variant: DiscoverConnectorVariant }
  | { source: 'pipedream'; app: PipedreamApp };

/**
 * The Add-connector modal's Discover tab: a flat, searchable grid of the
 * public catalogue plus Pipedream's OAuth apps.
 *
 * ── Known duplication, read before changing this file ──────────────────────
 * The app page's Install
 * (`features/workspace/capabilities/connectors/install/install.ts`) runs the
 * same add journey (pick a surface -> `createConnector` -> credential entry)
 * for the Connectors page's catalogue. The two are separate implementations
 * of one journey and must stay behaviourally consistent; a fix here very
 * likely belongs there too.
 */
export function DiscoverCatalogue({
  projectId,
  existingSlugs,
  onAdded,
}: {
  projectId: string;
  existingSlugs: readonly string[];
  onAdded: (slug?: string) => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const [q, setQ] = useState('');
  const { debouncedValue: deferredQuery } = useDebounce(q.trim(), 300);
  const [selectedConnector, setSelectedConnector] = useState<DiscoverConnector | null>(null);
  const [connectorTarget, setConnectorTarget] = useState<DiscoverConnectorTarget | null>(null);
  const connectorsEnabled = isConnectorsEnabled();
  const connectStatus = useQuery({
    queryKey: ['connect-status'],
    queryFn: getConnectStatus,
    staleTime: 5 * 60_000,
    enabled: connectorsEnabled,
  });
  const pipedreamEnabled = connectorsEnabled && connectStatus.data?.configured === true;

  const connectorsQuery = useInfiniteQuery({
    queryKey: ['discover-connectors', projectId, deferredQuery],
    queryFn: ({ pageParam }) =>
      listDiscoverConnectors(
        projectId,
        deferredQuery || undefined,
        pageParam as string | undefined,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.hasMore ? last.nextCursor : undefined),
    staleTime: 5 * 60_000,
  });
  const pipedreamQuery = useInfiniteQuery({
    queryKey: ['discover-pipedream-oauth', projectId, deferredQuery],
    queryFn: ({ pageParam }) =>
      listPipedreamApps(projectId, deferredQuery || undefined, pageParam as string | undefined),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.hasMore ? last.nextCursor : undefined),
    staleTime: 60_000,
    enabled: pipedreamEnabled,
  });
  const detailQuery = useQuery({
    queryKey: ['discover-connector-detail', projectId, selectedConnector?.id],
    queryFn: () =>
      selectedConnector
        ? getDiscoverConnector(projectId, selectedConnector.id)
        : Promise.reject(new Error('No connector selected')),
    enabled: Boolean(selectedConnector),
    staleTime: 15 * 60_000,
  });

  const connectorCards: DiscoverCard[] = (connectorsQuery.data?.pages ?? []).flatMap((page) =>
    page.items.map((item) => ({ source: 'connector' as const, item })),
  );
  const pipedreamOAuthCards: DiscoverCard[] = (pipedreamQuery.data?.pages ?? []).flatMap((page) =>
    page.apps
      .filter((app) => app.authType === 'oauth' && !BUILT_IN_CHANNEL_APP_SLUGS.has(app.slug))
      .map((app) => ({ source: 'pipedream' as const, app })),
  );
  const discoverCards = [...connectorCards, ...pipedreamOAuthCards];

  const addConnector = useMutation({
    mutationFn: async ({
      target,
      connection,
    }: {
      target: DiscoverConnectorTarget;
      connection: EasyConnectConnectionInput;
    }) => {
      let draft: ConnectorDraftInput;
      if (target.source === 'pipedream') {
        draft = {
          slug: connection.slug,
          name: connection.name.trim(),
          provider: 'pipedream',
          app: target.app.slug,
          account: 'default',
        };
      } else {
        if (!target.variant.connector) {
          throw new Error('This surface needs manual configuration');
        }
        draft = buildDiscoverConnectorDraft(target.variant.connector, connection);
      }
      const createDraft = createOnlyConnectorDraft(draft);
      const result = await createConnector(projectId, createDraft);
      return {
        slug: createDraft.slug,
        name: createDraft.name ?? createDraft.slug,
        pipedream: target.source === 'pipedream',
        syncError: connectorSyncErrorForSlug(result, createDraft.slug),
      };
    },
    onSuccess: ({ slug, name, pipedream, syncError }) => {
      setConnectorTarget(null);
      if (syncError) {
        warningToast(tI18nComplete('textd6a135de3872', { value0: name, value1: syncError }));
        onAdded();
        return;
      }
      successToast(
        pipedream
          ? tI18nComplete('text590d36262e11', { value0: name })
          : tI18nComplete('text29f396e2d238', { value0: name }),
      );
      onAdded(slug);
    },
    onError: (error: Error) => errorToast(error.message || tI18nComplete.raw('texta34a2714da91')),
  });

  const loading = connectorsQuery.isLoading || (pipedreamEnabled && pipedreamQuery.isLoading);
  const connectionDisplayName =
    connectorTarget?.source === 'pipedream'
      ? connectorTarget.app.name
      : (connectorTarget?.variant.name ?? '');

  return (
    <div className="space-y-4">
      <div className="relative">
        <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
        <Input
          value={q}
          onChange={(event) => setQ(event.target.value)}
          placeholder={tI18nComplete.raw('textd95934d15292')}
          variant="popover"
          className="pl-9"
        />
      </div>

      {connectorsQuery.isError ? (
        <InfoBanner
          tone="destructive"
          title={tI18nComplete.raw('textab93638292af')}
          action={
            <Button variant="outline" size="sm" onClick={() => connectorsQuery.refetch()}>
              {tI18nComplete.raw('text942087cc2d41')}
            </Button>
          }
        >
          {(connectorsQuery.error as Error)?.message ?? tI18nComplete.raw('text0d31cf2c2307')}
        </InfoBanner>
      ) : loading ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 12 }).map((_, index) => (
            <Skeleton key={index} className="h-28 w-full rounded-md" />
          ))}
        </div>
      ) : discoverCards.length === 0 ? (
        <EmptyState
          icon={Search}
          title={tI18nComplete.raw('texta2ac2ce730c9')}
          description={
            q
              ? tI18nComplete('text3e71adfa7d54', { value0: q })
              : tI18nComplete.raw('text06cf1d8d7c75')
          }
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {discoverCards.map((card) => {
              return (
                <DiscoverCatalogueCard
                  key={card.source === 'pipedream' ? `pipedream:${card.app.slug}` : card.item.id}
                  card={card}
                  addConnector={addConnector}
                  setConnectorTarget={setConnectorTarget}
                  setSelectedConnector={setSelectedConnector}
                />
              );
            })}
          </div>
          {(connectorsQuery.hasNextPage || pipedreamQuery.hasNextPage) && (
            <div className="flex flex-wrap justify-center gap-2 pt-1">
              {connectorsQuery.hasNextPage && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => connectorsQuery.fetchNextPage()}
                  disabled={connectorsQuery.isFetchingNextPage}
                >
                  {connectorsQuery.isFetchingNextPage ? (
                    <Loading className="size-4 shrink-0" />
                  ) : null}
                  {tI18nComplete.raw('texta085437ccc11')}
                </Button>
              )}
              {pipedreamQuery.hasNextPage && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => pipedreamQuery.fetchNextPage()}
                  disabled={pipedreamQuery.isFetchingNextPage}
                >
                  {pipedreamQuery.isFetchingNextPage ? (
                    <Loading className="size-4 shrink-0" />
                  ) : null}
                  {tI18nComplete.raw('text69cea0daa681')}
                </Button>
              )}
            </div>
          )}
        </>
      )}

      <DiscoverCatalogueDetail
        selectedConnector={selectedConnector}
        setSelectedConnector={setSelectedConnector}
        detailQuery={detailQuery}
        addConnector={addConnector}
        setConnectorTarget={setConnectorTarget}
      />
      <ConnectorConnectionModal
        open={connectorTarget !== null}
        idPrefix="discover-connector"
        title={`Add ${connectionDisplayName || 'connector'}`}
        description={tI18nComplete.raw('text49ad6dbe32fb')}
        initialName={connectionDisplayName}
        initialSlug={
          connectorTarget
            ? proposeConnectorConnectionSlug(connectionDisplayName, existingSlugs)
            : ''
        }
        existingSlugs={existingSlugs}
        pending={addConnector.isPending}
        onOpenChange={(open) => !open && setConnectorTarget(null)}
        onSubmit={(connection) => {
          if (!connectorTarget) return;
          addConnector.mutate({ target: connectorTarget, connection });
        }}
      />
    </div>
  );
}
