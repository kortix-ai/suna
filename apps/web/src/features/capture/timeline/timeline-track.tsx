'use client';

import type { CaptureActivityRun, CaptureChunk, CaptureRange } from '@kortix/sdk';
import Link from 'next/link';
import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

import { useLocale, useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';

import { appColor, clampTime, clockTime, hourTicks } from '../capture-time';

export interface TrackLayers {
  screen: boolean;
  actions: boolean;
  audio: boolean;
}

const MINUTE = 60_000;

/**
 * One day of one person: app-colored screen runs, an actions lane, an audio
 * lane, the day's ranges and a playhead. The lanes are one slider: click or
 * drag to move the moment; arrow keys step one minute, Shift ten, Home and
 * End jump to the first and last recorded moment.
 */
export function TimelineTrack({
  projectId,
  userParam,
  span,
  runs,
  chunks,
  ranges,
  layers,
  at,
  bounds,
  onMove,
}: {
  projectId: string;
  /** `?user=` to keep on range links, for a manager viewing a member. */
  userParam: string | null;
  span: { start: number; end: number };
  runs: CaptureActivityRun[];
  chunks: CaptureChunk[];
  ranges: CaptureRange[];
  layers: TrackLayers;
  at: number;
  /** First and last recorded moment of the day: the keyboard's Home and End. */
  bounds: { first: number; last: number };
  onMove: (at: number) => void;
}) {
  const t = useTranslations('capture.timeline');
  const locale = useLocale();
  const lanesRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const width = span.end - span.start;
  const pct = (ms: number) =>
    `${((clampTime(ms, span.start, span.end) - span.start) / width) * 100}%`;
  const len = (from: number, to: number) =>
    `${Math.max(0.15, ((clampTime(to, span.start, span.end) - clampTime(from, span.start, span.end)) / width) * 100)}%`;
  const shown = drag ?? at;

  const timeAt = (clientX: number) => {
    const box = lanesRef.current?.getBoundingClientRect();
    if (!box || box.width === 0) return at;
    return Math.round(span.start + ((clientX - box.left) / box.width) * width);
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag(timeAt(event.clientX));
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (drag !== null) setDrag(timeAt(event.clientX));
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (drag === null) return;
    const next = timeAt(event.clientX);
    setDrag(null);
    onMove(next);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 10 * MINUTE : MINUTE;
    const next =
      event.key === 'ArrowRight' || event.key === 'ArrowUp'
        ? at + step
        : event.key === 'ArrowLeft' || event.key === 'ArrowDown'
          ? at - step
          : event.key === 'Home'
            ? bounds.first
            : event.key === 'End'
              ? bounds.last
              : null;
    if (next === null) return;
    event.preventDefault();
    onMove(clampTime(next, span.start, span.end));
  };

  const actionChunks = chunks.filter((chunk) => chunk.kind === 'actions');
  const audioChunks = chunks.filter((chunk) => chunk.kind === 'audio');
  const lanes = [
    layers.screen && {
      key: 'screen',
      label: t('layer.screen'),
      marks: runs.map((run) => (
        <span
          key={`${run.device_id}-${run.start_at}`}
          title={[run.app, run.title].filter(Boolean).join(' — ')}
          className="absolute inset-y-0 rounded-sm"
          style={{
            left: pct(Date.parse(run.start_at)),
            width: len(Date.parse(run.start_at), Date.parse(run.end_at) + 20_000),
            background: appColor(run.app),
          }}
        />
      )),
    },
    layers.actions && {
      key: 'actions',
      label: t('layer.actions'),
      marks: actionChunks.map((chunk) => (
        <span
          key={chunk.chunk_id}
          className="bg-muted-foreground absolute inset-y-1 rounded-sm"
          style={{
            left: pct(Date.parse(chunk.start_at)),
            width: len(Date.parse(chunk.start_at), Date.parse(chunk.end_at)),
          }}
        />
      )),
    },
    layers.audio && {
      key: 'audio',
      label: t('layer.audio'),
      marks: audioChunks.map((chunk) => (
        <span
          key={chunk.chunk_id}
          className="bg-muted-foreground absolute inset-y-0 rounded-sm"
          style={{
            left: pct(Date.parse(chunk.start_at)),
            width: len(Date.parse(chunk.start_at), Date.parse(chunk.end_at)),
          }}
        />
      )),
    },
  ].filter((lane): lane is { key: string; label: string; marks: React.ReactElement[] } => !!lane);

  return (
    <div className="bg-background space-y-2 rounded-md border px-4 py-3">
      <div className="flex items-center gap-3">
        <span className="w-16 shrink-0" aria-hidden />
        <div
          className="text-muted-foreground @container relative h-4 flex-1 text-xs tabular-nums"
          aria-hidden
        >
          {hourTicks(span.start, span.end).map((tick, i, all) => (
            <span
              key={tick}
              className={cn(
                'absolute top-0 whitespace-nowrap',
                i === 0 ? '' : i === all.length - 1 ? '-translate-x-full' : '-translate-x-1/2',
                // Every hour fits from 42rem of track; below it, every other hour (the first stays).
                all.length > 5 && i % 2 === 1 && '@max-2xl:hidden',
                // A long day labels every other hour at any width.
                all.length > 12 && i % 2 === 1 && 'hidden',
              )}
              style={{ left: pct(tick) }}
            >
              {clockTime(tick, locale)}
            </span>
          ))}
        </div>
      </div>

      <div
        role="slider"
        tabIndex={0}
        aria-label={t('trackLabel')}
        aria-valuemin={span.start}
        aria-valuemax={span.end}
        aria-valuenow={shown}
        aria-valuetext={clockTime(shown, locale, true)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onKeyDown={onKeyDown}
        className="focus-visible:ring-ring flex cursor-pointer touch-none gap-3 rounded-sm py-1 outline-none focus-visible:ring-2"
      >
        <div className="w-16 shrink-0 space-y-1.5">
          {lanes.map((lane) => (
            <p key={lane.key} className="text-muted-foreground flex h-3.5 items-center text-xs">
              {lane.label}
            </p>
          ))}
        </div>
        <div ref={lanesRef} className="relative flex-1 space-y-1.5">
          {lanes.map((lane) => (
            <div key={lane.key} className="bg-muted relative h-3.5 overflow-hidden rounded-sm">
              {lane.marks}
            </div>
          ))}
          <span
            aria-hidden
            className="bg-foreground pointer-events-none absolute -inset-y-1 w-px"
            style={{ left: pct(shown) }}
          />
        </div>
      </div>

      {ranges.length > 0 ? (
        <div className="flex items-center gap-3">
          <span className="text-muted-foreground w-16 shrink-0 text-xs">{t('layer.ranges')}</span>
          <div className="relative h-6 flex-1">
            {ranges.map((range) => {
              const start = Date.parse(range.start_at);
              const end = Date.parse(range.end_at);
              const label = range.title ?? `${clockTime(start, locale)}–${clockTime(end, locale)}`;
              return (
                <Link
                  key={range.range_id}
                  href={`/projects/${projectId}/capture/ranges/${range.range_id}${userParam ? `?user=${userParam}` : ''}`}
                  title={label}
                  aria-label={t('openRange', { range: label })}
                  className="bg-background hover:bg-hover text-muted-foreground hover:text-foreground absolute inset-y-0 flex items-center truncate rounded-sm border px-1.5 text-xs transition-colors"
                  style={{ left: pct(start), width: len(start, end) }}
                >
                  {range.source === 'saved' ? label : clockTime(start, locale)}
                </Link>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
