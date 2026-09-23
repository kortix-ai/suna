'use client';

/**
 * Step 2 — connect the apps the person uses.
 *
 * One click on a tile signs in to that app (`connect-app.ts`). The popup opens
 * inside the click, so the browser allows it, and nothing else stands in the
 * way: no modal, no name to type. Continue never waits for a connection, and
 * connecting nothing is a valid answer.
 */

import { CheckCircleIcon, MagnifyingGlassIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';

import { InfoBanner } from '@/components/ui/info-banner';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import {
  listConnectCatalogPage,
  useConnectProviderStatus,
} from '@/features/workspace/capabilities/connectors/catalog/use-catalog';
import { useDebounce } from '@/hooks/use-debounced-value';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';

import { AppLogo } from '../app-logo';
import type { CatalogApp } from '../connect-app';
import { StepShell } from '../step-shell';

export type AppConnectionState = 'idle' | 'connecting' | 'connected';

/** Three rows of four: enough to find the usual apps without scrolling. */
const PAGE_SIZE = 12;

export function AppsStep({
  projectId,
  stateOf,
  connectedCount,
  onConnect,
  onContinue,
}: {
  projectId: string;
  stateOf: (appSlug: string) => AppConnectionState;
  connectedCount: number;
  onConnect: (app: CatalogApp) => void;
  onContinue: () => void;
}) {
  const t = useTranslations('projectOnboarding.apps');
  const [q, setQ] = useState('');
  const query = useDebounce(q.trim(), 200);
  const status = useConnectProviderStatus(true);
  const provider = status.provider ?? 'composio';

  const apps = useQuery({
    queryKey: ['onboarding-apps', projectId, provider, query],
    queryFn: () =>
      listConnectCatalogPage({ projectId, provider, q: query || undefined, limit: PAGE_SIZE }),
    staleTime: 60_000,
    placeholderData: (previous) => previous,
    enabled: status.state !== 'asking' && status.state !== 'absent',
  });

  const notConfigured =
    status.state === 'absent' ||
    (apps.isError && /501|not configured/i.test((apps.error as Error)?.message ?? ''));
  const results = apps.data?.apps ?? [];
  const inputRef = useRef<HTMLInputElement>(null);
  // Searching covers the debounce too: from the first keystroke until the
  // matching page lands, so the spinner never lags the typing.
  const searching = !notConfigured && (q.trim() !== query || apps.isFetching);

  return (
    <StepShell
      title={t('title')}
      description={t('description')}
      primaryLabel={t('continue')}
      onPrimary={onContinue}
      footerNote={connectedCount > 0 ? t('connectedCount', { count: connectedCount }) : undefined}
    >
      <div className="flex flex-col gap-3">
        <InputGroupSearch>
          <InputGroupSearchIcon>
            {searching ? <Loading variant="spokes" className="size-4" /> : <MagnifyingGlassIcon />}
          </InputGroupSearchIcon>
          <InputGroupSearchInput
            ref={inputRef}
            value={q}
            onChange={(event) => setQ(event.target.value)}
            placeholder={t('searchPlaceholder')}
            aria-label={t('searchPlaceholder')}
            aria-busy={searching || undefined}
            variant="popover"
            className={cn(q && 'pr-9')}
          />
          {q && (
            <InputGroupSearchClear
              aria-label={t('clearSearch')}
              className="opacity-100"
              onClick={() => {
                setQ('');
                inputRef.current?.focus();
              }}
            />
          )}
        </InputGroupSearch>

        {notConfigured ? (
          <InfoBanner tone="neutral" title={t('notConfiguredTitle')}>
            {t('notConfiguredDescription')}
          </InfoBanner>
        ) : apps.isPending ? (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {Array.from({ length: PAGE_SIZE }).map((_, i) => (
              <Skeleton key={i} className="aspect-[4/3] w-full rounded-md" />
            ))}
          </div>
        ) : results.length === 0 ? (
          <p className="text-muted-foreground rounded-md border py-10 text-center text-xs">
            {t('noMatches', { query })}
          </p>
        ) : (
          <div
            role="group"
            aria-label={t('ariaLabel')}
            className="grid grid-cols-3 gap-2 sm:grid-cols-4"
          >
            {results.map((app) => {
              const state = stateOf(app.slug);
              return (
                <button
                  key={app.slug}
                  type="button"
                  // `aria-disabled`, not `disabled`: a connected tile stays
                  // focusable so a screen reader can hear that it is connected.
                  // The click is a no-op; it never signs in a second time.
                  aria-disabled={state !== 'idle' || undefined}
                  aria-busy={state === 'connecting' || undefined}
                  data-state={state}
                  aria-label={
                    state === 'connected'
                      ? t('appConnected', { app: app.name })
                      : t('connectApp', { app: app.name })
                  }
                  onClick={() => {
                    if (state === 'idle') onConnect({ slug: app.slug, name: app.name, provider });
                  }}
                  className={cn(
                    'border-border bg-popover text-foreground relative flex aspect-[4/3] w-full flex-col justify-between rounded-md border p-3 text-left',
                    'transition-[background-color,border-color,scale] duration-(--duration-normal)',
                    'focus-visible:ring-kortix-base focus-visible:ring-[0.6px] focus-visible:outline-none',
                    'data-[state=idle]:hover:border-primary/30 data-[state=idle]:hover:bg-primary/[0.03] data-[state=idle]:cursor-pointer data-[state=idle]:active:scale-[0.97] motion-reduce:active:scale-100',
                    'data-[state=connected]:border-primary/40 data-[state=connected]:bg-primary/[0.05] data-[state=connected]:cursor-default',
                    'data-[state=connecting]:cursor-progress',
                  )}
                >
                  <AppLogo src={app.imgSrc ?? null} />
                  <span className="truncate text-xs font-medium">{app.name}</span>
                  <span aria-hidden className="absolute top-2.5 right-2.5">
                    {state === 'connecting' ? (
                      // `text-foreground!`: inside a <button> the spinner
                      // defaults to `text-background`, built for filled
                      // buttons, and vanishes on this tile.
                      <Loading variant="spokes" className="text-foreground! size-4" />
                    ) : state === 'connected' ? (
                      <CheckCircleIcon weight="fill" className="text-foreground size-4" />
                    ) : null}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </StepShell>
  );
}
