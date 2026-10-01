'use client';

/**
 * `/capture` — search and replay what a computer showed.
 *
 * Own captures by default. An owner or admin can switch to a member's captures
 * only while the owner allows it, and the API logs each such read; the banner
 * says so for as long as the view is open.
 */

import {
  getCaptureTimeline,
  searchCapture,
  type CaptureSearchItem,
  type CaptureTimeline,
} from '@kortix/sdk';
import { ArrowLeftIcon, EyeIcon, MagnifyingGlassIcon, RecordIcon } from '@phosphor-icons/react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useMemo, useRef, useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { EmptyState } from '@/features/layout/section/empty-state';
import { useAuth } from '@/features/providers/auth-provider';
import { useEnsureSelectedAccount } from '@/hooks/account/use-ensure-selected-account';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { useAppHome } from '@/lib/onboarding/use-app-home';
import { cn } from '@/lib/utils';

import { chunkSpan, dayBounds, localDay, snippetParts } from './capture-model';
import { ChunkPlayer, type PlayerSelection } from './chunk-player';
import {
  captureKeys,
  useCaptureAccount,
  useCaptureDevices,
  useCaptureMembers,
} from './use-capture';

interface Filters {
  q: string;
  app: string;
  domain: string;
  from: string;
  to: string;
}

const NO_FILTERS: Filters = { q: '', app: '', domain: '', from: '', to: '' };
const ME = '__me__';

