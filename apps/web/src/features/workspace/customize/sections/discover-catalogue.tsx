'use client';

import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import {
  type ConnectorDraftInput,
  type DiscoverIntegration,
  type DiscoverIntegrationVariant,
  type PipedreamApp,
  createConnector,
  getConnectStatus,
  getDiscoverIntegration,
  listDiscoverIntegrations,
  listPipedreamApps,
} from '@kortix/sdk/projects-client';
import { Boxes, ChevronRight, ExternalLink, Globe, Plus, Search, Zap } from 'lucide-react';
import Image from 'next/image';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { useDebounce } from '@/hooks/use-debounce';
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
import { errorToast, successToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { isConnectorsEnabled } from '@/lib/config';

const BUILT_IN_CHANNEL_APP_SLUGS = new Set(['slack', 'slack_v2']);

type DiscoverCard =
  | { source: 'integration'; item: DiscoverIntegration }
  | { source: 'pipedream'; app: PipedreamApp };

function connectorSlug(item: DiscoverIntegration, variant: DiscoverIntegrationVariant): string {
  return `${item.slug}-${variant.kind}`
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
}

export function DiscoverCatalogue({
  projectId,
  onAdded,
}: {
  projectId: string;
  onAdded: (slug?: string) => void;
}) {
  const [q, setQ] = useState('');
  const { debouncedValue: deferredQuery } = useDebounce(q.trim(), 300);
  const [selectedIntegration, setSelectedIntegration] = useState<DiscoverIntegration | null>(null);
  const connectorsEnabled = isConnectorsEnabled();
  const connectStatus = useQuery({
    queryKey: ['connect-status'],
    queryFn: getConnectStatus,
    staleTime: 5 * 60_000,
    enabled: connectorsEnabled,
  });
  const pipedreamEnabled = connectorsEnabled && connectStatus.data?.configured === true;

  const integrationsQuery = useInfiniteQuery({
    queryKey: ['discover-integrations', projectId, deferredQuery],
    queryFn: ({ pageParam }) =>
      listDiscoverIntegrations(
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
    queryKey: ['discover-integration-detail', projectId, selectedIntegration?.id],
    queryFn: () =>
      selectedIntegration
        ? getDiscoverIntegration(projectId, selectedIntegration.id)
        : Promise.reject(new Error('No integration selected')),
    enabled: Boolean(selectedIntegration),
    staleTime: 15 * 60_000,
  });

  const integrationCards: DiscoverCard[] = (integrationsQuery.data?.pages ?? [])
    .flatMap((page) => page.items)
    .map((item) => ({ source: 'integration' as const, item }));
  const pipedreamOAuthCards: DiscoverCard[] = (pipedreamQuery.data?.pages ?? [])
    .flatMap((page) => page.apps)
    .filter((app) => app.authType === 'oauth' && !BUILT_IN_CHANNEL_APP_SLUGS.has(app.slug))
    .map((app) => ({ source: 'pipedream' as const, app }));
  const discoverCards = [...integrationCards, ...pipedreamOAuthCards];

  const addPipedream = useMutation({
    mutationFn: (app: { slug: string; name: string }) =>
      createConnector(projectId, {
        slug: app.slug,
        provider: 'pipedream',
        app: app.slug,
        account: 'default',
      }).then(() => app),
    onSuccess: (app) => {
      successToast(`Added ${app.name} — click Connect to authorize`);
      onAdded(app.slug);
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to add'),
  });

  const addVariant = useMutation({
    mutationFn: async ({
      item,
      variant,
    }: { item: DiscoverIntegration; variant: DiscoverIntegrationVariant }) => {
      if (!variant.connector) throw new Error('This surface needs manual configuration');
      const template = variant.connector;
      const slug = connectorSlug(item, variant);
      const auth = template.auth
        ? {
            type: template.auth.type,
            in: template.auth.in,
            ...(template.auth.name ? { name: template.auth.name } : {}),
            ...(template.auth.prefix ? { prefix: template.auth.prefix } : {}),
          }
        : undefined;
      const draft: ConnectorDraftInput = {
        slug,
        name: variant.name,
        provider: template.provider,
        ...(template.spec ? { spec: template.spec } : {}),
        ...(template.url ? { url: template.url } : {}),
        ...(template.transport ? { transport: template.transport } : {}),
        ...(template.endpoint ? { endpoint: template.endpoint } : {}),
        ...(auth ? { auth } : {}),
      };
      await createConnector(projectId, draft);
      return { slug, name: variant.name };
    },
    onSuccess: ({ slug, name }) => {
      successToast(`Added ${name}`);
      setSelectedIntegration(null);
      onAdded(slug);
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to add'),
  });

  const loading = integrationsQuery.isLoading || (pipedreamEnabled && pipedreamQuery.isLoading);

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

      {integrationsQuery.isError ? (
        <InfoBanner
          tone="destructive"
          title="Could not load Discover"
          action={
            <Button variant="outline" size="sm" onClick={() => integrationsQuery.refetch()}>
              Retry
            </Button>
          }
        >
          {(integrationsQuery.error as Error)?.message ?? 'The public catalogue is unavailable.'}
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
          title="No integrations found"
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
                  disabled={addPipedream.isPending || addVariant.isPending}
                  onClick={() =>
                    isOAuth
                      ? addPipedream.mutate({ slug: card.app.slug, name: card.app.name })
                      : setSelectedIntegration(card.item)
                  }
                  className="group bg-popover hover:bg-muted/80 focus-visible:ring-primary/50 active:scale-[0.96] flex min-h-28 flex-col rounded-md border p-3.5 text-left transition-[background-color,transform] focus-visible:ring-2 focus-visible:outline-none disabled:opacity-60"
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
          {(integrationsQuery.hasNextPage || pipedreamQuery.hasNextPage) && (
            <div className="flex flex-wrap justify-center gap-2 pt-1">
              {integrationsQuery.hasNextPage && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => integrationsQuery.fetchNextPage()}
                  disabled={integrationsQuery.isFetchingNextPage}
                >
                  {integrationsQuery.isFetchingNextPage ? (
                    <Loading className="size-4 shrink-0" />
                  ) : null}
                  Load more integrations
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
        open={Boolean(selectedIntegration)}
        onOpenChange={(open) => !open && setSelectedIntegration(null)}
      >
        <ModalContent className="lg:max-w-2xl">
          <ModalHeader>
            <ModalTitle>{selectedIntegration?.name ?? 'Integration'}</ModalTitle>
            <ModalDescription>
              Choose a direct surface from {selectedIntegration?.domain}. Pipedream is not involved.
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
                title="Could not load integration surfaces"
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
                          disabled={addVariant.isPending}
                          onClick={() =>
                            addVariant.mutate({ item: detailQuery.data.item, variant })
                          }
                        >
                          {addVariant.isPending ? <Loading className="size-4 shrink-0" /> : null}
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
    </div>
  );
}
