'use client';

import {
  createConnector,
  getDiscoverConnector,
  type ConnectorDraftInput,
  type DiscoverConnector,
  type DiscoverConnectorTemplate,
} from '@kortix/sdk';
import { ArrowSquareOutIcon, CubeIcon, GlobeIcon } from '@phosphor-icons/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslations } from '@/i18n/use-translations';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
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
import {
  connectorAuthorizationStrategyIsEditable,
  connectorSyncErrorForSlug,
  createOnlyConnectorDraft,
  proposeConnectorConnectionSlug,
  type EasyConnectConnectionInput,
} from '@/features/workspace/customize/sections/connector-connection-form';
import { ConnectorConnectionModal } from '@/features/workspace/customize/sections/connector-connection-modal';

/**
 * Add one catalog connector to the project: pick a published surface, name
 * the connection, create the connector.
 *
 * ── Known duplication, read before changing either side ────────────────────
 * `features/workspace/customize/sections/discover-catalogue.tsx` implements
 * this same journey for the Add-connector modal's Discover tab. These are two
 * implementations of one user journey and they must stay behaviourally
 * consistent; a fix to one very likely belongs in the other.
 *
 * They were deliberately NOT unified. `connectors-view.discover.test.ts` pins
 * `discover-catalogue.tsx` at fourteen points of its *source text* — including
 * `'getDiscoverConnector(projectId, selectedConnector.id)'`,
 * `'createOnlyConnectorDraft(draft)'` and `'<ConnectorConnectionModal'` — so
 * extracting a shared module out of it would force a rewrite of a passing
 * contract test belonging to another surface. That was judged the worse trade.
 *
 * What is genuinely shared is already shared: `ConnectorConnectionModal` and the
 * four helpers in `connector-connection-form.ts` are imported by both. The
 * duplication left here is the create mutation and the surface-picker markup.
 * This flow also carries no Pipedream branch — the browse grid is catalog
 * connectors only, so managed OAuth stays in the Add-connector modal.
 *
 * The one thing that HAS to match, and once did not, is `onAdded`: same
 * `(slug?: string)` signature, and the slug omitted on a sync failure. The two
 * had diverged there, so the same partial failure opened the detail modal from
 * Browse and not from Add connector, on one page.
 */
/** A surface the user picked, narrowed to the ones that carry a template. */
interface VariantTarget {
  name: string;
  connector: DiscoverConnectorTemplate;
}

