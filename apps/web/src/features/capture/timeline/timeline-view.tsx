'use client';

import type {
  CaptureDevice,
  CaptureSearchHit,
  CaptureTimeline,
  CaptureTimelineItems,
} from '@kortix/sdk';
import {
  useCaptureChunkMedia,
  useCaptureDays,
  useCaptureDevices,
  useCaptureTimeline,
  useCaptureTimelineItems,
} from '@kortix/sdk/react';
import {
  CaretLeftIcon,
  CaretRightIcon,
  MinusIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  SkipBackIcon,
  SkipForwardIcon,
} from '@phosphor-icons/react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Toggle } from '@/components/ui/toggle';
import { UserAvatar } from '@/components/ui/user-avatar';
import { EmptyState } from '@/features/layout/section/empty-state';
import { useLocale, useTranslations } from '@/i18n/use-translations';

import { CapturePage } from '../area/capture-area-shell';
import {
  captureHref,
  deviceName,
  deviceOs,
  useCaptureArea,
  useCapturePeople,
} from '../area/use-capture-area';
import { indexAtOrBefore, localTimeZone } from '../capture-time';
import { deviceStatus } from '../devices/device-status';
import { DeviceActionsMenu, StatusDot, useStatusText } from '../devices/device-status-ui';
import { FrameStage } from './frame-stage';
import { JumpPopover } from './jump-popover';
import { MomentPanel } from './moment-panel';
import { DeviceSearch } from './search-panel';
import {
  APP_TILE,
  LANES,
  TRACK_HEIGHT,
  TrackCanvas,
  appInkCss,
  type TrackEpisode,
  type TrackLayers,
} from './track-canvas';
import { foldRuns, gapAt, openingSpp, runJumpTarget, segCovers, type TrackRun } from './track-model';
import { useScrubber } from './use-scrubber';

const MINUTE = 60_000;
const DAY = 86_400_000;
const MAX_SPAN = 31 * DAY;
/** Frames load for a window around the playhead, aligned to 2 minutes (500 frames at most per read). */
const ITEMS_ALIGN = 2 * MINUTE;
const ITEMS_BEFORE = 3 * MINUTE;
const ITEMS_AFTER = 5 * MINUTE;
const SPEEDS = [1, 4, 16] as const;

/** Keep the last answer on screen while the next window loads: the track never blanks while it scrolls. */
function useLatest<T>(value: T | undefined): T | undefined {
  const [latest, setLatest] = useState(value);
  if (value !== undefined && value !== latest) setLatest(value);
  return value ?? latest;
}

const MOD_KEY = () =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';

/**
 * A device's timeline (`/capture/[accountId]/devices/[deviceId]`): the frame
 * at the playhead, the controls, the track (episodes, apps, actions, audio)
 * under a fixed playhead, and what happens at the playhead on the right. The
 * track's interaction is a port of the Kortix Capture engine's local window:
 * drag with inertia, wheel, click a moment, Cmd/Ctrl+Left/Right between runs.
 */
export function DeviceTimelineView({ accountId, deviceId }: { accountId: string; deviceId: string }) {
  const t = useTranslations('capture.timeline');
  const tDevices = useTranslations('capture.devices');
  const area = useCaptureArea(accountId);
  const devices = useCaptureDevices(accountId, { scope: area.readsEveryone ? 'account' : 'mine' });
  const device = devices.data?.devices.find((d) => d.device_id === deviceId) ?? null;

  if (devices.isLoading) {
    return (
      <main className="flex flex-col gap-4 px-6 pt-4">
        <Skeleton className="h-6 w-64 rounded-md" />
        <Skeleton className="aspect-video max-h-96 rounded-md" />
      </main>
    );
  }
  if (!device) {
    return (
      <CapturePage title={tDevices('title')}>
        <div className="bg-background rounded-md border px-4 py-12">
          <EmptyState
            size="sm"
            title={t('notFound', { name: area.accountName })}
            action={
              <Button asChild variant="outline" size="sm">
                <Link href={captureHref(accountId, 'devices')}>{t('backToDevices')}</Link>
              </Button>
            }
          />
        </div>
      </CapturePage>
    );
  }
  return <DeviceTimeline key={device.device_id} accountId={accountId} device={device} />;
}

