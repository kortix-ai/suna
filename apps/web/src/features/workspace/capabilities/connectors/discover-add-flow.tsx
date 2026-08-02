'use client';

import {
  createConnector,
  getDiscoverIntegration,
  type ConnectorDraftInput,
  type DiscoverConnectorTemplate,
  type DiscoverIntegration,
} from '@kortix/sdk';
import { ArrowSquareOutIcon, CubeIcon, GlobeIcon } from '@phosphor-icons/react';
import { useMutation, useQuery } from '@tanstack/react-query';
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
  proposeConnectorProfileSlug,
  type EasyConnectProfileInput,
} from '@/features/workspace/customize/sections/connector-profile-form';
import { ConnectorProfileModal } from '@/features/workspace/customize/sections/connector-profile-modal';

/**
 * Add one catalog integration to the project: pick a published surface, name
 * the profile, create the connector.
 *
 * ── Known duplication, read before changing either side ────────────────────
 * `features/workspace/customize/sections/discover-catalogue.tsx` implements
 * this same journey for the Add-connector modal's Discover tab. These are two
 * implementations of one user journey and they must stay behaviourally
 * consistent; a fix to one very likely belongs in the other.
 *
 * They were deliberately NOT unified. `connectors-view.discover.test.ts` pins
 * `discover-catalogue.tsx` at fourteen points of its *source text* — including
 * `'getDiscoverIntegration(projectId, selectedIntegration.id)'`,
 * `'createOnlyConnectorDraft(draft)'` and `'<ConnectorProfileModal'` — so
 * extracting a shared module out of it would force a rewrite of a passing
 * contract test belonging to another surface. That was judged the worse trade.
 *
 * What is genuinely shared is already shared: `ConnectorProfileModal` and the
 * four helpers in `connector-profile-form.ts` are imported by both. The
 * duplication left here is the create mutation and the surface-picker markup.
 * This flow also carries no Pipedream branch — the browse grid is catalog
 * integrations only, so managed OAuth stays in the Add-connector modal.
 */
/** A surface the user picked, narrowed to the ones that carry a template. */
interface VariantTarget {
  name: string;
  connector: DiscoverConnectorTemplate;
}

export function DiscoverAddFlow({
  projectId,
  integration,
  existingSlugs,
  canWrite,
  onClose,
  onAdded,
}: {
  projectId: string;
  /** The card the user clicked, or `null` when nothing is open. */
  integration: DiscoverIntegration | null;
  existingSlugs: readonly string[];
  canWrite: boolean;
  onClose: () => void;
  onAdded: (slug: string) => void;
}) {
  // The variant the user picked, held separately so the surface list can close
  // before the profile form opens (two stacked modals would trap focus twice).
  const [target, setTarget] = useState<VariantTarget | null>(null);

  // Same query key as `discover-catalogue.tsx` uses, so opening the same
  // integration from either surface is one fetch, not two.
  const detailQuery = useQuery({
    queryKey: ['discover-integration-detail', projectId, integration?.id],
    queryFn: () =>
      integration
        ? getDiscoverIntegration(projectId, integration.id)
        : Promise.reject(new Error('No integration selected')),
    enabled: Boolean(integration),
    staleTime: 15 * 60_000,
  });

  const addProfile = useMutation({
    mutationFn: async ({
      variant,
      profile,
    }: {
      variant: VariantTarget;
      profile: EasyConnectProfileInput;
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
        slug: profile.slug,
        name: profile.name.trim(),
        provider: template.provider,
        authorization_strategy: profile.authorizationStrategy,
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
        warningToast(
          `Added ${name} to the manifest, but synchronization failed: ${syncError}. Use Sync to retry.`,
        );
        onAdded(slug);
        return;
      }
      successToast(`Added ${name}`);
      onAdded(slug);
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to add'),
  });

  const profileName = target?.name ?? '';

  return (
    <>
      <Modal open={integration !== null} onOpenChange={(open) => !open && onClose()}>
        <ModalContent className="lg:max-w-2xl">
          <ModalHeader>
            <ModalTitle>{integration?.name ?? 'Integration'}</ModalTitle>
            <ModalDescription>
              Choose a surface published by {integration?.domain}.
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
                title="Couldn't load surfaces"
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
                              Credential required
                            </span>
                          ) : null}
                        </div>
                      </div>
                      {variant.connector && canWrite ? (
                        <Button
                          size="sm"
                          className="shrink-0"
                          disabled={addProfile.isPending}
                          onClick={() => {
                            const connector = variant.connector;
                            if (!connector) return;
                            onClose();
                            setTarget({ name: variant.name, connector });
                          }}
                        >
                          Add
                        </Button>
                      ) : href ? (
                        <Button asChild variant="outline" size="sm" className="shrink-0">
                          <a href={href} target="_blank" rel="noreferrer">
                            Docs
                            <ArrowSquareOutIcon className="size-3.5 shrink-0" />
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
                icon={GlobeIcon}
                size="sm"
                title="No usable surface published"
                description="This record is discoverable, but its provider has not published a machine-readable endpoint."
              />
            )}
          </ModalBody>
        </ModalContent>
      </Modal>

      <ConnectorProfileModal
        open={target !== null}
        idPrefix="browse-profile"
        title={`Add ${profileName || 'integration'}`}
        description="Create a connector profile. The display name and slug identify this specific connection in project configuration."
        initialName={profileName}
        initialSlug={target ? proposeConnectorProfileSlug(profileName, existingSlugs) : ''}
        existingSlugs={existingSlugs}
        pending={addProfile.isPending}
        authorizationStrategyDisabled={
          target ? !connectorAuthorizationStrategyIsEditable(target.connector.provider) : false
        }
        onOpenChange={(open) => !open && setTarget(null)}
        onSubmit={(profile) => {
          if (!target) return;
          addProfile.mutate({ variant: target, profile });
        }}
      />
    </>
  );
}
