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
  DotsThreeIcon,
  MagnifyingGlassIcon,
  MinusIcon,
  PlusIcon,
  StackIcon,
} from '@phosphor-icons/react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import Hint from '@/components/ui/hint';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useOptionalSidebar } from '@/components/ui/sidebar';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { SidebarToggle } from '@/features/workspace/project-layout/sidebar-toggle';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { desktopDownloadUrl } from '@/lib/desktop';

import { dayWindow, indexAtOrBefore, localDayOf, localTimeZone } from '../capture-time';
import { CaptureDialog } from '../desktop/capture-dialog';
import { useDesktopCaptureStatus } from '../desktop/use-desktop-capture';
import { deviceStatus } from '../devices/device-status';
import { useCaptureMembers, useCaptureParams, useCaptureViewer } from '../use-capture-viewer';
import { DevicePicker, StatusDot, useStatusText } from './device-picker';
import { FrameStage } from './frame-stage';
import { JumpPopover } from './jump-popover';
import { SaveRangeModal } from './save-range-modal';
import { SearchPanel } from './search-panel';
import { APP_TILE, TrackCanvas, appInkCss, type TrackLayers } from './track-canvas';
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
const MAX_SPAN = 31 * 86_400_000;
/** Frames load for a window around the playhead, aligned to 2 minutes (500 frames at most per read). */
const ITEMS_ALIGN = 2 * MINUTE;
const ITEMS_BEFORE = 3 * MINUTE;
const ITEMS_AFTER = 5 * MINUTE;

/** Keep the last answer on screen while the next window loads: the track never blanks while it scrolls. */
function useLatest<T>(value: T | undefined): T | undefined {
  const ref = useRef(value);
  if (value !== undefined) ref.current = value;
  return value ?? ref.current;
}

/** The viewer's most recently active device, else the newest one. */
function defaultDevice(devices: readonly CaptureDevice[], thisComputer: string | null | undefined) {
  if (thisComputer) {
    const here = devices.find((d) => d.device_id === thisComputer);
    if (here) return here;
  }
  const seen = (d: CaptureDevice) =>
    Math.max(Date.parse(d.live.reported_at ?? '') || 0, Date.parse(d.created_at) || 0);
  return [...devices].sort((a, b) => seen(b) - seen(a))[0] ?? null;
}

const MOD_KEY = () =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';

/**
 * Timeline — a device's continuous recording, 24/7. Pick a computer (a
 * manager picks a person first); the frame at the playhead fills the page; the
 * track scrolls under a fixed playhead: drag it, scroll it, click a moment,
 * Cmd/Ctrl+Left/Right between runs. The interaction is a port of the Kortix
 * Capture engine's local timeline window.
 */
