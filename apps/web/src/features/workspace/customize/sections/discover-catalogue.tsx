'use client';

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
import {
  CubeIcon as Boxes,
  CaretRightIcon as ChevronRight,
  ArrowSquareOutIcon as ExternalLink,
  GlobeIcon as Globe,
  PlusIcon as Plus,
  MagnifyingGlassIcon as Search,
  LightningIcon as Zap,
} from '@phosphor-icons/react';
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import Image from 'next/image';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast, warningToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { useDebounce } from '@/hooks/use-debounce';
import { isConnectorsEnabled } from '@/lib/config';

import {
  connectorAuthorizationStrategyIsEditable,
  connectorSyncErrorForSlug,
  createOnlyConnectorDraft,
  proposeConnectorConnectionSlug,
  type EasyConnectConnectionInput,
} from './connector-connection-form';
import { ConnectorConnectionModal } from './connector-connection-modal';

const BUILT_IN_CHANNEL_APP_SLUGS = new Set(['slack', 'slack_v2']);

type DiscoverCard =
  { source: 'connector'; item: DiscoverConnector } | { source: 'pipedream'; app: PipedreamApp };

type DiscoverConnectorTarget =
  | { source: 'connector'; item: DiscoverConnector; variant: DiscoverConnectorVariant }
  | { source: 'pipedream'; app: PipedreamApp };