export function DiscoverAddFlow({
  projectId,
  connector,
  existingSlugs,
  canWrite,
  onClose,
  onAdded,
}: {
  projectId: string;
  /** The card the user clicked, or `null` when nothing is open. */
  connector: DiscoverConnector | null;
  existingSlugs: readonly string[];
  canWrite: boolean;
  onClose: () => void;
  /**
   * The connector was created. The slug is OMITTED when the manifest write
   * succeeded but synchronization did not — the caller must not navigate to a
   * connector the list may not carry yet. Same signature and same rule as
   * `AddAppPanel`'s `onAdded` (`connectors-view.tsx:3645`), which is the other
   * half of this journey.
   */
  onAdded: (slug?: string) => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  // The variant the user picked, held separately so the surface list can close
  // before the connection form opens (two stacked modals would trap focus twice).
  const [target, setTarget] = useState<VariantTarget | null>(null);

  // Same query key as `discover-catalogue.tsx` uses, so opening the same
  // connector from either surface is one fetch, not two.
  const detailQuery = useQuery({
    queryKey: ['discover-connector-detail', projectId, connector?.id],
    queryFn: () =>
      connector
        ? getDiscoverConnector(projectId, connector.id)
        : Promise.reject(new Error('No connector selected')),
    enabled: Boolean(connector),
    staleTime: 15 * 60_000,
  });

  const addConnection = useMutation({
    mutationFn: async ({
      variant,
      connection,
    }: {
      variant: VariantTarget;
      connection: EasyConnectConnectionInput;
    }) => {
      const template = variant.connector;
      const auth = template.auth
        ? {
            type: template.auth.type,
            in: template.auth.in,
            ...(template.auth.name ? { name: template.auth.name } : {}),
            ...(template.auth.prefix ? { prefix: template.auth.prefix } : {}),
          }
        : undefined;
      const draft: ConnectorDraftInput = {
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
      const createDraft = createOnlyConnectorDraft(draft);
      const result = await createConnector(projectId, createDraft);
      return {
        slug: createDraft.slug,
        name: createDraft.name ?? createDraft.slug,
        syncError: connectorSyncErrorForSlug(result, createDraft.slug),
      };
    },
    onSuccess: ({ slug, name, syncError }) => {
      setTarget(null);
      if (syncError) {
        warningToast(tI18nComplete('textd6a135de3872', { value0: name, value1: syncError }));
        // No slug: see `onAdded`'s contract above. `discover-catalogue.tsx:197`
        // and the three `AddAppPanel` create paths do the same.
        onAdded();
        return;
      }
      successToast(tI18nComplete('text29f396e2d238', { value0: name }));
      onAdded(slug);
    },
    onError: (error: Error) => errorToast(error.message || tI18nComplete.raw('texta34a2714da91')),
  });

  const connectionName = target?.name ?? '';

  return (
    <>
      <Modal open={connector !== null} onOpenChange={(open) => !open && onClose()}>
        <ModalContent className="lg:max-w-2xl">
          <ModalHeader>
            <ModalTitle>{connector?.name ?? 'Connector'}</ModalTitle>
            <ModalDescription>
              {tI18nComplete.raw('textaa798730f64d')} {connector?.domain}.
            </ModalDescription>
          </ModalHeader>
          <ModalBody className="max-h-[60vh] overflow-y-auto">
            {detailQuery.isLoading ? (
              <div className="space-y-2">
                {[0, 1, 2].map((index) => (
                  <Skeleton key={index} className="h-20 w-full rounded-md" />
                ))}
              </div>
            ) : detailQuery.isError ? (
              <InfoBanner
                tone="destructive"
                title={tI18nComplete.raw('textf886cdc83491')}
                action={
                  <Button variant="outline" size="sm" onClick={() => detailQuery.refetch()}>
                    {tI18nComplete.raw('text942087cc2d41')}
                  </Button>
                }
              >
                {(detailQuery.error as Error)?.message ?? tI18nComplete.raw('texta0c2cc1374d9')}
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
                          <CubeIcon className="size-5" />
                        ) : (
                          <GlobeIcon className="size-5" />
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
                              {tI18nComplete.raw('text46f49bfb8d8f')}
                            </span>
                          ) : null}
                        </div>
                      </div>
                      {variant.connector && canWrite ? (
                        <Button
                          size="sm"
                          className="shrink-0"
                          disabled={addConnection.isPending}
                          onClick={() => {
                            const connector = variant.connector;
                            if (!connector) return;
                            onClose();
                            setTarget({ name: variant.name, connector });
                          }}
                        >
                          {tI18nComplete.raw('text9fd728c66c9a')}
                        </Button>
                      ) : href ? (
                        <Button asChild variant="outline" size="sm" className="shrink-0">
                          <a href={href} target="_blank" rel="noreferrer">
                            {tI18nComplete.raw('text7af023c43013')}
                            <ArrowSquareOutIcon className="size-3.5 shrink-0" />
                          </a>
                        </Button>
                      ) : (
                        <Badge variant="secondary" size="sm">
                          {tI18nComplete.raw('textdf0453d185c4')}
                        </Badge>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <EmptyState
                icon={GlobeIcon}
                size="sm"
                title={tI18nComplete.raw('text363579e1d66b')}
                description={tI18nComplete.raw('text4d286e47d580')}
              />
            )}
          </ModalBody>
        </ModalContent>
      </Modal>

      <ConnectorConnectionModal
        open={target !== null}
        idPrefix="browse-connection"
        title={`Add ${connectionName || 'connector'}`}
        description={tI18nComplete.raw('text69d6a27a1b6d')}
        initialName={connectionName}
        initialSlug={target ? proposeConnectorConnectionSlug(connectionName, existingSlugs) : ''}
        existingSlugs={existingSlugs}
        pending={addConnection.isPending}
        authorizationStrategyDisabled={
          target ? !connectorAuthorizationStrategyIsEditable(target.connector.provider) : false
        }
        onOpenChange={(open) => !open && setTarget(null)}
        onSubmit={(connection) => {
          if (!target) return;
          addConnection.mutate({ variant: target, connection });
        }}
      />
    </>
  );
}