export function CapturePage() {
  const t = useTranslations('capture');
  const locale = useLocale();
  const appHome = useAppHome();
  const { user } = useAuth();
  useEnsureSelectedAccount();
  const { accountId, isManager, settings } = useCaptureAccount();
  const devices = useCaptureDevices();

  const [draft, setDraft] = useState<Filters>(NO_FILTERS);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [day, setDay] = useState(() => localDay(new Date()));
  const [selection, setSelection] = useState<PlayerSelection | null>(null);
  const [viewing, setViewing] = useState(ME);
  const nonce = useRef(0);
  const qc = useQueryClient();

  const canPickMember = isManager && settings.data?.admins_can_view === true;
  const members = useCaptureMembers(accountId, canPickMember);
  const otherUser = canPickMember && viewing !== ME ? viewing : undefined;
  const viewedMember = members.data?.find((m) => m.user_id === otherUser);
  const scope = otherUser ?? 'me';

  const results = useInfiniteQuery({
    queryKey: ['capture', 'search', accountId, scope, filters],
    enabled: !!accountId,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      searchCapture(accountId!, {
        q: filters.q.trim(),
        app: filters.app.trim(),
        domain: filters.domain.trim(),
        from: filters.from ? dayBounds(filters.from).from : undefined,
        to: filters.to ? dayBounds(filters.to).to : undefined,
        user_id: otherUser,
        limit: 20,
        cursor: pageParam,
      }),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  const items = useMemo(() => results.data?.pages.flatMap((p) => p.items) ?? [], [results.data]);

  const timelineFor = (d: string) => ({
    queryKey: captureKeys.timeline(accountId ?? '', scope, d),
    enabled: !!accountId,
    queryFn: (): Promise<CaptureTimeline> =>
      getCaptureTimeline(accountId!, { ...dayBounds(d), user_id: otherUser }),
    staleTime: 30_000,
  });
  const timeline = useQuery(timelineFor(day));

  const pick = (
    chunk: { chunk_id: string; started_at: string; ended_at: string },
    frameIndex: number,
  ) => {
    nonce.current += 1;
    setSelection({
      chunkId: chunk.chunk_id,
      frameIndex,
      startedAt: chunk.started_at,
      endedAt: chunk.ended_at,
      nonce: nonce.current,
    });
  };

  // A search result names a chunk; the timeline of its day has the chunk's bounds.
  const [resolving, setResolving] = useState<number | null>(null);
  const openResult = async (item: CaptureSearchItem) => {
    setResolving(item.frame_id);
    try {
      const itemDay = localDay(new Date(item.ts));
      const tl = await qc.fetchQuery(timelineFor(itemDay));
      const chunk = tl.chunks.find((c) => c.chunk_id === item.chunk_id);
      if (chunk) {
        setDay(itemDay);
        pick(chunk, item.frame_index);
      }
    } finally {
      setResolving(null);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setFilters(draft);
  };

  const filtered = Object.values(filters).some(Boolean);
  const ownView = !otherUser;
  const accountDevices = (devices.data ?? []).filter((d) => d.account_id === accountId);
  const loading = !accountId || settings.isLoading || results.isLoading;
  const nothing = !loading && items.length === 0 && (timeline.data?.chunks.length ?? 0) === 0;

  const emptyState = (() => {
    if (!nothing || filtered || !ownView) return null;
    if (settings.data && !settings.data.enabled) {
      return (
        <EmptyState
          icon={RecordIcon}
          title={t('emptyOffTitle')}
          description={isManager ? t('emptyOffAdmin') : t('emptyOffMember')}
          action={
            <Button asChild size="sm" variant="secondary">
              <Link href="/settings/capture">{t('openSettings')}</Link>
            </Button>
          }
        />
      );
    }
    if (devices.isSuccess && accountDevices.length === 0) {
      return (
        <EmptyState
          icon={RecordIcon}
          title={t('emptyNoDevicesTitle')}
          description={t('emptyNoDevicesBody')}
          action={
            <Button asChild size="sm" variant="secondary">
              <Link href="/settings/capture">{t('openSettings')}</Link>
            </Button>
          }
        />
      );
    }
    return (
      <EmptyState
        icon={RecordIcon}
        title={t('emptyNothingTitle')}
        description={t('emptyNothingBody')}
      />
    );
  })();

  const fmtTime = (value: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'medium' }).format(
      new Date(value),
    );
  const fmtClock = (value: string) =>
    new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(new Date(value));

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 px-6 py-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button asChild size="sm" variant="ghost" aria-label={t('back')}>
            <Link href={appHome}>
              <ArrowLeftIcon className="size-4" />
            </Link>
          </Button>
          <h1 className="text-foreground-strong text-xl">{t('pageTitle')}</h1>
        </div>
        {canPickMember ? (
          <Select
            value={viewing}
            onValueChange={(v) => {
              setViewing(v);
              setSelection(null);
            }}
          >
            <SelectTrigger aria-label={t('memberPicker')} className="h-8 w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ME}>{t('myCaptures')}</SelectItem>
              {(members.data ?? [])
                .filter((m) => m.user_id !== user?.id)
                .map((m) => (
                  <SelectItem key={m.user_id} value={m.user_id}>
                    {m.email ?? m.user_id}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        ) : null}
      </header>

      {otherUser ? (
        <InfoBanner tone="warning" icon={EyeIcon} data-testid="capture-member-banner">
          {t('viewingBanner', { name: viewedMember?.email ?? otherUser })}
        </InfoBanner>
      ) : null}

      <div className="space-y-2">
        <form onSubmit={submit} className="flex flex-wrap items-end gap-2" role="search">
          <div className="min-w-56 flex-1">
            <Input
              type="search"
              aria-label={t('searchLabel')}
              placeholder={t('searchPlaceholder')}
              value={draft.q}
              onChange={(e) => setDraft({ ...draft, q: e.target.value })}
            />
          </div>
          <Input
            aria-label={t('filterApp')}
            placeholder={t('filterApp')}
            className="w-36"
            value={draft.app}
            onChange={(e) => setDraft({ ...draft, app: e.target.value })}
          />
          <Input
            aria-label={t('filterWebsite')}
            placeholder={t('filterWebsite')}
            className="w-40"
            value={draft.domain}
            onChange={(e) => setDraft({ ...draft, domain: e.target.value })}
          />
          <Input
            type="date"
            aria-label={t('from')}
            className="w-40"
            value={draft.from}
            onChange={(e) => setDraft({ ...draft, from: e.target.value })}
          />
          <Input
            type="date"
            aria-label={t('to')}
            className="w-40"
            value={draft.to}
            onChange={(e) => setDraft({ ...draft, to: e.target.value })}
          />
          <Button type="submit" variant="secondary">
            <MagnifyingGlassIcon className="size-4" />
            {t('search')}
          </Button>
        </form>
        <p className="text-muted-foreground text-xs">{t('searchHint')}</p>
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <Loading className="size-5" />
        </div>
      ) : emptyState ? (
        emptyState
      ) : (
        <>
          <section className="space-y-3" aria-label={t('timelineTitle')}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-foreground text-sm font-medium">{t('timelineTitle')}</h2>
              <Input
                type="date"
                aria-label={t('day')}
                className="h-8 w-40"
                value={day}
                max={localDay(new Date())}
                onChange={(e) => e.target.value && setDay(e.target.value)}
              />
            </div>
            <div
              className="bg-muted border-border relative h-9 overflow-hidden rounded-md border"
              data-testid="capture-timeline"
            >
              {(timeline.data?.chunks ?? []).map((chunk) => {
                const span = chunkSpan(chunk, day);
                const active = selection?.chunkId === chunk.chunk_id;
                return (
                  <button
                    key={chunk.chunk_id}
                    type="button"
                    data-testid="capture-chunk"
                    aria-label={t('chunkLabel', {
                      from: fmtClock(chunk.started_at),
                      to: fmtClock(chunk.ended_at),
                    })}
                    title={`${fmtClock(chunk.started_at)} – ${fmtClock(chunk.ended_at)}`}
                    className={cn(
                      'absolute inset-y-1 rounded-sm transition-colors',
                      active ? 'bg-foreground' : 'bg-foreground/40 hover:bg-foreground/70',
                    )}
                    style={{ left: `${span.left}%`, width: `${span.width}%` }}
                    onClick={() => pick(chunk, 0)}
                  />
                );
              })}
            </div>
            <div className="text-muted-foreground flex justify-between text-xs" aria-hidden>
              {['00:00', '06:00', '12:00', '18:00', '24:00'].map((h) => (
                <span key={h}>{h}</span>
              ))}
            </div>
            {(timeline.data?.chunks.length ?? 0) === 0 && !timeline.isLoading ? (
              <p className="text-muted-foreground text-sm">{t('timelineEmpty')}</p>
            ) : null}
            {(timeline.data?.apps ?? []).length > 0 ? (
              <ul className="flex flex-wrap gap-2" aria-label={t('appsTitle')}>
                {timeline.data!.apps.slice(0, 8).map((a) => (
                  <li key={a.app_name}>
                    <button
                      type="button"
                      className="bg-muted text-foreground hover:bg-secondary rounded-md px-2 py-1 text-xs"
                      onClick={() => {
                        const next = { ...filters, app: a.app_name };
                        setDraft(next);
                        setFilters(next);
                      }}
                    >
                      {a.app_name} ·{' '}
                      {t('minutes', { count: Math.max(1, Math.round(a.seconds / 60)) })}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>

          <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
            <section aria-label={t('resultsTitle')} className="min-w-0 space-y-2">
              <h2 className="text-foreground text-sm font-medium">
                {filters.q ? t('resultsFor', { q: filters.q }) : t('resultsTitle')}
              </h2>
              {items.length === 0 ? (
                <p className="text-muted-foreground text-sm">{t('noResults')}</p>
              ) : (
                <ul
                  className="divide-border border-border divide-y rounded-md border"
                  data-testid="capture-results"
                >
                  {items.map((item) => (
                    <li key={item.frame_id}>
                      <button
                        type="button"
                        data-testid="capture-result"
                        className="hover:bg-muted/60 flex w-full flex-col gap-0.5 px-3 py-2 text-left"
                        disabled={resolving === item.frame_id}
                        onClick={() => void openResult(item)}
                      >
                        <span className="text-muted-foreground text-xs">
                          {fmtTime(item.ts)}
                          {item.app_name ? ` · ${item.app_name}` : ''}
                        </span>
                        <span className="text-foreground truncate text-sm font-medium">
                          {item.window_title || t('untitled')}
                        </span>
                        {item.url ? (
                          <span className="text-muted-foreground truncate text-xs">{item.url}</span>
                        ) : null}
                        {item.snippet ? (
                          <span className="text-muted-foreground line-clamp-2 text-xs">
                            {snippetParts(item.snippet).map((part, i) =>
                              part.match ? (
                                <b key={i} className="text-foreground font-semibold">
                                  {part.text}
                                </b>
                              ) : (
                                <span key={i}>{part.text}</span>
                              ),
                            )}
                          </span>
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {results.hasNextPage ? (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={results.isFetchingNextPage}
                  onClick={() => results.fetchNextPage()}
                >
                  {t('loadMore')}
                </Button>
              ) : null}
            </section>

            <section className="min-w-0" aria-label={t('playerTitle')}>
              {selection && accountId ? (
                <ChunkPlayer accountId={accountId} userId={otherUser} selection={selection} />
              ) : (
                <p className="text-muted-foreground border-border rounded-md border border-dashed p-6 text-center text-sm">
                  {t('pickPrompt')}
                </p>
              )}
            </section>
          </div>
        </>
      )}
    </main>
  );
}