/**
 * The Add-connector modal's Discover tab: a flat, searchable grid of the
 * public catalogue plus Pipedream's OAuth apps.
 *
 * ── Known duplication, read before changing this file ──────────────────────
 * `features/workspace/capabilities/connectors/discover-add-flow.tsx` runs the
 * same add journey (surface picker -> `ConnectorConnectionModal` ->
 * `createConnector`) for the Connectors page's Browse scope. The two are
 * separate implementations of one journey and must stay behaviourally
 * consistent; a fix here very likely belongs there too. That file's header
 * records why they were not unified.
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

  const connectorCards: DiscoverCard[] = [];
  for (const page of connectorsQuery.data?.pages ?? []) {
    for (const item of page.items) {
      connectorCards.push({ source: 'connector' as const, item });
    }
  }
  const pipedreamOAuthCards: DiscoverCard[] = [];
  for (const page of pipedreamQuery.data?.pages ?? []) {
    for (const app of page.apps) {
      if (app.authType === 'oauth' && !BUILT_IN_CHANNEL_APP_SLUGS.has(app.slug)) {
        pipedreamOAuthCards.push({ source: 'pipedream' as const, app });
      }
    }
  }
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
          authorization_strategy: connection.authorizationStrategy,
        };
      } else {
        if (!target.variant.connector) {
          throw new Error('This surface needs manual configuration');
        }
        const template = target.variant.connector;
        const auth = template.auth
          ? {
              type: template.auth.type,
              in: template.auth.in,
              ...(template.auth.name ? { name: template.auth.name } : {}),
              ...(template.auth.prefix ? { prefix: template.auth.prefix } : {}),
            }
          : undefined;
        draft = {
          slug: connection.slug,
          name: connection.name.trim(),
          provider: template.provider,
          authorization_strategy: connection.authorizationStrategy,
          ...(template.spec ? { spec: template.spec } : {}),
          ...(template.url ? { url: template.url } : {}),
          ...(template.transport ? { transport: template.transport } : {}),
          ...(template.endpoint ? { endpoint: template.endpoint } : {}),
          ...(auth ? { auth } : {}),
        };
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
        warningToast(
          `Added ${name} to the manifest, but synchronization failed: ${syncError}. Use Sync to retry.`,
        );
        onAdded();
        return;
      }
      successToast(pipedream ? `Added ${name} — click Connect to authorize` : `Added ${name}`);
      onAdded(slug);
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to add'),
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
          placeholder="Search 5,000+ APIs, MCP servers, and OAuth apps"
          variant="popover"
          className="pl-9"
        />
      </div>

      {connectorsQuery.isError ? (
        <InfoBanner
          tone="destructive"
          title="Could not load Discover"
          action={
            <Button variant="outline" size="sm" onClick={() => connectorsQuery.refetch()}>
              Retry
            </Button>
          }
        >
          {(connectorsQuery.error as Error)?.message ?? 'The public catalogue is unavailable.'}
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
          title="No connectors found"
          description={q ? `Nothing matches "${q}".` : 'Try another search.'}
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {discoverCards.map((card) => {
              const isOAuth = card.source === 'pipedream';
              const name = isOAuth ? card.app.name : card.item.name;
              const description = isOAuth ? card.app.description : card.item.description;
              const icon = isOAuth ? card.app.imgSrc : card.item.icon;
              const key = isOAuth ? `pipedream:${card.app.slug}` : card.item.id;
              // The public index often has one feed entry (commonly MCP) for a
              // domain whose surface document contains APIs, CLIs, and more.
              const subtitle = isOAuth ? 'Pipedream OAuth' : 'Direct surfaces';
              return (
                <button
                  key={key}
                  type="button"
                  disabled={addConnector.isPending}
                  onClick={() =>
                    isOAuth
                      ? setConnectorTarget({ source: 'pipedream', app: card.app })
                      : setSelectedConnector(card.item)
                  }
                  className="group bg-popover hover:bg-muted/80 focus-visible:ring-primary/50 flex min-h-28 flex-col rounded-md border p-3.5 text-left transition-[background-color,transform] focus-visible:ring-2 focus-visible:outline-none active:scale-[0.96] disabled:opacity-60"
                >
                  <div className="flex items-center gap-3">
                    {icon ? (
                      <Image
                        src={icon}
                        alt=""
                        width={36}
                        height={36}
                        className="ring-foreground/10 size-8 shrink-0 rounded-md object-contain ring-1"
                        referrerPolicy="no-referrer"
                        unoptimized
                      />
                    ) : (
                      <EntityAvatar icon={isOAuth ? Zap : Globe} size="sm" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="text-foreground truncate text-sm font-medium">{name}</div>
                      <Badge variant={isOAuth ? 'kortix' : 'outline'} size="xs">
                        {subtitle}
                      </Badge>
                    </div>
                    {isOAuth ? (
                      <Plus className="text-muted-foreground/40 group-hover:text-primary size-4 shrink-0 transition-colors" />
                    ) : (
                      <ChevronRight className="text-muted-foreground/40 group-hover:text-primary size-4 shrink-0 transition-colors" />
                    )}
                  </div>
                  <p className="text-muted-foreground mt-2 line-clamp-2 min-h-8 text-xs leading-relaxed">
                    {description ??
                      (isOAuth ? 'Authorize through Pipedream.' : 'View available surfaces.')}
                  </p>
                </button>
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
                  Load more connectors
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
                  Load more OAuth apps
                </Button>
              )}
            </div>
          )}
        </>
      )}

      <Modal
        open={Boolean(selectedConnector)}
        onOpenChange={(open) => !open && setSelectedConnector(null)}
      >
        <ModalContent className="lg:max-w-2xl">
          <ModalHeader>
            <ModalTitle>{selectedConnector?.name ?? 'Connector'}</ModalTitle>
            <ModalDescription>
              Choose a direct surface from {selectedConnector?.domain}. Pipedream is not involved.
            </ModalDescription>
          </ModalHeader>
          <ModalBody className="max-h-[60vh] overflow-y-auto">
            {detailQuery.isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 3 }).map((_, index) => (
                  <Skeleton key={index} className="h-20 w-full rounded-md" />
                ))}
              </div>
            ) : detailQuery.isError ? (
              <InfoBanner
                tone="destructive"
                title="Could not load connector surfaces"
                action={
                  <Button variant="outline" size="sm" onClick={() => detailQuery.refetch()}>
                    Retry
                  </Button>
                }
              >
                {(detailQuery.error as Error)?.message ?? 'Try again.'}
              </InfoBanner>
            ) : detailQuery.data?.variants.length ? (
              <ul className="space-y-2">
                {detailQuery.data.variants.map((variant) => {
                  const href = variant.docs ?? variant.url;
                  return (
                    <li
                      key={`${variant.kind}:${variant.id}`}
                      className="bg-popover flex items-center gap-3 rounded-md border px-4 py-3"
                    >
                      <span className="bg-kortix-blue/15 text-kortix-blue flex size-9 shrink-0 items-center justify-center rounded-sm">
                        {variant.kind === 'mcp' ? (
                          <Boxes className="size-5" />
                        ) : (
                          <Globe className="size-5" />
                        )}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-foreground truncate text-sm font-medium">
                          {variant.name}
                        </p>
                        <div className="mt-1 flex items-center gap-1.5">
                          <Badge variant="outline" size="xs">
                            {variant.kind === 'openapi' ? 'OpenAPI' : variant.kind.toUpperCase()}
                          </Badge>
                          {variant.requiresAuth ? (
                            <span className="text-muted-foreground text-xs">
                              Credential required
                            </span>
                          ) : null}
                        </div>
                      </div>
                      {variant.connector ? (
                        <Button
                          size="sm"
                          className="shrink-0"
                          disabled={addConnector.isPending}
                          onClick={() => {
                            setSelectedConnector(null);
                            setConnectorTarget({
                              source: 'connector',
                              item: detailQuery.data.item,
                              variant,
                            });
                          }}
                        >
                          Add direct
                        </Button>
                      ) : href ? (
                        <Button asChild variant="outline" size="sm" className="shrink-0">
                          <a href={href} target="_blank" rel="noreferrer">
                            Configure manually
                            <ExternalLink className="size-3.5 shrink-0" />
                          </a>
                        </Button>
                      ) : (
                        <Badge variant="secondary" size="sm">
                          Metadata only
                        </Badge>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <EmptyState
                icon={Globe}
                size="sm"
                title="No usable surface published"
                description="This record is discoverable, but its provider has not published a machine-readable endpoint."
              />
            )}
          </ModalBody>
        </ModalContent>
      </Modal>
      <ConnectorConnectionModal
        open={connectorTarget !== null}
        idPrefix="discover-connector"
        title={`Add ${connectionDisplayName || 'connector'}`}
        description="Create a connector. The display name and slug identify it in project configuration."
        initialName={connectionDisplayName}
        initialSlug={
          connectorTarget
            ? proposeConnectorConnectionSlug(connectionDisplayName, existingSlugs)
            : ''
        }
        existingSlugs={existingSlugs}
        pending={addConnector.isPending}
        authorizationStrategyDisabled={
          connectorTarget?.source === 'connector' && connectorTarget.variant.connector
            ? !connectorAuthorizationStrategyIsEditable(connectorTarget.variant.connector.provider)
            : false
        }
        onOpenChange={(open) => !open && setConnectorTarget(null)}
        onSubmit={(connection) => {
          if (!connectorTarget) return;
          addConnector.mutate({ target: connectorTarget, connection });
        }}
      />
    </div>
  );
}
