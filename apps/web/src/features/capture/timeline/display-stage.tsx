'use client';

import type { CaptureDisplay, CaptureFrame } from '@kortix/sdk';
import { useCaptureChunkMedia } from '@kortix/sdk/react';

import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';

import { displayLayout, type FocusSpan, type ScreenItem } from './display-model';
import { FrameStage } from './frame-stage';

type TimelineT = ReturnType<typeof useTranslations>;

/** A display's name ("Display 2" when the device gave none), and "Main" on the main display. */
export function displayLabel(
  display: CaptureDisplay,
  displays: readonly CaptureDisplay[],
  t: TimelineT,
) {
  const name = display.name ?? t('display.unnamed', { n: displays.indexOf(display) + 1 });
  return display.main ? `${name} · ${t('display.main')}` : name;
}

/** A row label that fits: "Built-in Retina Display" → "Built-in Retina"; unnamed → "Display 2". */
export function shortDisplayName(
  display: CaptureDisplay,
  displays: readonly CaptureDisplay[],
  t: TimelineT,
) {
  const short = display.name?.replace(/\s+display$/i, '').trim();
  return short || t('display.unnamed', { n: displays.indexOf(display) + 1 });
}

/** The layout box: 16:10, like the stage. Tiles are placed in percent of it. */
const BOX_W = 1600;
const BOX_H = 1000;

/**
 * All displays side by side, where they sit on the desk (the device's own
 * layout), each showing its frame at the playhead. The active display is
 * outlined; a click pins one.
 */
export function AllDisplaysStage({
  accountId,
  userId,
  displays,
  activeId,
  frameOf,
  recorded,
  onPick,
}: {
  accountId: string;
  userId: string | undefined;
  displays: readonly CaptureDisplay[];
  activeId: number | null;
  frameOf: (displayId: number) => CaptureFrame | null;
  recorded: (displayId: number) => boolean;
  onPick: (displayId: number) => void;
}) {
  const t = useTranslations('capture.timeline');
  const rects = displayLayout(displays, BOX_W, BOX_H);
  return (
    <div className="bg-pane relative min-h-0 flex-1">
      {rects.map((rect) => {
        const display = displays.find((d) => d.id === rect.id)!;
        const label = displayLabel(display, displays, t);
        return (
          <button
            key={rect.id}
            type="button"
            aria-label={t('display.show', { name: label })}
            onClick={() => onPick(rect.id)}
            className={cn(
              'focus-visible:ring-ring absolute overflow-hidden rounded-sm border bg-black outline-none focus-visible:ring-2',
              rect.id === activeId ? 'border-foreground ring-foreground ring-1' : 'border-border',
            )}
            style={{
              left: `${(rect.left / BOX_W) * 100}%`,
              top: `${(rect.top / BOX_H) * 100}%`,
              width: `${(rect.width / BOX_W) * 100}%`,
              height: `${(rect.height / BOX_H) * 100}%`,
            }}
          >
            <DisplayTile
              accountId={accountId}
              userId={userId}
              frame={frameOf(rect.id)}
              recorded={recorded(rect.id)}
              label={label}
            />
            <span className="bg-popover text-foreground absolute bottom-1.5 left-1.5 z-10 max-w-[calc(100%-0.75rem)] truncate rounded-sm border px-1.5 py-0.5 text-xs">
              {label}
              {rect.id === activeId ? (
                <span className="text-muted-foreground"> · {t('display.activeBadge')}</span>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function DisplayTile({
  accountId,
  userId,
  frame,
  recorded,
  label,
}: {
  accountId: string;
  userId: string | undefined;
  frame: CaptureFrame | null;
  recorded: boolean;
  label: string;
}) {
  const media = useCaptureChunkMedia(accountId, frame?.chunk_id ?? null, { userId });
  const video = media.data?.chunk_id === frame?.chunk_id ? (media.data?.video ?? null) : null;
  return (
    <FrameStage
      src={video && !video.encrypted ? video.url : null}
      seconds={frame?.frame_index ?? 0}
      label={label}
      dimmed={!recorded}
      failedLabel={null}
    />
  );
}

/**
 * One thin row per display under the track, on the track's time scale: where
 * each display recorded (muted) and where it held focus (solid).
 */
export function DisplayStrip({
  displays,
  items,
  focus,
  T,
  spp,
  width,
  shownId,
  label,
  short,
  title,
}: {
  displays: readonly CaptureDisplay[];
  items: readonly ScreenItem[];
  focus: readonly FocusSpan[];
  T: number;
  spp: number;
  width: number;
  shownId: number | null;
  label: (display: CaptureDisplay) => string;
  /** The row label, short enough for the column (the full name is its tooltip). */
  short: (display: CaptureDisplay) => string;
  title: string;
}) {
  const left = T - (width / 2) * spp;
  const bar = (s: number, e: number) => {
    const x0 = (s - left) / spp;
    const x1 = (e - left) / spp;
    if (x1 < 0 || x0 > width) return null;
    return { left: Math.max(0, x0), width: Math.max(2, Math.min(width, x1) - Math.max(0, x0)) };
  };
  return (
    <div
      role="group"
      aria-label={title}
      className="bg-background flex overflow-hidden rounded-md border select-none"
    >
      <div className="bg-popover w-24 shrink-0 border-r py-1.5">
        {displays.map((display) => (
          <p
            key={display.id}
            title={label(display)}
            className={cn(
              'h-4 truncate px-2 text-xs leading-4',
              display.id === shownId ? 'text-foreground' : 'text-muted-foreground',
            )}
          >
            {short(display)}
          </p>
        ))}
      </div>
      <div className="relative min-w-0 flex-1 py-1.5">
        {displays.map((display) => (
          <div key={display.id} className="relative h-4" title={label(display)}>
            {items
              .filter((item) => item.display_id === display.id)
              .map((item, i) => {
                const b = bar(item.s, item.e);
                return b ? (
                  <span
                    key={`i${i}`}
                    className="bg-muted-foreground absolute top-1.5 h-1 rounded-full opacity-40"
                    style={{ left: b.left, width: b.width }}
                  />
                ) : null;
              })}
            {focus
              .filter((span) => span.display_id === display.id)
              .map((span, i) => {
                const b = bar(span.s, span.e);
                return b ? (
                  <span
                    key={`f${i}`}
                    className={cn(
                      'absolute top-1.5 h-1 rounded-full',
                      display.id === shownId ? 'bg-foreground' : 'bg-muted-foreground',
                    )}
                    style={{ left: b.left, width: b.width }}
                  />
                ) : null;
              })}
          </div>
        ))}
        <span aria-hidden className="bg-foreground absolute inset-y-0 left-1/2 w-px" />
      </div>
    </div>
  );
}
