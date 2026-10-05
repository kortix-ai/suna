'use client';

import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';

import { useLocale, useTranslations } from '@/i18n/use-translations';

import { clockTime } from '../capture-time';
import {
  ICON_SIZE,
  audioBars,
  brighter,
  foldRuns,
  gapAt,
  layoutRuns,
  placeIcons,
  runColor,
  runColors,
  velocityFromSamples,
  type Rgb,
  type TrackRun,
} from './track-model';
import type { Scrubber } from './use-scrubber';

export interface TrackLayers {
  actions: boolean;
  audio: boolean;
}

// Canvas geometry in px (a drawing surface, not CSS spacing), as in the engine window:
// the run line's top edge and thickness, the audio and actions lines below the icons.
const TRACK_Y = 18.5;
const TRACK_H = 7;
const AUDIO_Y = 37;
const ACTIONS_Y = 41;
// Third-party apps get a white tile in both themes, like catalogue logos (color.md, escape hatch 1).
const ICON_TILE = '#ffffff'; // audit:allow third-party app tile, white in both themes (color.md escape hatch 1)
// Canvas cannot read the --shadow-* tokens; this is shadow-sm's ink.
const BADGE_SHADOW = 'rgb(0 0 0 / 0.1)'; // audit:allow canvas cannot read the shadow tokens
const rgb = ([r, g, b]: Rgb, a = 1) => `rgb(${r} ${g} ${b} / ${a})`; // audit:allow run colors are computed per app in the track art

/** The app tile's letter color: the app's run hue, deep enough to read on the white tile in both themes. */
export const appInkCss = (app: string | null) =>
  rgb(brighter(runColor({ k: app, app }, false), -0.22));
export const APP_TILE = ICON_TILE;

function roundRect(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const m = Math.min(w / 2, h / 2, r);
  g.beginPath();
  g.roundRect(x, y, Math.max(0, w), h, m);
}

const cssVar = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const isDark = () => document.documentElement.classList.contains('dark');

/**
 * The track: a film strip under a playhead fixed at the center. Drag it (with
 * inertia on release), click to glide to a moment, hover for the app and time.
 * App-colored runs carry an app tile at their start; the run under the
 * playhead glows; audio and actions are quiet lines below. Port of the
 * engine window's canvas track.
 */
