'use client';

/**
 * Step 4 — connect the apps the team already lives in.
 *
 * Real Pipedream OAuth, inline. The whole step is skipped by the shell when
 * `isConnectorsEnabled()` is false (self-host without PIPEDREAM_*), so this
 * component never has to render a dead 501 — but it still handles the case
 * where the catalogue call itself returns one.
 */

import { MagnifyingGlassIcon, PlusIcon } from '@phosphor-icons/react';
import { useInfiniteQuery } from '@tanstack/react-query';
import Image from 'next/image';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { FadedScrollArea } from '@/components/ui/faded-scroll-area';
import { InfoBanner } from '@/components/ui/info-banner';
import {
  InputGroupSearch,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import {
  easyConnectUnavailableReason,
  proposeConnectorConnectionSlug,
  type EasyConnectApp,
} from '@/features/workspace/customize/sections/connector-connection-form';
import { ConnectorConnectionModal } from '@/features/workspace/customize/sections/connector-connection-modal';
import { useToolConnect } from '@/hooks/connectors/use-tool-connect';
import { listPipedreamApps } from '@kortix/sdk';

import { ActionRow, StepShell } from '../step-shell';
/** Slack has its own dedicated step, so keep it out of this list. */
const SLACK_SLUGS = new Set(['slack', 'slack_v2']);

export function ToolsStep({
  workspaceId,
  existingSlugs,
  onConnected,
  onContinue,
  onSkip,
}: {
  workspaceId: string;
  existingSlugs: readonly string[];
  onConnected: () => void;
  onContinue: () => void;
  onSkip: () => void;
}) {
  const [q, setQ] = useState('');
  const [selectedApp, setSelectedApp] = useState<EasyConnectApp | null>(null);
  const connect = useToolConnect(workspaceId, onConnected);

  const appsQuery = useInfiniteQuery({
    queryKey: ['onboarding-tools', workspaceId, q],
    queryFn: ({ pageParam }) =>
      listPipedreamApps(workspaceId, q || undefined, pageParam as string | undefined),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.hasMore ? last.nextCursor : undefined),
    staleTime: 60_000,
  });

  const apps = (appsQuery.data?.pages ?? [])
    .flatMap((p) => p.apps)
    .filter((a) => !SLACK_SLUGS.has(a.slug));
  const notConfigured =
    appsQuery.isError && /501|not configured/i.test((appsQuery.error as Error)?.message ?? '');

  return (
    <StepShell
      title="Connect your tools"
      description="Pick the apps you live in and authorize them right here. Your agent can read, write, and act across everything you connect."
      primaryLabel="Continue"
      onPrimary={onContinue}
      skipLabel="Skip for now"
      onSkip={onSkip}
    >
      <div className="flex flex-col gap-4">
        <InputGroupSearch>
          <InputGroupSearchIcon>
            <MagnifyingGlassIcon />
          </InputGroupSearchIcon>
          <InputGroupSearchInput
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search 3,000+ apps…"
            variant="popover"
          />
        </InputGroupSearch>

        {notConfigured ? (
          <InfoBanner tone="neutral" title="App connect isn’t configured on this deployment">
            You can still continue and connect tools later from Connectors.
          </InfoBanner>
        ) : (
          // Bounded by the column, not the viewport: a vh-relative height made
          // this step the tallest thing in the flow on large screens. The fade
          // tells you there is more without adding a scrollbar to look at.
          <FadedScrollArea
            fadeColor="from-background"
            className="max-h-[320px] overflow-y-auto pr-1"
          >
            {appsQuery.isLoading ? (
              <div className="flex flex-col gap-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-[58px] w-full rounded-md" />
                ))}
              </div>
            ) : apps.length === 0 ? (
              <div className="flex h-full flex-1 flex-col items-center justify-center rounded-md border">
                <p className="text-muted-foreground py-10 text-center text-xs">
                  {q ? `Nothing matches “${q}”.` : 'Try a search.'}
                </p>
              </div>
            ) : (
              <>
                <div className="flex flex-col gap-2">
                  {apps.map((app) => {
                    const connected = existingSlugs.includes(app.slug);
                    const connectedStatusId = `onboarding-tool-${app.slug}-connected`;

                    return (
                      <ActionRow
                        key={app.slug}
                        label={app.name}
                        description={app.categories?.[0]}
                        aria-label={`Add ${app.name} connection`}
                        aria-describedby={connected ? connectedStatusId : undefined}
                        disabled={connect.isPending}
                        onSelect={() => setSelectedApp(app)}
                        leading={
                          app.imgSrc ? (
                            <Image
                              src={app.imgSrc}
                              alt=""
                              width={28}
                              height={28}
                              unoptimized
                              referrerPolicy="no-referrer"
                              className="size-7 shrink-0 rounded-sm object-contain"
                            />
                          ) : (
                            <EntityAvatar icon={PlusIcon} size="sm" label={app.name} />
                          )
                        }
                        trailing={
                          connect.isPending && connect.variables?.appSlug === app.slug ? (
                            <Loading className="size-4 shrink-0" />
                          ) : connected ? (
                            <Badge id={connectedStatusId} variant="success" size="xs">
                              Connected
                            </Badge>
                          ) : (
                            <PlusIcon className="text-muted-foreground/50 size-4" />
                          )
                        }
                      />
                    );
                  })}
                </div>
                {appsQuery.hasNextPage && (
                  <div className="flex justify-center pt-3">
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5"
                      onClick={() => appsQuery.fetchNextPage()}
                      disabled={appsQuery.isFetchingNextPage}
                    >
                      {appsQuery.isFetchingNextPage ? (
                        <Loading className="size-3.5 shrink-0" />
                      ) : null}
                      Load more
                    </Button>
                  </div>
                )}
              </>
            )}
          </FadedScrollArea>
        )}
      </div>

      <ConnectorConnectionModal
        open={selectedApp !== null}
        idPrefix="onboarding-tool-connection"
        title={`Add ${selectedApp?.name ?? 'app'}`}
        description="Create a connector connection before authorization. You can add more than one connection for the same app."
        initialName={selectedApp?.name ?? ''}
        initialSlug={
          selectedApp ? proposeConnectorConnectionSlug(selectedApp.name, existingSlugs) : ''
        }
        existingSlugs={existingSlugs}
        pending={connect.isPending}
        unavailableReason={easyConnectUnavailableReason(selectedApp)}
        onOpenChange={(open) => !open && setSelectedApp(null)}
        onSubmit={(connection) => {
          if (!selectedApp) return;
          connect.mutate(
            {
              appSlug: selectedApp.slug,
              appName: selectedApp.name,
              connectorName: connection.name,
              connectorSlug: connection.slug,
              authorizationStrategy: connection.authorizationStrategy,
            },
            { onSuccess: () => setSelectedApp(null) },
          );
        }}
      />
    </StepShell>
  );
}
