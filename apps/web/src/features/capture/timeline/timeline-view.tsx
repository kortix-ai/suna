'use client';

import type { CaptureSearchHit } from '@kortix/sdk';
import {
  useCaptureDays,
  useCaptureDevices,
  useCaptureFrame,
  useCaptureSearch,
  useCaptureTimeline,
  useCaptureTimelineItems,
} from '@kortix/sdk/react';
import {
  BookmarkSimpleIcon,
  CaretDownIcon,
  CaretLeftIcon,
  CaretRightIcon,
  MagnifyingGlassIcon,
} from '@phosphor-icons/react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { InfoBanner } from '@/components/ui/info-banner';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Toggle } from '@/components/ui/toggle';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';

import {
  clockTime,
  dayWindow,
  durationParts,
  indexAtOrBefore,
  localDayOf,
  localTimeZone,
  shortDate,
  trackSpan,
} from '../capture-time';
import { useCaptureMembers, useCaptureParams, useCaptureViewer } from '../use-capture-viewer';
import { FrameViewer } from './frame-viewer';
import { MomentDetails } from './moment-details';
import { SaveRangeModal } from './save-range-modal';
import { TimelineTrack, type TrackLayers } from './timeline-track';

const MINUTE = 60_000;
/** Items load for a window around the moment, aligned to 5 minutes so small moves reuse it. */
const ITEMS_BEFORE = 10 * MINUTE;
const ITEMS_AFTER = 15 * MINUTE;

function useDuration() {
  const t = useTranslations('capture');
  return (seconds: number) => {
    const { hours, minutes } = durationParts(seconds);
    return hours > 0
      ? t('duration.hoursMinutes', { hours, minutes })
      : t('duration.minutes', { minutes });
  };
}