export function TimelineView({ projectId }: { projectId: string }) {
  const t = useTranslations('capture.timeline');
  const tDevices = useTranslations('capture.devices');
  const locale = useLocale();
  const sidebar = useOptionalSidebar();
  const viewer = useCaptureViewer(projectId);
  const params = useCaptureParams();
  const members = useCaptureMembers(projectId, viewer.isManager);
  const tz = useMemo(() => localTimeZone(), []);
  const userId =
    viewer.isManager && params.user && params.user !== members.viewerId ? params.user : undefined;

  // ── Device ────────────────────────────────────────────────────────────────
  const devicesQuery = useCaptureDevices(projectId, { userId });
  const devices = useMemo(
    () => (devicesQuery.data?.devices ?? []).filter((d) => !d.revoked_at),
    [devicesQuery.data],
  );
  const desktop = useDesktopCaptureStatus();
  // A Capture device has its own identity: its name, never a computer agent's.
  const nameOf = useCallback((d: CaptureDevice) => d.name || tDevices('unnamed'), [tDevices]);
  const device =
    devices.find((d) => d.device_id === params.device) ??
    defaultDevice(devices, userId ? null : desktop.data?.deviceId);
  const deviceId = device?.device_id;
  const status = device ? deviceStatus(device) : null;
  const statusText = useStatusText();

  // ── Bounds and days ───────────────────────────────────────────────────────
  const days = useCaptureDays(deviceId ? projectId : null, { tz, userId, deviceId });
  const dayList = useMemo(() => days.data?.days ?? [], [days.data]);
  const bounds = useMemo(() => {
    const list = days.data?.days ?? [];
    if (!list.length) return null;
    return {
      first: Math.min(...list.map((d) => Date.parse(d.start_at))),
      last: Math.max(...list.map((d) => Date.parse(d.end_at))),
    };
  }, [days.data]);

  // ── Playhead ──────────────────────────────────────────────────────────────
  const [initialAt] = useState(() => (params.at ? Date.parse(params.at) : Date.now()));
  const { scrubber, view } = useScrubber(initialAt, bounds);
  const [trackW, setTrackW] = useState(0);
  const follow = useRef(!params.at);
  const placedFor = useRef<string | null>(null);

  // A new device (or the first bounds): the requested moment, else the newest frame, and follow it.
  useEffect(() => {
    if (!bounds || !deviceId) return;
    const key = `${deviceId}:${userId ?? ''}`;
    if (placedFor.current === key) return;
    placedFor.current = key;
    const requested = params.at ? Date.parse(params.at) : NaN;
    follow.current = !Number.isFinite(requested);
    scrubber.setT(Number.isFinite(requested) ? requested : bounds.last);
  }, [bounds, deviceId, userId, params.at, scrubber]);
  // While following, a live device moves the playhead to its newest frame.
  const lastSeen = useRef<number | null>(null);
  useEffect(() => {
    if (!bounds) return;
    if (follow.current && lastSeen.current !== null && bounds.last > lastSeen.current)
      scrubber.setT(bounds.last);
    lastSeen.current = bounds.last;
  }, [bounds, scrubber]);
  const interact = useCallback(() => {
    follow.current = false;
  }, []);

  // ── Runs for the visible window and a margin ──────────────────────────────
  const [range, setRange] = useState<[number, number]>([0, 0]);
  useEffect(() => {
    if (!trackW || !deviceId) return;
    const a = view.T - (trackW / 2) * view.spp;
    const b = view.T + (trackW / 2) * view.spp;
    if (segCovers(range, a, b)) return;
    const span = b - a;
    // At least 6 hours each way, so a run jump and the gap hint see the neighbouring sessions.
    let from = Math.floor(Math.min(a - span * 2, view.T - 6 * 3_600_000));
    let to = Math.ceil(Math.max(b + span * 2, view.T + 6 * 3_600_000));
    if (to - from > MAX_SPAN) {
      from = Math.floor(view.T - MAX_SPAN / 2);
      to = from + MAX_SPAN;
    }
    setRange([from, to]);
  }, [view.T, view.spp, trackW, deviceId, range]);
  const timeline = useLatest<CaptureTimeline>(
    useCaptureTimeline(
      projectId,
      deviceId && range[1] > range[0]
        ? {
            from: new Date(range[0]).toISOString(),
            to: new Date(range[1]).toISOString(),
            userId,
            deviceId,
          }
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
  const audio = useMemo(
    () =>
      (timeline?.chunks ?? [])
        .filter((c) => c.kind === 'audio' && c.device_id === deviceId)
        .map((c) => ({ s: Date.parse(c.start_at), e: Date.parse(c.end_at) })),
    [timeline, deviceId],
  );
  const actions = useMemo(
    () =>
      (timeline?.chunks ?? [])
        .filter((c) => c.kind === 'actions' && c.device_id === deviceId)
        .map((c) => ({ s: Date.parse(c.start_at), e: Date.parse(c.end_at) })),
    [timeline, deviceId],
  );

  // ── Frames around the playhead ────────────────────────────────────────────
  const anchor = Math.floor(view.T / ITEMS_ALIGN) * ITEMS_ALIGN;
  const items = useLatest<CaptureTimelineItems>(
    useCaptureTimelineItems(
      projectId,
      deviceId && bounds
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
      .sort((a, b) => a - b);
    return Math.min(30_000, Math.max(2_000, gaps[Math.floor(gaps.length / 2)] ?? 2_000));
  }, [frames]);
  const frameIdx = indexAtOrBefore(frames, view.T);
  const frame = frameIdx >= 0 ? frames[frameIdx]! : null;
  const offFrame = !frame || view.T - Date.parse(frame.ts) > pad * 1.5;
  const media = useCaptureChunkMedia(projectId, frame?.chunk_id ?? null, { userId });
  const video = media.data?.chunk_id === frame?.chunk_id ? (media.data?.video ?? null) : null;
  // While the next chunk's URL loads, the stage keeps the last frame it showed: no blank flash mid-scrub.
  const shown = useRef<{ src: string | null; seconds: number }>({ src: null, seconds: 0 });
  const nextShown =
    video && !video.encrypted ? { src: video.url, seconds: frame?.frame_index ?? 0 } : null;
  const display =
    nextShown ?? (media.isFetching && frame ? shown.current : { src: null, seconds: 0 });
  useEffect(() => {
    if (nextShown) shown.current = nextShown;
  });

  // The opening scale, once the first runs land for a device.
  const scaledFor = useRef<string | null>(null);
  useEffect(() => {
    if (!deviceId || !trackW || !runs.length || !bounds || scaledFor.current === deviceId) return;
    scaledFor.current = deviceId;
    const { spp } = openingSpp(bounds.last, runs, trackW, pad);
    scrubber.zoom(spp / scrubber.get().spp);
  }, [deviceId, trackW, runs, bounds, pad, scrubber]);

  // ── Navigation ────────────────────────────────────────────────────────────
  // A run jump past the loaded runs reads the 24 hours that way, then lands on the nearest run start.
  const [farJump, setFarJump] = useState<{
    dir: -1 | 1;
    T: number;
    from: number;
    instant: boolean;
  } | null>(null);
  const far = useCaptureTimeline(
    projectId,
    farJump && deviceId
      ? {
          from: new Date(farJump.dir < 0 ? farJump.T - 86_400_000 : farJump.T + 1).toISOString(),
          to: new Date(farJump.dir < 0 ? farJump.T - 1 : farJump.T + 86_400_000).toISOString(),
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
          ? dayList.find((d) => Date.parse(d.end_at) < farJump.T - 86_400_000)
          : [...dayList].reverse().find((d) => Date.parse(d.start_at) > farJump.T + 86_400_000);
      if (day)
        scrubber.panTo(Date.parse(farJump.dir < 0 ? day.end_at : day.start_at), farJump.instant);
    }
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
      scrubber.panTo(at, true);
    },
    [scrubber, interact],
  );

  // ── Panels ────────────────────────────────────────────────────────────────
  const [searchOpen, setSearchOpen] = useState(false);
  const [layers, setLayers] = useState<TrackLayers>({ actions: true, audio: true });
  const [saveOpen, setSaveOpen] = useState(false);
  const [recordOpen, setRecordOpen] = useState(false);

  // Keyboard first, as in the engine window.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target?.closest(
          'input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], [role="listbox"]',
        )
      )
        return;
      if (searchOpen) return;
      const mod = event.metaKey || event.ctrlKey;
      if (mod && !event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        event.preventDefault();
        runJump(event.key === 'ArrowLeft' ? -1 : 1, true);
        return;
      }
      if (mod && (event.key === '=' || event.key === '+')) {
        event.preventDefault();
        scrubber.zoom(1 / 1.6);
        return;
      }
      if (mod && event.key === '-') {
        event.preventDefault();
        scrubber.zoom(1.6);
        return;
      }
      if (mod && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        setSearchOpen(true);
        return;
      }
      if (mod || event.altKey) return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        if (event.shiftKey) runJump(event.key === 'ArrowLeft' ? -1 : 1, true);
        else step(event.key === 'ArrowLeft' ? -1 : 1);
      } else if (event.key === '/') {
        event.preventDefault();
        setSearchOpen(true);
      } else if (event.key === '+' || event.key === '=') scrubber.zoom(1 / 1.6);
      else if (event.key === '-') scrubber.zoom(1.6);
      else if ((event.key === 'n' || event.key === 'N') && bounds) {
        follow.current = true;
        scrubber.panTo(bounds.last, true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [searchOpen, runJump, step, scrubber, bounds]);

  // Wheel and trackpad move time anywhere over the stage and the track; pinch (or Ctrl+wheel) zooms.
  const scrubAreaRef = useRef<HTMLDivElement>(null);
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
  const { set: setParams, at: urlAt } = params;
  useEffect(() => {
    if (!bounds || follow.current) return;
    const id = setTimeout(() => {
      const at = new Date(Math.round(view.T)).toISOString();
      if (at !== urlAt) setParams({ at, day: null });
    }, 600);
    return () => clearTimeout(id);
  }, [view.T, bounds, urlAt, setParams]);

  const pickDevice = (id: string) => {
    placedFor.current = null;
    scaledFor.current = null;
    setRange([0, 0]);
    setParams({ device: id, at: null, day: null });
  };
  const pickUser = (id: string | null) => {
    placedFor.current = null;
    scaledFor.current = null;
    setRange([0, 0]);
    setParams({ user: id, device: null, at: null, day: null });
  };
  const pickHit = (hit: CaptureSearchHit) => {
    setSearchOpen(false);
    jumpTo(Date.parse(hit.ts));
  };

  const gap = gapAt(runs, view.T, pad);
  const runUnder = runs.find((r) => r.s <= view.T && view.T <= r.e + pad) ?? null;
  const metaApp = offFrame ? null : (frame?.app ?? runUnder?.app ?? null);
  const metaTitle = offFrame ? null : (frame?.title ?? runUnder?.title ?? null);
  const metaUrl = offFrame ? null : (frame?.url ?? null);
  const loadingDevices = devicesQuery.isLoading;
  const noDevices = !loadingDevices && devices.length === 0;
  const noData = !!device && days.isSuccess && dayList.length === 0;
  const own = !userId;
  const saveDay = dayWindow(localDayOf(view.T));
  const saveInitial = runUnder
    ? { start: runUnder.s, end: runUnder.e + pad }
    : { start: view.T - 15 * MINUTE, end: view.T + 15 * MINUTE };

  return (
    <div className="flex h-svh min-h-0 flex-col overflow-hidden">
      {/* Header: whose computer, what is on screen, and the tools. */}
      <header
        className="kx-titlebar-row kx-capability-titlebar relative flex shrink-0 items-center gap-3 border-b px-2"
        data-sidebar-collapsed={sidebar?.state === 'collapsed' || undefined}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <SidebarToggle />
          <h1 className="sr-only">{t('title')}</h1>
          {loadingDevices ? (
            <Skeleton className="h-6 w-40 rounded-md" />
          ) : (
            <DevicePicker
              projectId={projectId}
              devices={devices}
              device={device}
              nameOf={nameOf}
              onPick={pickDevice}
              isManager={viewer.isManager}
              members={members.members}
              viewerId={members.viewerId}
              userId={userId}
              onPickUser={pickUser}
              canRecordHere={Boolean(desktop.data?.available)}
              onRecordHere={() => setRecordOpen(true)}
            />
          )}
        </div>
        <div className="flex h-9 max-w-md min-w-0 shrink items-center gap-2.5 max-md:hidden">
          {metaApp || metaTitle ? (
            <>
              <span
                aria-hidden
                className="ring-border flex size-6 shrink-0 items-center justify-center rounded-sm text-xs font-semibold ring-1"
                style={{ background: APP_TILE, color: appInkCss(metaApp) }}
              >
                {(metaApp ?? '?').charAt(0).toUpperCase()}
              </span>
              <span className="min-w-0">
                <span className="text-foreground block truncate text-sm font-medium">
                  {metaApp ?? t('unknownApp')}
                </span>
                <span className="text-muted-foreground block truncate font-mono text-xs">
                  {[metaTitle, metaUrl].filter(Boolean).join(' · ')}
                </span>
              </span>
            </>
          ) : null}
        </div>
        <div className="flex min-w-0 flex-1 items-center justify-end gap-1">
          <Button
            variant="secondary"
            size="sm"
            className="gap-2"
            disabled={!device}
            onClick={() => setSearchOpen(true)}
          >
            <MagnifyingGlassIcon className="size-3.5 shrink-0" />
            <span className="max-sm:hidden">{t('search.open')}</span>
            <kbd className="text-muted-foreground font-mono text-xs max-sm:hidden">/</kbd>
          </Button>
          <Popover>
            <Hint label={t('layers')}>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={t('layers')}>
                  <StackIcon className="size-4 shrink-0" />
                </Button>
              </PopoverTrigger>
            </Hint>
            <PopoverContent align="end" className="w-56 space-y-1 p-2">
              {(['actions', 'audio'] as const).map((layer) => (
                <label
                  key={layer}
                  className="flex items-center justify-between gap-3 rounded-sm px-2 py-1.5 text-sm"
                >
                  {t(`layer.${layer}`)}
                  <Switch
                    checked={layers[layer]}
                    onCheckedChange={(on) => setLayers((cur) => ({ ...cur, [layer]: on }))}
                  />
                </label>
              ))}
            </PopoverContent>
          </Popover>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t('more')}>
                <DotsThreeIcon className="size-4 shrink-0" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              {own && device && bounds ? (
                <DropdownMenuItem onSelect={() => setSaveOpen(true)}>
                  {t('saveRange')}
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem asChild>
                <Link
                  href={`/projects/${projectId}/capture/ranges${userId ? `?user=${userId}` : ''}`}
                >
                  {t('menu.ranges')}
                </Link>
              </DropdownMenuItem>
              {viewer.isManager ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem asChild>
                    <Link href={`/projects/${projectId}/capture/people`}>{t('menu.people')}</Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link href={`/projects/${projectId}/capture/settings`}>
                      {t('menu.settings')}
                    </Link>
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <div ref={scrubAreaRef} className="relative flex min-h-0 flex-1 flex-col">
        <FrameStage
          src={display.src}
          seconds={display.seconds}
          label={t('frame.label', { app: metaApp ?? t('unknownApp') })}
          dimmed={offFrame}
        >
          {noDevices ? (
            <StageNotice
              title={own ? t('empty.noDevicesTitle') : t('empty.noDevicesMember')}
              body={own ? t('empty.noDevicesBody') : undefined}
              action={
                !own ? undefined : desktop.data?.available ? (
                  <Button size="sm" variant="outline" onClick={() => setRecordOpen(true)}>
                    {tDevices('recordThisComputer')}
                  </Button>
                ) : (
                  <Button asChild size="sm" variant="outline">
                    <Link
                      href={desktopDownloadUrl()}
                      target="_blank"
                      rel="noopener noreferrer"
                      prefetch={false}
                    >
                      {t('picker.getDesktop')}
                    </Link>
                  </Button>
                )
              }
            />
          ) : noData && device ? (
            <StageNotice
              title={t('empty.noDataTitle', { device: nameOf(device) })}
              body={status ? statusText(status) : undefined}
            />
          ) : video?.encrypted && !offFrame ? (
            <StageNotice title={t('frame.encrypted')} />
          ) : bounds && offFrame ? (
            <StageNotice
              title={gap ? t('track.gap', { shortcut: `${MOD_KEY()}←` }) : t('frame.none')}
            />
          ) : null}
          {bounds ? (
            <>
              <Hint label={t('previousRun', { shortcut: `${MOD_KEY()}←` })}>
                <Button
                  variant="outline"
                  size="icon"
                  aria-label={t('previousRun', { shortcut: `${MOD_KEY()}←` })}
                  onClick={() => runJump(-1)}
                  className="bg-popover absolute top-1/2 left-4 z-10 -translate-y-1/2 rounded-full shadow-md"
                >
                  <CaretLeftIcon className="size-4 shrink-0" />
                </Button>
              </Hint>
              <Hint label={t('nextRun', { shortcut: `${MOD_KEY()}→` })}>
                <Button
                  variant="outline"
                  size="icon"
                  aria-label={t('nextRun', { shortcut: `${MOD_KEY()}→` })}
                  onClick={() => runJump(1)}
                  className="bg-popover absolute top-1/2 right-4 z-10 -translate-y-1/2 rounded-full shadow-md"
                >
                  <CaretRightIcon className="size-4 shrink-0" />
                </Button>
              </Hint>
            </>
          ) : null}
        </FrameStage>

        {/* Dock: the clock, live status, zoom, and the track. */}
        <footer className="bg-background shrink-0 border-t px-3 pt-2.5 pb-3 select-none">
          <div className="mb-1 flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <JumpPopover T={view.T} days={dayList} bounds={bounds} onJump={jumpTo} />
              {status ? (
                <span
                  className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs"
                  aria-live="polite"
                >
                  <StatusDot view={status} />
                  <span className="truncate">{statusText(status)}</span>
                </span>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Hint label={t('zoomOut')}>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('zoomOut')}
                  onClick={() => scrubber.zoomTween(1.6)}
                >
                  <MinusIcon className="size-3.5 shrink-0" />
                </Button>
              </Hint>
              <Hint label={t('zoomIn')}>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('zoomIn')}
                  onClick={() => scrubber.zoomTween(1 / 1.6)}
                >
                  <PlusIcon className="size-3.5 shrink-0" />
                </Button>
              </Hint>
              <Button
                variant="outline"
                size="sm"
                disabled={!bounds}
                onClick={() => {
                  if (!bounds) return;
                  follow.current = true;
                  scrubber.panTo(bounds.last);
                }}
              >
                {t('now')}
              </Button>
            </div>
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
            className="focus-visible:ring-ring rounded-sm outline-none focus-visible:ring-2"
            onPointerDown={interact}
          >
            <TrackCanvas
              scrubber={scrubber}
              runs={runs}
              audio={audio}
              actions={actions}
              layers={layers}
              pad={pad}
              onWidth={setTrackW}
            />
          </div>
        </footer>

        {searchOpen && deviceId ? (
          <div data-no-scrub>
            <SearchPanel
              projectId={projectId}
              userId={userId}
              deviceId={deviceId}
              initialQuery=""
              onPick={pickHit}
              onClose={() => setSearchOpen(false)}
            />
          </div>
        ) : null}
      </div>

      {own && device && bounds ? (
        <SaveRangeModal
          projectId={projectId}
          open={saveOpen}
          onOpenChange={setSaveOpen}
          dayStart={Date.parse(saveDay.from)}
          initial={saveInitial}
          deviceId={deviceId ?? null}
        />
      ) : null}
      {desktop.data?.available ? (
        <CaptureDialog open={recordOpen} onOpenChange={setRecordOpen} />
      ) : null}
    </div>
  );
}

function StageNotice({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="absolute top-1/2 left-1/2 z-10 flex max-w-sm -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-2 px-6 text-center">
      <p className="text-foreground text-sm font-medium text-balance">{title}</p>
      {body ? <p className="text-muted-foreground text-xs text-pretty">{body}</p> : null}
      {action}
    </div>
  );
}
