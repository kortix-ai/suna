'use client';

/**
 * Step 2 — connect the apps the team already lives in.
 *
 * Real Pipedream OAuth, inline. The whole step is skipped by the shell when
 * `isConnectorsEnabled()` is false (self-host without PIPEDREAM_*), so this
 * component never has to render a dead 501 — but it still handles the case
 * where the catalogue call itself returns one.
 */

import { useTranslations } from '@/i18n/use-translations';
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
  listConnectCatalogPage,
  useConnectProviderStatus,
} from '@/features/workspace/capabilities/connectors/catalog/use-catalog';
import {
  proposeConnectorConnectionSlug,
  type EasyConnectApp,
} from '@/features/workspace/customize/sections/connector-connection-form';
import { ConnectorConnectionModal } from '@/features/workspace/customize/sections/connector-connection-modal';
import { useToolConnect } from '@/hooks/connectors/use-tool-connect';

import { ActionRow, StepShell } from '../step-shell';
/** Slack has its own dedicated step, so keep it out of this list. */
const SLACK_SLUGS = new Set(['slack', 'slack_v2']);

export function ToolsStep({
  projectId,
  existingSlugs,
  onConnected,
  onContinue,
  onSkip,
}: {
  projectId: string;
  existingSlugs: readonly string[];
  onConnected: () => void;
  onContinue: () => void;
  onSkip: () => void;
}) {
  const t = useTranslations('projectOnboarding.tools');
  const categoryLabels: Record<string, string> = {
    email: t('categories.email'),
    'ai-agents': t('categories.aiAgents'),
    'developer-tools': t('categories.developerTools'),
    'scheduling-&-booking': t('categories.scheduling'),
    notes: t('categories.notes'),
    spreadsheets: t('categories.spreadsheets'),
    'artificial-intelligence': t('categories.artificialIntelligence'),
    'social-media-accounts': t('categories.socialMedia'),
    'file-management-&-storage': t('categories.fileStorage'),
    documents: t('categories.documents'),
    crm: t('categories.crm'),
    'project-management': t('categories.projectManagement'),
    productivity: t('categories.productivity'),
    analytics: t('categories.analytics'),
    'ai-web-scraping': t('categories.webScraping'),
    'video-&-audio': t('categories.videoAudio'),
    'team-chat': t('categories.teamChat'),
    'online-courses': t('categories.onlineCourses'),
    'task-management': t('categories.taskManagement'),
    'images-&-design': t('categories.design'),
    databases: t('categories.databases'),
    'news-&-lifestyle': t('categories.newsLifestyle'),
    ecommerce: t('categories.ecommerce'),
    signatures: t('categories.signatures'),
  };
  const [q, setQ] = useState('');
  const [selectedApp, setSelectedApp] = useState<EasyConnectApp | null>(null);
  const connect = useToolConnect(projectId, onConnected);
  const connectStatus = useConnectProviderStatus(true);
  const catalogProvider = connectStatus.provider ?? 'composio';

  const appsQuery = useInfiniteQuery({
    queryKey: ['onboarding-tools', projectId, q],
    queryFn: ({ pageParam }) =>
      listConnectCatalogPage({
        projectId,
        provider: catalogProvider,
        q: q || undefined,
        cursor: pageParam as string | undefined,
        limit: 48,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.hasMore ? last.nextCursor : undefined),
    staleTime: 60_000,
    enabled: connectStatus.state !== 'asking' && connectStatus.state !== 'absent',
  });

  const apps = (appsQuery.data?.pages ?? []).flatMap((p) =>
    p.apps.filter((a) => !SLACK_SLUGS.has(a.slug)),
  );
  const existingSlugSet = new Set(existingSlugs);
  const notConfigured =
    appsQuery.isError && /501|not configured/i.test((appsQuery.error as Error)?.message ?? '');

  return (
    <StepShell
      title={t('title')}
      description={t('description')}
      primaryLabel={t('continue')}
      onPrimary={onContinue}
      skipLabel={t('skipForNow')}
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
            placeholder={t('searchPlaceholder')}
            variant="popover"
          />
        </InputGroupSearch>

        {notConfigured ? (
          <InfoBanner tone="neutral" title={t('notConfiguredTitle')}>
            {t('notConfiguredDescription')}
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
                  {q ? t('noMatches', { query: q }) : t('trySearch')}
                </p>
              </div>
            ) : (
              <>
                <div className="flex flex-col gap-2">
                  {apps.map((app) => {
                    const connected = existingSlugSet.has(app.slug);
                    const connectedStatusId = `onboarding-tool-${app.slug}-connected`;

                    return (
                      <ActionRow
                        key={app.slug}
                        label={app.name}
                        description={
                          app.categories?.[0]
                            ? (categoryLabels[app.categories[0]] ??
                              app.categories[0].replaceAll('-', ' '))
                            : undefined
                        }
                        aria-label={t('addConnection', { app: app.name })}
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
                              {t('connected')}
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
                      {t('loadMore')}
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
        title={t('addApp', { app: selectedApp?.name ?? t('appFallback') })}
        description={t('connectionDescription')}
        initialName={selectedApp?.name ?? ''}
        initialSlug={
          selectedApp ? proposeConnectorConnectionSlug(selectedApp.name, existingSlugs) : ''
        }
        existingSlugs={existingSlugs}
        pending={connect.isPending}
        onOpenChange={(open) => !open && setSelectedApp(null)}
        onSubmit={(connection) => {
          if (!selectedApp) return;
          connect.mutate(
            {
              appSlug: selectedApp.slug,
              appName: selectedApp.name,
              provider: selectedApp.provider,
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
