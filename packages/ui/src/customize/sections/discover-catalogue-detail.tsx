'use client';

import { useTranslations } from '../../i18n';
import type { DiscoverConnector, DiscoverConnectorVariant, getDiscoverConnector } from '@kortix/sdk';
import type { UseQueryResult } from '@tanstack/react-query';
import { CubeIcon as Boxes, ArrowSquareOutIcon as ExternalLink, GlobeIcon as Globe } from '@phosphor-icons/react';
import { Badge } from '../../primitives/badge';
import { Button } from '../../primitives/button';
import { InfoBanner } from '../../primitives/info-banner';
import { Modal, ModalBody, ModalContent, ModalDescription, ModalHeader, ModalTitle } from '../../primitives/modal';
import { Skeleton } from '../../primitives/skeleton';
import { EmptyState } from '../../primitives/empty-state';

export function DiscoverCatalogueDetail({ selectedConnector, setSelectedConnector, detailQuery, addConnector, setConnectorTarget }: {
  selectedConnector: DiscoverConnector | null;
  setSelectedConnector: (item: DiscoverConnector | null) => void;
  detailQuery: UseQueryResult<Awaited<ReturnType<typeof getDiscoverConnector>>, Error>;
  addConnector: { isPending: boolean };
  setConnectorTarget: (target: { source: 'connector'; item: DiscoverConnector; variant: DiscoverConnectorVariant }) => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
      <Modal
        open={Boolean(selectedConnector)}
        onOpenChange={(open) => !open && setSelectedConnector(null)}
      >
        <ModalContent className="lg:max-w-2xl">
          <ModalHeader>
            <ModalTitle>{selectedConnector?.name ?? 'Connector'}</ModalTitle>
            <ModalDescription>
              {tI18nComplete.raw('textcd9f6b36a2c7')} {selectedConnector?.domain}
              {tI18nComplete.raw('text554add02368e')}
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
                title={tI18nComplete.raw('textda3e4af8062b')}
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
                              {tI18nComplete.raw('text46f49bfb8d8f')}
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
                          {tI18nComplete.raw('text16613cfc614f')}
                        </Button>
                      ) : href ? (
                        <Button asChild variant="outline" size="sm" className="shrink-0">
                          <a href={href} target="_blank" rel="noreferrer">
                            {tI18nComplete.raw('textb1d877ab2f51')}
                            <ExternalLink className="size-3.5 shrink-0" />
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
                icon={Globe}
                size="sm"
                title={tI18nComplete.raw('text363579e1d66b')}
                description={tI18nComplete.raw('text4d286e47d580')}
              />
            )}
          </ModalBody>
        </ModalContent>
      </Modal>
  );
}