export function TrackCanvas({
  scrubber,
  runs,
  audio,
  actions,
  layers,
  pad,
  onWidth,
}: {
  scrubber: Scrubber;
  runs: readonly TrackRun[];
  audio: readonly { s: number; e: number }[];
  actions: readonly { s: number; e: number }[];
  layers: TrackLayers;
  pad: number;
  onWidth: (width: number) => void;
}) {
  const t = useTranslations('capture.timeline');
  const locale = useLocale();
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const size = useRef({ w: 0, h: 0 });
  const drag = useRef<{
    x: number;
    T: number;
    moved: boolean;
    samples: { t: number; x: number }[];
  } | null>(null);
  const hoverX = useRef<number | null>(null);
  const raf = useRef(0);
  const [tip, setTip] = useState<{ x: number; text: string } | null>(null);
  const [gap, setGap] = useState<{ side: 'left' | 'right'; offset: number } | null>(null);
  const gapKey = useRef('');

  const foldMemo = useRef<{ src: readonly TrackRun[] | null; spp: number; out: TrackRun[] }>({
    src: null,
    spp: -1,
    out: [],
  });

  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    const { w: W, h: H } = size.current;
    if (!canvas || !W) return;
    const g = canvas.getContext('2d');
    if (!g) return;
    const { T, spp } = scrubber.get();
    const xOf = (time: number) => W / 2 + (time - T) / spp;
    g.clearRect(0, 0, W, H);
    const ink = cssVar('--foreground');
    const weak = cssVar('--muted-foreground');
    const dark = isDark();
    const cy = TRACK_Y + TRACK_H / 2;
    // Idle base line: time before, between and after runs.
    g.globalAlpha = 0.3;
    g.fillStyle = weak;
    roundRect(g, 0, cy - 1, W, 2, 1);
    g.fill();
    g.globalAlpha = 1;
    // Runs; the one under the playhead is brighter and glows in its own hue.
    if (foldMemo.current.src !== runs || foldMemo.current.spp !== spp) {
      foldMemo.current = { src: runs, spp, out: foldRuns(runs, spp, pad) };
    }
    const laid = layoutRuns(foldMemo.current.out, xOf, W, pad);
    const cols = runColors(laid, dark);
    const mid = W / 2;
    const underIdx = laid.findIndex((r) => mid >= r.x && mid <= r.x + r.w);
    laid.forEach((r, i) => {
      if (i === underIdx) return;
      g.fillStyle = rgb(cols[i]!);
      roundRect(g, r.x, TRACK_Y, r.w, TRACK_H, TRACK_H / 2);
      g.fill();
    });
    const under = underIdx >= 0 ? laid[underIdx]! : null;
    if (under) {
      const col = brighter(cols[underIdx]!, 0.12);
      g.save();
      if (under.w < 12) {
        g.fillStyle = rgb(col);
        roundRect(g, under.x, TRACK_Y, under.w, TRACK_H, TRACK_H / 2);
        g.fill();
        g.strokeStyle = rgb(brighter(col, 0.12));
        g.lineWidth = 1;
        roundRect(
          g,
          under.x + 0.5,
          TRACK_Y + 0.5,
          Math.max(1, under.w - 1),
          TRACK_H - 1,
          (TRACK_H - 1) / 2,
        );
        g.stroke();
      } else {
        g.beginPath();
        g.rect(under.x, TRACK_Y - 5, under.w, TRACK_H + 10);
        g.clip();
        g.shadowColor = rgb(col, 0.45);
        g.shadowBlur = 8;
        g.fillStyle = rgb(col);
        roundRect(g, under.x, TRACK_Y, under.w, TRACK_H, TRACK_H / 2);
        g.fill();
      }
      g.restore();
    }
    // Audio and actions: quiet lines below the icons.
    g.fillStyle = weak;
    if (layers.audio) {
      g.globalAlpha = 0.55;
      for (const b of audioBars(audio, xOf, W)) {
        roundRect(g, b.x, AUDIO_Y, b.w, 2, 1);
        g.fill();
      }
    }
    if (layers.actions) {
      g.globalAlpha = 0.35;
      for (const b of audioBars(actions, xOf, W)) {
        roundRect(g, b.x, ACTIONS_Y, b.w, 2, 1);
        g.fill();
      }
    }
    g.globalAlpha = 1;
    // App tiles at the start of runs: the app's initial on a white tile.
    for (const ic of placeIcons(laid, W)) {
      const x = ic.cx - ICON_SIZE / 2;
      const y = cy - ICON_SIZE / 2;
      const col = cols[laid.indexOf(ic.run)]!;
      g.save();
      if (ic.run === under) {
        g.shadowColor = rgb(brighter(col), 0.6);
        g.shadowBlur = 4;
      } else {
        g.shadowColor = BADGE_SHADOW;
        g.shadowBlur = 5;
        g.shadowOffsetY = 1;
      }
      g.fillStyle = ICON_TILE;
      roundRect(g, x, y, ICON_SIZE, ICON_SIZE, 5.5);
      g.fill();
      g.restore();
      g.fillStyle = rgb(brighter(col, -0.22));
      g.font = `600 12px ${cssVar('--font-sans') || 'system-ui'}`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText((ic.run.s.app ?? '?').trim().charAt(0).toUpperCase(), ic.cx, cy + 0.5);
    }
    // Hover marker.
    if (hoverX.current != null && !drag.current) {
      g.globalAlpha = 0.5;
      g.fillStyle = weak;
      g.fillRect(Math.round(hoverX.current) - 0.5, cy - 14, 1, 28);
      g.globalAlpha = 1;
    }
    // Playhead: a translucent rounded handle fixed at the center.
    g.fillStyle = ink;
    g.strokeStyle = ink;
    g.lineWidth = 1;
    g.globalAlpha = 0.14;
    roundRect(g, mid - 4, cy - 17, 8, 34, 4);
    g.fill();
    g.globalAlpha = 0.4;
    roundRect(g, mid - 3.5, cy - 16.5, 7, 33, 3.5);
    g.stroke();
    g.globalAlpha = 1;
    // Idle-gap hint beside the playhead, on the side with more of the gap in view.
    const h = gapAt(runs, T, pad);
    let next: typeof gap = null;
    if (h) {
      const x0 = Math.max(0, xOf(h.start));
      const x1 = Math.min(W, xOf(h.end));
      next =
        x1 - mid >= mid - x0
          ? { side: 'right', offset: mid + 20 }
          : { side: 'left', offset: W - mid + 20 };
    }
    const key = next ? `${next.side}${Math.round(next.offset)}` : '';
    if (key !== gapKey.current) {
      gapKey.current = key;
      setGap(next);
    }
  }, [scrubber, pad, layers, audio, actions, runs]);

  const schedule = useCallback(() => {
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      paint();
    });
  }, [paint]);

  useEffect(() => scrubber.subscribe(schedule), [scrubber, schedule]);
  useEffect(() => schedule(), [schedule]);
  // Theme changes flip the html class: repaint with the new ink and run band.
  useEffect(() => {
    const observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, [schedule]);
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const observer = new ResizeObserver(() => {
      const r = wrap.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      size.current = { w: r.width, h: r.height };
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
      canvas.getContext('2d')?.setTransform(dpr, 0, 0, dpr, 0, 0);
      onWidth(r.width);
      paint();
    });
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [paint, onWidth]);

  const timeAtX = (x: number) => {
    const { T, spp } = scrubber.get();
    return T + (x - size.current.w / 2) * spp;
  };
  const runAt = (time: number) => {
    const { T, spp } = scrubber.get();
    const W = size.current.w;
    const xOf = (v: number) => W / 2 + (v - T) / spp;
    const x = xOf(time);
    return layoutRuns(runs, xOf, W, pad).find((r) => x >= r.x && x <= r.x + r.w)?.s ?? null;
  };

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    scrubber.stop();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      x: event.clientX,
      T: scrubber.get().T,
      moved: false,
      samples: [{ t: performance.now(), x: event.clientX }],
    };
  };
  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const d = drag.current;
    if (d) {
      const dx = event.clientX - d.x;
      if (Math.abs(dx) > 3) d.moved = true;
      if (d.moved) {
        d.samples.push({ t: performance.now(), x: event.clientX });
        if (d.samples.length > 12) d.samples.shift();
        scrubber.setT(d.T - dx * scrubber.get().spp);
      }
      setTip(null);
      return;
    }
    const x = event.clientX - box.left;
    const at = timeAtX(x);
    const r = runAt(at);
    const sound = audio.some((a) => at >= a.s && at < a.e);
    hoverX.current = x;
    schedule();
    setTip({
      x: Math.min(Math.max(x, 80), size.current.w - 80),
      text: `${r ? (r.app ?? t('unknownApp')) : t('track.noCapture')}${sound ? ` · ${t('track.audio')}` : ''} · ${clockTime(at, locale)}`,
    });
  };
  const onPointerLeave = () => {
    hoverX.current = null;
    setTip(null);
    schedule();
  };
  const onPointerUp = (event: PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (!d.moved) {
      const box = event.currentTarget.getBoundingClientRect();
      scrubber.panTo(timeAtX(event.clientX - box.left));
      return;
    }
    d.samples.push({ t: performance.now(), x: event.clientX });
    const idle = performance.now() - d.samples[d.samples.length - 2]!.t;
    const v = idle > 80 ? 0 : velocityFromSamples(d.samples);
    if (Math.abs(v) > 0.1) scrubber.startMomentum(v);
  };

  const modKey =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';

  return (
    <div ref={wrapRef} className="relative h-12 select-none">
      <canvas
        ref={canvasRef}
        aria-hidden
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerLeave}
        className="absolute inset-0 size-full cursor-grab touch-none active:cursor-grabbing"
      />
      {tip ? (
        <div
          className="bg-foreground text-background pointer-events-none absolute bottom-12 z-10 -translate-x-1/2 rounded-sm px-2 py-1 text-xs whitespace-nowrap tabular-nums"
          style={{ left: tip.x }}
        >
          {tip.text}
        </div>
      ) : null}
      {gap ? (
        <p
          className="text-muted-foreground pointer-events-none absolute top-1/2 -translate-y-1/2 text-xs whitespace-nowrap"
          style={gap.side === 'right' ? { left: gap.offset } : { right: gap.offset }}
        >
          {t('track.gap', { shortcut: `${modKey}←` })}
        </p>
      ) : null}
    </div>
  );
}