function SearchResults({
  hits,
  loading,
  onPick,
}: {
  hits: CaptureSearchHit[];
  loading: boolean;
  onPick: (hit: CaptureSearchHit) => void;
}) {
  const t = useTranslations('capture.timeline');
  const locale = useLocale();
  if (loading) {
    return (
      <div className="space-y-1">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-14 rounded-md" />
        ))}
      </div>
    );
  }
  if (hits.length === 0)
    return (
      <p className="text-muted-foreground px-3 py-6 text-center text-xs">{t('search.none')}</p>
    );
  return (
    <ul className="space-y-2" aria-label={t('search.results')}>
      {hits.map((hit) => (
        <li key={`${hit.kind}-${hit.id}`}>
          <button
            type="button"
            onClick={() => onPick(hit)}
            className="bg-background hover:bg-hover flex w-full items-start gap-3 rounded-md border px-4 py-2.5 text-left transition-colors active:scale-[0.998]"
          >
            <Badge variant="outline" size="sm" className="mt-0.5 shrink-0">
              {t(`search.kind.${hit.kind}`)}
            </Badge>
            <span className="min-w-0 flex-1 space-y-0.5">
              <span className="text-foreground block truncate text-sm font-medium">
                {[hit.app, hit.title].filter(Boolean).join(' — ') || t(`search.kind.${hit.kind}`)}
              </span>
              <span className="text-muted-foreground line-clamp-2 block text-xs wrap-anywhere">
                {hit.snippet}
              </span>
            </span>
            <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
              {shortDate(hit.ts, locale)} · {clockTime(hit.ts, locale)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * Timeline — one person's day: the screen at a moment, the track of app runs,
 * actions and audio, the moment's details, search across what they saw, did
 * and heard, and Save range. A manager picks a member (`?user=`); the API
 * writes a `capture.member_view` audit row for every such read.
 */
export function TimelineView({ projectId }: { projectId: string }) {
  const t = useTranslations('capture.timeline');
  const locale = useLocale();
  const duration = useDuration();
  const viewer = useCaptureViewer(projectId);
  const params = useCaptureParams();
  const tz = useMemo(() => localTimeZone(), []);
  const [now] = useState(() => Date.now());
  const members = useCaptureMembers(projectId, viewer.isManager);
  const userId =
    viewer.isManager && params.user && params.user !== members.viewerId ? params.user : undefined;
  const subject = userId ? members.members.find((member) => member.user_id === userId) : null;
  const deviceId = params.device ?? undefined;

  const devices = useCaptureDevices(projectId, { userId });
  const days = useCaptureDays(projectId, { tz, userId, deviceId });
  const dayList = days.data?.days ?? [];
  const day = params.day ?? (params.at ? localDayOf(params.at) : null) ?? dayList[0]?.day ?? null;
  const dayInfo = dayList.find((entry) => entry.day === day) ?? null;
  const window = day ? dayWindow(day) : null;
  const timeline = useCaptureTimeline(projectId, window ? { ...window, userId, deviceId } : null);
  const runs = timeline.data?.runs ?? [];
  const chunks = timeline.data?.chunks ?? [];
  const ranges = timeline.data?.ranges ?? [];

  const firstMs = dayInfo
    ? Date.parse(dayInfo.start_at)
    : runs[0]
      ? Date.parse(runs[0].start_at)
      : null;
  const lastMs = dayInfo
    ? Date.parse(dayInfo.end_at)
    : runs.length
      ? Date.parse(runs[runs.length - 1]!.end_at)
      : null;
  const span = day ? trackSpan(day, firstMs, lastMs) : null;
  const at = params.at ? Date.parse(params.at) : lastMs;

  const itemsWindow = useMemo(() => {
    if (at === null) return null;
    const anchor = Math.floor(at / (5 * MINUTE)) * 5 * MINUTE;
    return {
      from: new Date(anchor - ITEMS_BEFORE).toISOString(),
      to: new Date(anchor + ITEMS_AFTER).toISOString(),
      userId,
      deviceId,
    };
  }, [at, userId, deviceId]);
  const items = useCaptureTimelineItems(projectId, itemsWindow);
  const frames = useMemo(
    () => (items.data?.frames ?? []).filter((frame) => !frame.inactive),
    [items.data],
  );
  const frameIndex = at === null ? -1 : indexAtOrBefore(frames, at);
  const frame = frameIndex >= 0 ? frames[frameIndex]! : (frames[0] ?? null);
  const frameDetail = useCaptureFrame(projectId, frame?.frame_id ?? null, { userId });
  const rangeAt =
    at === null
      ? null
      : (ranges.find(
          (range) => Date.parse(range.start_at) <= at && at <= Date.parse(range.end_at),
        ) ?? null);

  const [layers, setLayers] = useState<TrackLayers>({ screen: true, actions: true, audio: true });
  const [query, setQuery] = useState(params.q ?? '');
  const { q: urlQuery, set: setParams } = params;
  useEffect(() => {
    const id = setTimeout(() => {
      if ((urlQuery ?? '') !== query.trim()) setParams({ q: query.trim() || null });
    }, 300);
    return () => clearTimeout(id);
  }, [query, urlQuery, setParams]);
  const search = useCaptureSearch(
    projectId,
    params.q ? { q: params.q, userId, deviceId, limit: 30 } : null,
  );
  const [daysOpen, setDaysOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);

  const moveTo = (next: number) => params.set({ at: new Date(next).toISOString() });
  const pickDay = (next: string, end: string) => {
    params.set({ day: next, at: end });
    setDaysOpen(false);
  };
  const pickHit = (hit: CaptureSearchHit) => {
    setQuery('');
    params.set({ q: null, day: localDayOf(hit.ts), at: hit.ts });
  };
  const step = (direction: -1 | 1) => {
    const next = frames[frameIndex + direction];
    if (next) moveTo(Date.parse(next.ts));
  };
  const dayLabel = (value: string) => {
    if (value === localDayOf(now)) return t('today');
    if (value === localDayOf(now - 86_400_000)) return t('yesterday');
    return shortDate(dayWindow(value).from, locale);
  };
  const ownTimeline = !userId;
  const saveInitial = rangeAt
    ? { start: Date.parse(rangeAt.start_at), end: Date.parse(rangeAt.end_at) }
    : { start: (at ?? now) - 15 * MINUTE, end: (at ?? now) + 15 * MINUTE };

  const subjectDevices = (devices.data?.devices ?? []).filter((device) => !device.revoked_at);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-7xl space-y-4 px-4 py-6 pb-20">
        <div className="flex flex-wrap items-center gap-2">
          {viewer.isManager ? (
            <Select
              value={userId ?? 'me'}
              onValueChange={(value) =>
                params.set({
                  user: value === 'me' ? null : value,
                  device: null,
                  day: null,
                  at: null,
                })
              }
            >
              <SelectTrigger aria-label={t('person')} className="h-8 w-auto min-w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="me">{t('you')}</SelectItem>
                {members.members
                  .filter((member) => member.user_id !== members.viewerId)
                  .map((member) => (
                    <SelectItem key={member.user_id} value={member.user_id}>
                      {member.email ?? member.user_id}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          ) : null}

          <Select
            value={deviceId ?? 'all'}
            onValueChange={(value) =>
              params.set({ device: value === 'all' ? null : value, day: null, at: null })
            }
          >
            <SelectTrigger aria-label={t('device')} className="h-8 w-auto min-w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('allDevices')}</SelectItem>
              {subjectDevices.map((device) => (
                <SelectItem key={device.device_id} value={device.device_id}>
                  {device.name ?? t('unnamedDevice')}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Popover open={daysOpen} onOpenChange={setDaysOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                disabled={!day}
                aria-label={t('dayPicker')}
              >
                {day ? dayLabel(day) : t('noDay')}
                <CaretDownIcon className="size-3.5 shrink-0" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-64 p-1">
              <ul aria-label={t('recordedDays')} className="max-h-80 overflow-y-auto">
                {dayList.map((entry) => (
                  <li key={entry.day}>
                    <button
                      type="button"
                      onClick={() => pickDay(entry.day, entry.end_at)}
                      className={cn(
                        'hover:bg-hover flex w-full items-center justify-between gap-3 rounded-sm px-2 py-2 text-left text-sm transition-colors',
                        entry.day === day && 'bg-active',
                      )}
                    >
                      <span>{dayLabel(entry.day)}</span>
                      <span className="text-muted-foreground text-xs tabular-nums">
                        {duration(entry.screen_seconds)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </PopoverContent>
          </Popover>

          <div className="min-w-48 flex-1">
            <InputGroupSearch>
              <InputGroupSearchIcon>
                <MagnifyingGlassIcon />
              </InputGroupSearchIcon>
              <InputGroupSearchInput
                aria-label={t('search.label')}
                placeholder={t('search.placeholder')}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                size="sm"
              />
              <InputGroupSearchClear onClick={() => setQuery('')} />
            </InputGroupSearch>
          </div>
        </div>

        {userId ? (
          <InfoBanner
            tone="neutral"
            title={t('viewingMember', { member: subject?.email ?? t('aMember') })}
          >
            {t('viewingMemberAudit')}
          </InfoBanner>
        ) : null}

        {params.q ? (
          <SearchResults
            hits={search.data?.hits ?? []}
            loading={search.isLoading}
            onPick={pickHit}
          />
        ) : days.isLoading ? (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
            <Skeleton className="aspect-video max-h-96 w-full rounded-md" />
            <Skeleton className="h-64 rounded-md" />
          </div>
        ) : days.isError ? (
          <ErrorState
            size="sm"
            title={t('loadFailed')}
            action={
              <Button variant="outline" size="sm" onClick={() => days.refetch()}>
                {t('tryAgain')}
              </Button>
            }
          />
        ) : !day || !span || at === null ? (
          <EmptyState
            size="sm"
            title={userId ? t('emptyMember') : t('empty')}
            description={userId ? undefined : t('emptyHint')}
            action={
              userId ? undefined : (
                <Button asChild variant="outline" size="sm">
                  <Link href={`/projects/${projectId}/capture/devices`}>{t('connectDevice')}</Link>
                </Button>
              )
            }
          />
        ) : (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
            <div className="min-w-0 space-y-3">
              <FrameViewer
                frame={frame}
                detail={frameDetail.data}
                loading={items.isLoading || frameDetail.isLoading}
              />

              <div className="flex flex-wrap items-center gap-2">
                <span className="text-muted-foreground text-xs">{t('layers')}</span>
                {(['screen', 'actions', 'audio'] as const).map((layer) => (
                  <Toggle
                    key={layer}
                    variant="outline"
                    size="sm"
                    pressed={layers[layer]}
                    onPressedChange={(on) => setLayers((current) => ({ ...current, [layer]: on }))}
                  >
                    {t(`layer.${layer}`)}
                  </Toggle>
                ))}
                <span className="flex-1" />
                <Hint label={t('previousFrame')}>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label={t('previousFrame')}
                    disabled={frameIndex <= 0}
                    onClick={() => step(-1)}
                  >
                    <CaretLeftIcon className="size-3.5 shrink-0" />
                  </Button>
                </Hint>
                <span className="text-foreground min-w-20 text-center text-xs tabular-nums">
                  {clockTime(at, locale, true)}
                </span>
                <Hint label={t('nextFrame')}>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label={t('nextFrame')}
                    disabled={frameIndex < 0 || frameIndex >= frames.length - 1}
                    onClick={() => step(1)}
                  >
                    <CaretRightIcon className="size-3.5 shrink-0" />
                  </Button>
                </Hint>
                {ownTimeline ? (
                  <Button size="sm" className="gap-1.5" onClick={() => setSaveOpen(true)}>
                    <BookmarkSimpleIcon className="size-3.5 shrink-0" />
                    {t('saveRange')}
                  </Button>
                ) : null}
              </div>

              <TimelineTrack
                projectId={projectId}
                userParam={userId ?? null}
                span={span}
                runs={runs}
                chunks={chunks}
                ranges={ranges}
                layers={layers}
                at={at}
                bounds={{ first: firstMs ?? span.start, last: lastMs ?? span.end }}
                onMove={moveTo}
              />
              {ownTimeline ? (
                <p className="text-muted-foreground text-xs text-pretty">{t('auditNotice')}</p>
              ) : null}
            </div>

            <MomentDetails
              projectId={projectId}
              userParam={userId ?? null}
              at={at}
              frame={frameDetail.data?.frame ?? frame}
              ocrText={frameDetail.data?.frame.ocr_text ?? frame?.ocr_text ?? null}
              actions={items.data?.actions ?? []}
              audio={items.data?.audio ?? []}
              range={rangeAt}
              layers={layers}
            />
          </div>
        )}
      </div>

      {day && ownTimeline ? (
        <SaveRangeModal
          projectId={projectId}
          open={saveOpen}
          onOpenChange={setSaveOpen}
          dayStart={Date.parse(dayWindow(day).from)}
          initial={saveInitial}
          deviceId={deviceId ?? null}
        />
      ) : null}
    </div>
  );
}
