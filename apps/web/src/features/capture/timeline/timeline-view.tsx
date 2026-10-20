'use client';

import {
  CAPTURE_LAYERS,
  type CaptureDevice,
  type CaptureDisplay,
  type CaptureFrame,
  type CaptureSearchHit,
  type CaptureTimeline,
  type CaptureTimelineItems,
} from '@kortix/sdk';
import {
  useCaptureDays,
  useCaptureDevices,
  useCaptureTimeline,
  useCaptureTimelineItems,
} from '@kortix/sdk/react';
import {
  CaretDownIcon,
  CaretLeftIcon,
  CaretRightIcon,
  EyeIcon,
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

import { Button } from '@kortix/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@kortix/ui/dropdown-menu';
import Hint from '@kortix/ui/hint';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@kortix/ui/select';
import { Skeleton } from '@kortix/ui/skeleton';
import { UserAvatar } from '@kortix/ui/user-avatar';
import { EmptyState } from '@kortix/ui/empty-state';
import { useLocale, useTranslations } from '@/i18n/use-translations';

import { CapturePage } from '../area/capture-area-shell';
import {
  captureHref,
  deviceName,
  deviceOs,
  useCaptureArea,
  useCaptureDirectory,
} from '@kortix/ui/internal/capture/use-capture-area';
import { clockTime, indexAtOrBefore, localTimeZone, shortDate } from '../capture-time';
import { deviceStatus } from '../devices/device-status';
import {
  DeviceActionsMenu,
  StatusDot,
  StatusLabel,
  useStatusText,
} from '../devices/device-status-ui';
import {
  activeDisplayAt,
  coveredAt,
  liveState,
  recordedSince,
  type FocusSpan,
  type ScreenItem,
} from './display-model';
import { AllDisplaysStage, DisplayStrip, displayLabel, shortDisplayName } from './display-stage';
import { FrameStage, useFrameSource } from './frame-stage';
import { JumpPopover } from './jump-popover';
import { MomentPanel } from './moment-panel';
import { DeviceSearch } from './search-panel';
import {
  APP_TILE,
  LANES,
  TRACK_HEIGHT,
  TrackCanvas,
  appInkCss,
  type TrackLayers,
} from './track-canvas';
import {
  foldRuns,
  gapAt,
  openingSpp,
  runJumpTarget,
  segCovers,
  type TrackRun,
} from './track-model';
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
 * at the playhead, the controls, the track (apps, actions, audio)
 * under a fixed playhead, and what happens at the playhead on the right. The
 * track's interaction is a port of the Kortix Capture engine's local window:
 * drag with inertia, wheel, click a moment, Cmd/Ctrl+Left/Right between runs.
 */
export function DeviceTimelineView({
  accountId,
  deviceId,
}: {
  accountId: string;
  deviceId: string;
}) {
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
  const people = useCaptureDirectory(accountId, area.readsEveryone);
  const person = people.personOf(device.user_id);
  // Your own device reads as you; another member's is read (and audited) by user_id;
  // a device linked to no one by its device_id alone (capture.read_all).
  const userId = person.isYou ? undefined : (device.user_id ?? undefined);
  const deviceId = device.device_id;
  const name = deviceName(device, tDevices('unnamed'));
  const status = deviceStatus(device);
  const statusText = useStatusText();
  const tz = useMemo(() => localTimeZone(), []);
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  // `at` is the area's moment parameter; `t` (a moment link from the Capture API) works too.
  const urlAt = search.get('at') ?? search.get('t');

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
  // Live: the playhead follows the newest indexed moment until the person moves it.
  const [live, setLive] = useState(!urlAt);
  const interact = useCallback(() => {
    follow.current = false;
    setLive(false);
  }, []);
  // Which display the stage shows: the active one (follows focus), all side by side, or one pinned.
  const [pick, setPick] = useState<'active' | 'all' | number>('active');

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
  const timelineQuery = useCaptureTimeline(
    accountId,
    range[1] > range[0]
      ? {
          from: new Date(range[0]).toISOString(),
          to: new Date(range[1]).toISOString(),
          userId,
          deviceId,
          // A pinned display: its runs on the Apps track. Otherwise the focused display's.
          displayId: typeof pick === 'number' ? pick : undefined,
        }
      : null,
  );
  const timeline = useLatest<CaptureTimeline>(timelineQuery.data);
  const displays = useMemo<CaptureDisplay[]>(() => timeline?.displays ?? [], [timeline]);
  const multi = displays.length > 1;
  const focus = useMemo<FocusSpan[]>(
    () =>
      (timeline?.focus ?? [])
        .filter((f) => f.device_id === deviceId)
        .map((f) => ({
          display_id: f.display_id,
          s: Date.parse(f.start_at),
          e: Date.parse(f.end_at),
        })),
    [timeline, deviceId],
  );
  const screenItems = useMemo<ScreenItem[]>(
    () =>
      (timeline?.chunks ?? [])
        .filter((c) => c.kind === 'chunk' && c.device_id === deviceId)
        .map((c) => ({
          display_id: c.display_id ?? null,
          s: Date.parse(c.start_at),
          e: Date.parse(c.end_at),
        })),
    [timeline, deviceId],
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

  // ── Frames, actions and transcript around the playhead ────────────────────
  const anchor = Math.floor(view.T / ITEMS_ALIGN) * ITEMS_ALIGN;
  const itemsQuery = useCaptureTimelineItems(
    accountId,
    bounds
      ? {
          from: new Date(anchor - ITEMS_BEFORE).toISOString(),
          to: new Date(anchor + ITEMS_AFTER).toISOString(),
          userId,
          deviceId,
          // Every display's frames, so the stage can follow focus and show all displays.
          displayId: multi ? 'all' : undefined,
        }
      : null,
  );
  const items = useLatest<CaptureTimelineItems>(itemsQuery.data);
  const allFrames = useMemo(
    () => (items?.frames ?? []).filter((f) => f.device_id === deviceId),
    [items, deviceId],
  );
  const framesOf = useCallback(
    (displayId: number | null): CaptureFrame[] =>
      multi ? allFrames.filter((f) => f.display_id === displayId) : allFrames,
    [allFrames, multi],
  );
  // The focused display's frames until the shown display is known (the pad needs frames first).
  const focusedFrames = useMemo(
    () => (multi ? allFrames.filter((f) => f.focused !== false) : allFrames),
    [allFrames, multi],
  );
  // The capture interval: the median gap between frames, at least 2 s (the run end pad).
  const pad = useMemo(() => {
    const gaps = focusedFrames
      .slice(1)
      .map((f, i) => Date.parse(f.ts) - Date.parse(focusedFrames[i]!.ts))
      .filter((g) => g > 0)
      .sort((x, y) => x - y);
    return Math.min(30_000, Math.max(2_000, gaps[Math.floor(gaps.length / 2)] ?? 2_000));
  }, [focusedFrames]);
  // The display on the stage: the pinned one, else the one holding focus at the playhead.
  const activeDisplay = multi
    ? (activeDisplayAt(focus, view.T, pad) ??
      focusedFrames[indexAtOrBefore(focusedFrames, view.T)]?.display_id ??
      displays.find((d) => d.main)?.id ??
      displays[0]!.id)
    : null;
  const shownDisplay = typeof pick === 'number' ? pick : activeDisplay;
  const frames = useMemo(() => framesOf(shownDisplay), [framesOf, shownDisplay]);
  const frameIdx = indexAtOrBefore(frames, view.T);
  const frame = frameIdx >= 0 ? frames[frameIdx]! : null;
  // Recorded when the playhead sits in a screen item of that display: a still screen writes
  // no new frames, so the last frame at or before the playhead is what was on screen.
  // A still display writes a keep-alive frame every 30 s: the last frame holds until then.
  const covered =
    coveredAt(screenItems, view.T, multi ? shownDisplay : null) ||
    recordedSince(frame ? Date.parse(frame.ts) : null, view.T);
  const offFrame = !frame || !covered;
  const { video, shown: display } = useFrameSource(accountId, frame, userId);

  // The opening scale, once the first runs land.
  const scaled = useRef(false);
  useEffect(() => {
    if (!trackW || !runs.length || !bounds || scaled.current) return;
    scaled.current = true;
    scrubber.zoom(openingSpp(bounds.last, runs, trackW, pad).spp / scrubber.get().spp);
  }, [trackW, runs, bounds, pad, scrubber]);

  // ── Navigation ────────────────────────────────────────────────────────────
  // A run jump past the loaded runs reads the 24 hours that way, then lands on the nearest run start.
  const [farJump, setFarJump] = useState<{
    dir: -1 | 1;
    T: number;
    from: number;
    instant: boolean;
  } | null>(null);
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
    const starts = (far.data?.runs ?? [])
      .filter((r) => r.device_id === deviceId)
      .map((r) => Date.parse(r.start_at));
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
      if (day)
        scrubber.panTo(Date.parse(farJump.dir < 0 ? day.end_at : day.start_at), farJump.instant);
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
      const next =
        dir > 0
          ? frames.find((f) => Date.parse(f.ts) > T + 1)
          : frames[indexAtOrBefore(frames, T - 1)];
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
    [scrubber, interact, setPlaying],
  );
  const goLive = useCallback(() => {
    if (!bounds) return;
    follow.current = true;
    setLive(true);
    setPlaying(false);
    scrubber.panTo(bounds.last);
  }, [bounds, scrubber, setPlaying]);
  // In Live, read the newest items every 10 s; the playhead advances when they land.
  const refetchDays = days.refetch;
  const refetchTimeline = timelineQuery.refetch;
  const refetchItems = itemsQuery.refetch;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const poll = setInterval(() => {
      void refetchDays();
      void refetchTimeline();
      void refetchItems();
    }, 10_000);
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [live, refetchDays, refetchTimeline, refetchItems]);
  // Previous / next recorded day: the end of the one before, the start of the one after.
  const dayJump = (dir: -1 | 1) => {
    const T = scrubber.get().T;
    const day =
      dir < 0
        ? dayList.find((d) => Date.parse(d.start_at) < T - MINUTE)
        : [...dayList]
            .reverse()
            .find((d) => Date.parse(d.end_at) > T + MINUTE && Date.parse(d.start_at) > T);
    if (day)
      jumpTo(
        Date.parse(
          dir < 0 ? (Date.parse(day.end_at) < T ? day.end_at : day.start_at) : day.start_at,
        ),
      );
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

  // A hit opens on the display it was found on: the active view when that display had focus, else pinned.
  const pickHit = (hit: CaptureSearchHit) => {
    const at = Date.parse(hit.ts);
    jumpTo(at);
    if (multi && hit.display_id != null)
      setPick(activeDisplayAt(focus, at, pad) === hit.display_id ? 'active' : hit.display_id);
  };
  // Per display when the device reports its displays: that display's last frame and its newest indexed item.
  const reported = (
    (device.live.status as { displays?: Array<{ id?: unknown; lastFrameMs?: unknown }> } | null)
      ?.displays ?? []
  ).find((d) => d.id === shownDisplay);
  const shownItemsEnd = screenItems
    .filter((item) => !multi || item.display_id === shownDisplay)
    .reduce<number | null>((last, item) => (last === null || item.e > last ? item.e : last), null);
  const liveInfo = live
    ? liveState({
        status: status.key,
        lastFrameMs:
          typeof reported?.lastFrameMs === 'number' ? reported.lastFrameMs : status.lastFrameMs,
        newestIndexedMs: shownItemsEnd ?? bounds?.last ?? null,
        now,
      })
    : null;
  // Live and the device still records: the newest indexed frame, labelled as behind, never "no recording".
  const uploading = liveInfo?.kind === 'uploading';
  const behindSeconds =
    liveInfo && Number.isFinite(liveInfo.behindMs)
      ? Math.round((liveInfo.behindMs ?? 0) / 1000)
      : null;
  const liveLabel = !uploading
    ? null
    : behindSeconds === null
      ? t('liveState.uploadingFirst')
      : behindSeconds < 120
        ? t('liveState.uploadingSeconds', { n: behindSeconds })
        : t('liveState.uploadingMinutes', { n: Math.round(behindSeconds / 60) });
  const stageDimmed = offFrame && !uploading;
  const shownDisplayInfo = multi ? (displays.find((d) => d.id === shownDisplay) ?? null) : null;
  const gap = gapAt(runs, view.T, pad);
  const runUnder = runs.find((r) => r.s <= view.T && view.T <= r.e + pad) ?? null;
  const metaApp = stageDimmed ? null : (frame?.app ?? runUnder?.app ?? null);
  const noData = days.isSuccess && dayList.length === 0;
  const legend = useMemo(() => {
    const seen = new Map<string, TrackRun>();
    for (const r of runs) if (r.app && !seen.has(r.app)) seen.set(r.app, r);
    return [...seen.keys()].slice(0, 8);
  }, [runs]);
  const time = clockTime(view.T, locale, true);
  const date = shortDate(view.T, locale);

  return (
    <main className="flex flex-col">
      {/* Who and which computer, its live status, and the tools of the page. */}
      <div className="flex flex-col gap-3 border-b px-4 pt-4 pb-3 sm:px-6">
        <nav aria-label={t('breadcrumb')} className="flex items-center gap-2 text-xs">
          <Link
            href={captureHref(accountId, 'devices')}
            className="text-muted-foreground hover:text-foreground"
          >
            {tDevices('title')}
          </Link>
          <span aria-hidden className="text-muted-foreground">
            /
          </span>
          <span className="text-foreground truncate">{name}</span>
        </nav>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="text-foreground min-w-0 truncate text-xl font-medium">{name}</h1>
            <div
              className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs"
              aria-live="polite"
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <UserAvatar email={person.email ?? ''} size="xs" />
                <span className="text-foreground truncate">
                  {person.isYou
                    ? tDevices('you')
                    : person.userId === null
                      ? tDevices('unlinked')
                      : (person.email ?? tDevices('member'))}
                </span>
              </span>
              <span aria-hidden>·</span>
              <span>{deviceOs(device)}</span>
              <span aria-hidden>·</span>
              <StatusLabel view={status} />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1">
              <Hint label={t('previousDay')}>
                <Button
                  variant="outline"
                  size="icon-base"
                  aria-label={t('previousDay')}
                  onClick={() => dayJump(-1)}
                >
                  <CaretLeftIcon className="size-3.5 shrink-0" />
                </Button>
              </Hint>
              <JumpPopover T={view.T} days={dayList} bounds={bounds} onJump={jumpTo} />
              <Hint label={t('nextDay')}>
                <Button
                  variant="outline"
                  size="icon-base"
                  aria-label={t('nextDay')}
                  onClick={() => dayJump(1)}
                >
                  <CaretRightIcon className="size-3.5 shrink-0" />
                </Button>
              </Hint>
            </div>
            <DeviceSearch
              accountId={accountId}
              userId={userId}
              deviceId={deviceId}
              onPick={pickHit}
            />
            {multi ? (
              <Select
                value={String(pick)}
                onValueChange={(value) =>
                  setPick(value === 'active' || value === 'all' ? value : Number(value))
                }
              >
                <SelectTrigger size="sm" aria-label={t('display.picker')} className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">{t('display.active')}</SelectItem>
                  <SelectItem value="all">{t('display.all')}</SelectItem>
                  {displays.map((d) => (
                    <SelectItem key={d.id} value={String(d.id)}>
                      {displayLabel(d, displays, t)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            {/* What the stage and the track show; each layer turns on and off on its own. */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="gap-1.5" aria-label={t('layers')}>
                  <EyeIcon className="size-3.5 shrink-0" />
                  {CAPTURE_LAYERS.every((layer) => layers[layer])
                    ? t('layersAll')
                    : CAPTURE_LAYERS.filter((layer) => layers[layer])
                        .map((layer) => t(`layer.${layer}`))
                        .join(', ') || t('layersNone')}
                  <CaretDownIcon className="text-muted-foreground size-3 shrink-0" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuLabel>{t('layers')}</DropdownMenuLabel>
                {CAPTURE_LAYERS.map((layer) => (
                  <DropdownMenuCheckboxItem
                    key={layer}
                    checked={layers[layer]}
                    onCheckedChange={(on) => setLayers((cur) => ({ ...cur, [layer]: on }))}
                    onSelect={(event) => event.preventDefault()}
                  >
                    {t(`layer.${layer}`)}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Hint label={t('liveHint')}>
              <Button
                variant={live ? 'secondary' : 'outline'}
                size="sm"
                className="gap-1.5"
                aria-pressed={live}
                disabled={!bounds}
                onClick={goLive}
              >
                {/* Green only while the device records: the dot repeats the device status. */}
                <StatusDot view={status} />
                {t('live')}
              </Button>
            </Hint>
            {area.canManage || device.user_id === people.viewerId ? (
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
          <div className="bg-muted relative flex aspect-16/10 max-h-[calc(100svh-24rem)] min-h-48 w-full overflow-hidden rounded-md border">
            {layers.screen && pick === 'all' && multi ? (
              <AllDisplaysStage
                accountId={accountId}
                userId={userId}
                displays={displays}
                activeId={activeDisplay}
                frameOf={(id) => framesOf(id)[indexAtOrBefore(framesOf(id), view.T)] ?? null}
                recorded={(id) => coveredAt(screenItems, view.T, id)}
                onPick={(id) => setPick(id)}
              />
            ) : layers.screen ? (
              <FrameStage
                src={display.src}
                seconds={display.seconds}
                label={t('frame.label', { app: metaApp ?? t('unknownApp') })}
                dimmed={stageDimmed}
                failedLabel={stageDimmed || noData ? null : t('frame.failed')}
              >
                {noData ? (
                  <StageNotice
                    title={t('empty.noDataTitle', { device: name })}
                    body={statusText(status)}
                  />
                ) : !frame && liveLabel ? (
                  <StageNotice title={liveLabel} />
                ) : video?.encrypted && !stageDimmed ? (
                  <StageNotice title={t('frame.encrypted')} />
                ) : bounds && stageDimmed ? (
                  <StageNotice
                    title={
                      gap && !live ? t('track.gap', { shortcut: `${MOD_KEY()}←` }) : t('frame.none')
                    }
                    body={live ? statusText(status) : undefined}
                  />
                ) : null}
                {bounds && !stageDimmed ? (
                  <div className="absolute bottom-3 left-3 z-10 flex flex-wrap gap-2">
                    <span className="bg-foreground text-background rounded-sm px-2 py-0.5 text-xs tabular-nums">
                      {time}
                    </span>
                    {metaApp ? (
                      <span className="bg-popover text-foreground flex items-center gap-1.5 rounded-sm border px-2 py-0.5 text-xs">
                        <span
                          aria-hidden
                          className="ring-border flex size-4 items-center justify-center rounded-sm text-xs font-semibold ring-1"
                          style={{ background: APP_TILE, color: appInkCss(metaApp) }}
                        >
                          {metaApp.charAt(0).toUpperCase()}
                        </span>
                        {metaApp}
                      </span>
                    ) : null}
                    {liveLabel ? (
                      <span
                        className="bg-popover text-muted-foreground rounded-sm border px-2 py-0.5 text-xs"
                        aria-live="polite"
                      >
                        {liveLabel}
                      </span>
                    ) : null}
                  </div>
                ) : null}
                {shownDisplayInfo ? (
                  <span className="bg-popover text-foreground absolute top-3 left-3 z-10 rounded-sm border px-2 py-0.5 text-xs">
                    {displayLabel(shownDisplayInfo, displays, t)}
                    {pick === 'active' ? (
                      <span className="text-muted-foreground"> · {t('display.activeBadge')}</span>
                    ) : null}
                  </span>
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
                  {playing ? (
                    <PauseIcon className="size-3.5 shrink-0" />
                  ) : (
                    <PlayIcon className="size-3.5 shrink-0" />
                  )}
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
              <span className="text-foreground ml-2 text-sm font-medium tabular-nums">{time}</span>
              <span className="text-muted-foreground text-xs">{date}</span>
            </div>
            <div className="flex items-center gap-2">
              <Select
                value={String(speed)}
                onValueChange={(value) => setSpeed(Number(value) as (typeof SPEEDS)[number])}
              >
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
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label={t('zoomOut')}
                  onClick={() => scrubber.zoomTween(1.6)}
                >
                  <MinusIcon className="size-3.5 shrink-0" />
                </Button>
              </Hint>
              <Hint label={t('zoomIn')}>
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label={t('zoomIn')}
                  onClick={() => scrubber.zoomTween(1 / 1.6)}
                >
                  <PlusIcon className="size-3.5 shrink-0" />
                </Button>
              </Hint>
            </div>
          </div>

          <div
            className="bg-background relative flex overflow-hidden rounded-md border select-none"
            style={{ height: TRACK_HEIGHT }}
          >
            <div aria-hidden className="bg-popover relative w-24 shrink-0 border-r">
              {(['apps', 'actions', 'audio'] as const).map((lane) =>
                (lane === 'actions' && !layers.actions) ||
                (lane === 'audio' && !layers.audio) ? null : (
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
                layers={layers}
                pad={pad}
                onWidth={setTrackW}
              />
            </div>
          </div>

          {multi ? (
            <DisplayStrip
              displays={displays}
              items={screenItems}
              focus={focus}
              T={view.T}
              spp={view.spp}
              width={trackW}
              shownId={shownDisplay}
              label={(d) => displayLabel(d, displays, t)}
              short={(d) => shortDisplayName(d, displays, t)}
              title={t('display.strip')}
            />
          ) : null}
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            {legend.map((app) => (
              <span key={app} className="flex items-center gap-1.5">
                {/* The track's own tile: the letter tells apart two apps that share a hue. */}
                <span
                  aria-hidden
                  className="ring-border flex size-4 items-center justify-center rounded-sm text-xs font-semibold ring-1"
                  style={{ background: APP_TILE, color: appInkCss(app) }}
                >
                  {app.charAt(0).toUpperCase()}
                </span>
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
          title={stageDimmed ? null : (frame?.title ?? runUnder?.title ?? null)}
          url={stageDimmed ? null : (frame?.url ?? runUnder?.url ?? null)}
          actions={
            layers.actions ? (items?.actions ?? []).filter((x) => x.device_id === deviceId) : []
          }
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