function DeviceTimeline({ accountId, device }: { accountId: string; device: CaptureDevice }) {
  const t = useTranslations('capture.timeline');
  const tDevices = useTranslations('capture.devices');
  const locale = useLocale();
  const area = useCaptureArea(accountId);
  const people = useCapturePeople(accountId, area.readsEveryone);
  const person = people.personOf(device.user_id);
  // Your own device reads as you; another member's is read (and audited) by user_id.
  const userId = person.isYou ? undefined : device.user_id;
  const deviceId = device.device_id;
  const name = deviceName(device, tDevices('unnamed'));
  const status = deviceStatus(device);
  const statusText = useStatusText();
  const tz = useMemo(() => localTimeZone(), []);
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const urlAt = search.get('at');

  // ── Bounds and days ───────────────────────────────────────────────────────
  const days = useCaptureDays(accountId, { tz, userId, deviceId });
  const dayList = useMemo(() => days.data?.days ?? [], [days.data]);
  const bounds = useMemo(() => {
    if (!dayList.length) return null;
    return {
      first: Math.min(...dayList.map((d) => Date.parse(d.start_at))),
      last: Math.max(...dayList.map((d) => Date.parse(d.end_at))),
    };
  }, [dayList]);

  // ── Playhead ──────────────────────────────────────────────────────────────
  const [initialAt] = useState(() => (urlAt ? Date.parse(urlAt) : Date.now()));
  const { scrubber, view } = useScrubber(initialAt, bounds);
  const [trackW, setTrackW] = useState(0);
  const follow = useRef(!urlAt);
  const placed = useRef(false);
  useEffect(() => {
    if (!bounds || placed.current) return;
    placed.current = true;
    const requested = urlAt ? Date.parse(urlAt) : NaN;
    follow.current = !Number.isFinite(requested);
    scrubber.setT(Number.isFinite(requested) ? requested : bounds.last);
  }, [bounds, urlAt, scrubber]);
  // Live: while following, new recordings move the playhead to the newest frame.
  const lastSeen = useRef<number | null>(null);
  useEffect(() => {
    if (!bounds) return;
    if (follow.current && lastSeen.current !== null && bounds.last > lastSeen.current)
      scrubber.setT(bounds.last);
    lastSeen.current = bounds.last;
  }, [bounds, scrubber]);
  const [playing, setPlaying] = useState(false);
  const interact = useCallback(() => {
    follow.current = false;
  }, []);

  // ── Runs for the visible window and a margin ──────────────────────────────
  const [range, setRange] = useState<[number, number]>([0, 0]);
  const a = view.T - (trackW / 2) * view.spp;
  const b = view.T + (trackW / 2) * view.spp;
  if (trackW && !segCovers(range, a, b)) {
    // At least 6 hours each way, so a run jump and the gap hint see the neighbouring sessions.
    const span = b - a;
    let from = Math.floor(Math.min(a - span * 2, view.T - 6 * 3_600_000));
    let to = Math.ceil(Math.max(b + span * 2, view.T + 6 * 3_600_000));
    if (to - from > MAX_SPAN) {
      from = Math.floor(view.T - MAX_SPAN / 2);
      to = from + MAX_SPAN;
    }
    setRange([from, to]);
  }
  const timeline = useLatest<CaptureTimeline>(
    useCaptureTimeline(
      accountId,
      range[1] > range[0]
        ? { from: new Date(range[0]).toISOString(), to: new Date(range[1]).toISOString(), userId, deviceId }
        : null,
    ).data,
  );
  const runs = useMemo<TrackRun[]>(
    () =>
      (timeline?.runs ?? [])
        .filter((r) => r.device_id === deviceId)
        .map((r) => ({
          s: Date.parse(r.start_at),
          e: Date.parse(r.end_at),
          k: r.app ?? r.title,
          app: r.app,
          title: r.title,
          url: r.url,
        })),
    [timeline, deviceId],
  );
  const lanes = useMemo(() => {
    const of = (kind: 'audio' | 'actions') =>
      (timeline?.chunks ?? [])
        .filter((c) => c.kind === kind && c.device_id === deviceId)
        .map((c) => ({ s: Date.parse(c.start_at), e: Date.parse(c.end_at) }));
    return { audio: of('audio'), actions: of('actions') };
  }, [timeline, deviceId]);
  // Episodes arrive with the intelligence pipeline (L1); until then the lane stays empty.
  const episodes = useMemo<TrackEpisode[]>(() => [], []);

  // ── Frames, actions and transcript around the playhead ────────────────────
  const anchor = Math.floor(view.T / ITEMS_ALIGN) * ITEMS_ALIGN;
  const items = useLatest<CaptureTimelineItems>(
    useCaptureTimelineItems(
      accountId,
      bounds
        ? {
            from: new Date(anchor - ITEMS_BEFORE).toISOString(),
            to: new Date(anchor + ITEMS_AFTER).toISOString(),
            userId,
            deviceId,
          }
        : null,
    ).data,
  );
  const frames = useMemo(
    () => (items?.frames ?? []).filter((f) => !f.inactive && f.device_id === deviceId),
    [items, deviceId],
  );
  // The capture interval: the median gap between frames, at least 2 s (the run end pad).
  const pad = useMemo(() => {
    const gaps = frames
      .slice(1)
      .map((f, i) => Date.parse(f.ts) - Date.parse(frames[i]!.ts))
      .filter((g) => g > 0)
      .sort((x, y) => x - y);
    return Math.min(30_000, Math.max(2_000, gaps[Math.floor(gaps.length / 2)] ?? 2_000));
  }, [frames]);
  const frameIdx = indexAtOrBefore(frames, view.T);
  const frame = frameIdx >= 0 ? frames[frameIdx]! : null;
  const offFrame = !frame || view.T - Date.parse(frame.ts) > pad * 1.5;
  const media = useCaptureChunkMedia(accountId, frame?.chunk_id ?? null, { userId });
  const video = media.data?.chunk_id === frame?.chunk_id ? (media.data?.video ?? null) : null;
  // While the next chunk's URL loads, the stage keeps the last frame it showed: no blank flash mid-scrub.
  const nextShown = video && !video.encrypted ? { src: video.url, seconds: frame?.frame_index ?? 0 } : null;
  const [shown, setShown] = useState<{ src: string | null; seconds: number }>({ src: null, seconds: 0 });
  if (nextShown && (nextShown.src !== shown.src || nextShown.seconds !== shown.seconds)) setShown(nextShown);
  const display = nextShown ?? (media.isFetching && frame ? shown : { src: null, seconds: 0 });

  // The opening scale, once the first runs land.
  const scaled = useRef(false);
  useEffect(() => {
    if (!trackW || !runs.length || !bounds || scaled.current) return;
    scaled.current = true;
    scrubber.zoom(openingSpp(bounds.last, runs, trackW, pad).spp / scrubber.get().spp);
  }, [trackW, runs, bounds, pad, scrubber]);

  // ── Navigation ────────────────────────────────────────────────────────────
  // A run jump past the loaded runs reads the 24 hours that way, then lands on the nearest run start.
  const [farJump, setFarJump] = useState<{ dir: -1 | 1; T: number; from: number; instant: boolean } | null>(
    null,
  );
  const far = useCaptureTimeline(
    accountId,
    farJump
      ? {
          from: new Date(farJump.dir < 0 ? farJump.T - DAY : farJump.T + 1).toISOString(),
          to: new Date(farJump.dir < 0 ? farJump.T - 1 : farJump.T + DAY).toISOString(),
          userId,
          deviceId,
        }
      : null,
  );
  useEffect(() => {
    if (!farJump || (!far.data && !far.isError)) return;
    const starts = (far.data?.runs ?? []).filter((r) => r.device_id === deviceId).map((r) => Date.parse(r.start_at));
    const pick =
      farJump.dir < 0
        ? Math.max(...starts.filter((s) => s < farJump.from - 1000), -Infinity)
        : Math.min(...starts.filter((s) => s > farJump.T + 1000), Infinity);
    if (Number.isFinite(pick)) scrubber.panTo(pick, farJump.instant);
    else {
      // Nothing within a day: the nearest recorded day that way.
      const day =
        farJump.dir < 0
          ? dayList.find((d) => Date.parse(d.end_at) < farJump.T - DAY)
          : [...dayList].reverse().find((d) => Date.parse(d.start_at) > farJump.T + DAY);
      if (day) scrubber.panTo(Date.parse(farJump.dir < 0 ? day.end_at : day.start_at), farJump.instant);
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the far read answered; the jump is done
    setFarJump(null);
  }, [farJump, far.data, far.isError, deviceId, dayList, scrubber]);

  const runJump = useCallback(
    (dir: -1 | 1, instant = false) => {
      interact();
      const { T, spp } = scrubber.get();
      const target = runJumpTarget(foldRuns(runs, spp, pad), T, dir, pad);
      if (target != null && Math.abs(target - T) > 1000) {
        scrubber.panTo(target, instant);
        return;
      }
      const from = runs.find((r) => r.s <= T && T <= r.e + pad)?.s ?? T;
      setFarJump({ dir, T, from, instant });
    },
    [runs, pad, scrubber, interact],
  );
  const step = useCallback(
    (dir: -1 | 1) => {
      interact();
      const T = scrubber.get().T;
      const next = dir > 0 ? frames.find((f) => Date.parse(f.ts) > T + 1) : frames[indexAtOrBefore(frames, T - 1)];
      if (next) scrubber.setT(Date.parse(next.ts));
      else runJump(dir, true);
    },
    [frames, scrubber, runJump, interact],
  );
  const jumpTo = useCallback(
    (at: number) => {
      interact();
      setPlaying(false);
      scrubber.panTo(at, true);
    },
    [scrubber, interact],
  );
  const goLive = useCallback(() => {
    if (!bounds) return;
    follow.current = true;
    setPlaying(false);
    scrubber.panTo(bounds.last);
  }, [bounds, scrubber]);
  // Previous / next recorded day: the end of the one before, the start of the one after.
  const dayJump = (dir: -1 | 1) => {
    const T = scrubber.get().T;
    const day =
      dir < 0
        ? dayList.find((d) => Date.parse(d.start_at) < T - MINUTE)
        : [...dayList].reverse().find((d) => Date.parse(d.end_at) > T + MINUTE && Date.parse(d.start_at) > T);
    if (day) jumpTo(Date.parse(dir < 0 ? (Date.parse(day.end_at) < T ? day.end_at : day.start_at) : day.start_at));
  };

  // ── Playback ──────────────────────────────────────────────────────────────
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const T = scrubber.get().T + (now - last) * speed;
      last = now;
      if (bounds && T >= bounds.last) {
        scrubber.setT(bounds.last);
        setPlaying(false);
        return;
      }
      scrubber.setT(T);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, bounds, scrubber]);

  // ── Layers ────────────────────────────────────────────────────────────────
  const [layers, setLayers] = useState<TrackLayers>({ screen: true, actions: true, audio: true });

  // Keyboard first, as in the engine window. `/` (search) lives in the search field.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target?.closest(
          'input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], [role="listbox"], [data-no-scrub]',
        )
      )
        return;
      const mod = event.metaKey || event.ctrlKey;
      if (mod && !event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        event.preventDefault();
        runJump(event.key === 'ArrowLeft' ? -1 : 1, true);
        return;
      }
      if (mod || event.altKey) return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        setPlaying(false);
        if (event.shiftKey) runJump(event.key === 'ArrowLeft' ? -1 : 1, true);
        else step(event.key === 'ArrowLeft' ? -1 : 1);
      } else if (event.key === ' ' && !target?.closest('button, a')) {
        event.preventDefault();
        interact();
        setPlaying((p) => !p);
      } else if (event.key === '+' || event.key === '=') scrubber.zoom(1 / 1.6);
      else if (event.key === '-') scrubber.zoom(1.6);
      else if (event.key === 'l' || event.key === 'L') goLive();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [runJump, step, scrubber, goLive, interact]);

  // Wheel and trackpad move time over the stage and the track; pinch (or Ctrl+wheel) zooms.
  const scrubAreaRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = scrubAreaRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if ((event.target as HTMLElement | null)?.closest('[data-no-scrub]')) return;
      event.preventDefault();
      if (event.ctrlKey) {
        scrubber.zoom(Math.exp(event.deltaY * 0.012));
        return;
      }
      interact();
      scrubber.stop();
      const d = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      scrubber.setT(scrubber.get().T + d * scrubber.get().spp);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [scrubber, interact]);

  // The URL keeps the moment, so a reload or a shared link lands in the same place.
  useEffect(() => {
    if (!bounds || follow.current || playing) return;
    const id = setTimeout(() => {
      const at = new Date(Math.round(view.T)).toISOString();
      if (at === urlAt) return;
      const query = new URLSearchParams(search.toString());
      query.set('at', at);
      router.replace(`${pathname}?${query.toString()}`, { scroll: false });
    }, 600);
    return () => clearTimeout(id);
  }, [view.T, bounds, urlAt, playing, pathname, router, search]);

  const pickHit = (hit: CaptureSearchHit) => jumpTo(Date.parse(hit.ts));
  const gap = gapAt(runs, view.T, pad);
  const runUnder = runs.find((r) => r.s <= view.T && view.T <= r.e + pad) ?? null;
  const metaApp = offFrame ? null : (frame?.app ?? runUnder?.app ?? null);
  const noData = days.isSuccess && dayList.length === 0;
  const legend = useMemo(() => {
    const seen = new Map<string, TrackRun>();
    for (const r of runs) if (r.app && !seen.has(r.app)) seen.set(r.app, r);
    return [...seen.keys()].slice(0, 8);
  }, [runs]);
  const time = new Date(view.T).toLocaleTimeString(locale, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const date = new Date(view.T).toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short' });

  return (
    <main className="flex flex-col">
      {/* Who and which computer, its live status, and the tools of the page. */}
      <div className="flex flex-col gap-3 border-b px-4 pt-4 pb-3 sm:px-6">
        <nav aria-label={t('breadcrumb')} className="flex items-center gap-2 text-xs">
          <Link href={captureHref(accountId, 'devices')} className="text-muted-foreground hover:text-foreground">
            {tDevices('title')}
          </Link>
          <span aria-hidden className="text-muted-foreground">
            /
          </span>
          <span className="text-foreground truncate">{name}</span>
        </nav>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <UserAvatar email={person.email ?? ''} size="md" />
            <h1 className="text-foreground min-w-0 truncate text-xl font-medium">
              {person.isYou ? tDevices('you') : (person.email ?? tDevices('member'))}
              <span className="text-muted-foreground"> · </span>
              {name}
            </h1>
            <span className="text-muted-foreground text-xs">{deviceOs(device)}</span>
            <Badge variant="outline" size="sm" className="gap-1.5" aria-live="polite">
              <StatusDot view={status} />
              {statusText(status)}
            </Badge>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1">
              <Hint label={t('previousDay')}>
                <Button variant="outline" size="icon-sm" aria-label={t('previousDay')} onClick={() => dayJump(-1)}>
                  <CaretLeftIcon className="size-3.5 shrink-0" />
                </Button>
              </Hint>
              <JumpPopover T={view.T} days={dayList} bounds={bounds} onJump={jumpTo} />
              <Hint label={t('nextDay')}>
                <Button variant="outline" size="icon-sm" aria-label={t('nextDay')} onClick={() => dayJump(1)}>
                  <CaretRightIcon className="size-3.5 shrink-0" />
                </Button>
              </Hint>
            </div>
            <DeviceSearch accountId={accountId} userId={userId} deviceId={deviceId} onPick={pickHit} />
            <div role="group" aria-label={t('layers')} className="bg-muted flex items-center gap-0.5 rounded-md p-0.5">
              {(['screen', 'actions', 'audio'] as const).map((layer) => (
                <Toggle
                  key={layer}
                  size="sm"
                  pressed={layers[layer]}
                  onPressedChange={(on) => setLayers((cur) => ({ ...cur, [layer]: on }))}
                  className="data-[state=on]:bg-background h-7 px-2.5 data-[state=on]:shadow-xs"
                >
                  {t(`layer.${layer}`)}
                </Toggle>
              ))}
            </div>
            <Hint label={t('liveHint')}>
              <Button variant="outline" size="sm" className="gap-1.5" disabled={!bounds} onClick={goLive}>
                <span aria-hidden className="bg-kortix-green size-2 rounded-full" />
                {t('live')}
              </Button>
            </Hint>
            {area.isAdmin ? (
              <DeviceActionsMenu
                accountId={accountId}
                device={device}
                name={name}
                onRevoked={() => router.push(captureHref(accountId, 'devices'))}
              />
            ) : null}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-start gap-5 px-4 pt-4 pb-10 sm:px-6">
        <section
          ref={scrubAreaRef}
          aria-label={t('player')}
          className="flex min-w-0 grow-999 basis-xl flex-col gap-3"
        >
          <div className="bg-muted relative flex aspect-16/10 max-h-[70vh] min-h-48 w-full overflow-hidden rounded-md border">
            {layers.screen ? (
              <FrameStage
                src={display.src}
                seconds={display.seconds}
                label={t('frame.label', { app: metaApp ?? t('unknownApp') })}
                dimmed={offFrame}
              >
                {noData ? (
                  <StageNotice title={t('empty.noDataTitle', { device: name })} body={statusText(status)} />
                ) : video?.encrypted && !offFrame ? (
                  <StageNotice title={t('frame.encrypted')} />
                ) : bounds && offFrame ? (
                  <StageNotice title={gap ? t('track.gap', { shortcut: `${MOD_KEY()}←` }) : t('frame.none')} />
                ) : null}
                {bounds && !offFrame ? (
                  <div className="absolute bottom-3 left-3 z-10 flex flex-wrap gap-2">
                    <Badge size="sm" className="bg-foreground text-background font-mono tabular-nums">
                      {time}
                    </Badge>
                    {metaApp ? (
                      <Badge variant="outline" size="sm" className="bg-popover gap-1.5">
                        <span
                          aria-hidden
                          className="ring-border flex size-4 items-center justify-center rounded-sm text-xs font-semibold ring-1"
                          style={{ background: APP_TILE, color: appInkCss(metaApp) }}
                        >
                          {metaApp.charAt(0).toUpperCase()}
                        </span>
                        {metaApp}
                      </Badge>
                    ) : null}
                  </div>
                ) : null}
              </FrameStage>
            ) : (
              <StageNotice title={t('screenHidden')} />
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-1.5">
              <Hint label={t('previousRun', { shortcut: `${MOD_KEY()}←` })}>
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label={t('previousRun', { shortcut: `${MOD_KEY()}←` })}
                  disabled={!bounds}
                  onClick={() => runJump(-1)}
                >
                  <SkipBackIcon className="size-3.5 shrink-0" />
                </Button>
              </Hint>
              <Hint label={playing ? t('pause') : t('play')}>
                <Button
                  size="icon-sm"
                  aria-label={playing ? t('pause') : t('play')}
                  disabled={!bounds}
                  onClick={() => {
                    interact();
                    setPlaying((p) => !p);
                  }}
                >
                  {playing ? <PauseIcon className="size-3.5 shrink-0" /> : <PlayIcon className="size-3.5 shrink-0" />}
                </Button>
              </Hint>
              <Hint label={t('nextRun', { shortcut: `${MOD_KEY()}→` })}>
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label={t('nextRun', { shortcut: `${MOD_KEY()}→` })}
                  disabled={!bounds}
                  onClick={() => runJump(1)}
                >
                  <SkipForwardIcon className="size-3.5 shrink-0" />
                </Button>
              </Hint>
              <span className="text-foreground ml-2 font-mono text-sm font-medium tabular-nums">{time}</span>
              <span className="text-muted-foreground text-xs">{date}</span>
            </div>
            <div className="flex items-center gap-2">
              <Select value={String(speed)} onValueChange={(value) => setSpeed(Number(value) as (typeof SPEEDS)[number])}>
                <SelectTrigger size="sm" aria-label={t('speed')} className="w-20">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SPEEDS.map((s) => (
                    <SelectItem key={s} value={String(s)}>
                      {s}×
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Hint label={t('zoomOut')}>
                <Button variant="outline" size="icon-sm" aria-label={t('zoomOut')} onClick={() => scrubber.zoomTween(1.6)}>
                  <MinusIcon className="size-3.5 shrink-0" />
                </Button>
              </Hint>
              <Hint label={t('zoomIn')}>
                <Button variant="outline" size="icon-sm" aria-label={t('zoomIn')} onClick={() => scrubber.zoomTween(1 / 1.6)}>
                  <PlusIcon className="size-3.5 shrink-0" />
                </Button>
              </Hint>
            </div>
          </div>

          <div className="bg-background relative flex overflow-hidden rounded-md border select-none" style={{ height: TRACK_HEIGHT }}>
            <div aria-hidden className="bg-popover relative w-20 shrink-0 border-r">
              {(['episodes', 'apps', 'actions', 'audio'] as const).map((lane) =>
                (lane === 'actions' && !layers.actions) || (lane === 'audio' && !layers.audio) ? null : (
                  <span
                    key={lane}
                    className="text-muted-foreground absolute left-3 -translate-y-1/2 text-xs"
                    style={{ top: LANES[lane] }}
                  >
                    {t(`lane.${lane}`)}
                  </span>
                ),
              )}
            </div>
            {/* ←/→ and Cmd/Ctrl+←/→ reach the window's key handler; the slider exposes the playhead. */}
            <div
              role="slider"
              tabIndex={0}
              aria-label={t('trackLabel')}
              aria-valuemin={bounds?.first}
              aria-valuemax={bounds?.last}
              aria-valuenow={Math.round(view.T)}
              aria-valuetext={new Date(view.T).toLocaleString(locale)}
              className="focus-visible:ring-ring min-w-0 flex-1 outline-none focus-visible:ring-2 focus-visible:ring-inset"
              onPointerDown={() => {
                interact();
                setPlaying(false);
              }}
            >
              <TrackCanvas
                scrubber={scrubber}
                runs={runs}
                audio={lanes.audio}
                actions={lanes.actions}
                episodes={episodes}
                layers={layers}
                pad={pad}
                onWidth={setTrackW}
                onEpisode={(ep) => jumpTo(ep.s)}
              />
            </div>
          </div>

          <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            {legend.map((app) => (
              <span key={app} className="flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="ring-border flex size-3.5 items-center justify-center rounded-sm ring-1"
                  style={{ background: appInkCss(app) }}
                />
                {app}
              </span>
            ))}
            <span className="ml-auto">{t('keysHint', { mod: MOD_KEY() })}</span>
          </div>
        </section>

        <MomentPanel
          className="min-w-0 grow basis-sm xl:max-w-md"
          at={view.T}
          app={metaApp}
          title={offFrame ? null : (frame?.title ?? runUnder?.title ?? null)}
          url={offFrame ? null : (frame?.url ?? runUnder?.url ?? null)}
          actions={layers.actions ? (items?.actions ?? []).filter((x) => x.device_id === deviceId) : []}
          audio={layers.audio ? (items?.audio ?? []).filter((x) => x.device_id === deviceId) : []}
          onJump={jumpTo}
        />
      </div>
    </main>
  );
}

function StageNotice({ title, body }: { title: string; body?: string }) {
  return (
    <div className="absolute top-1/2 left-1/2 z-10 flex max-w-sm -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-2 px-6 text-center">
      <p className="text-foreground text-sm font-medium text-balance">{title}</p>
      {body ? <p className="text-muted-foreground text-xs text-pretty">{body}</p> : null}
    </div>
  );
}

