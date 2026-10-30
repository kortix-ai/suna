/**
 * The splash: the Kortix symbol in pixel art, a dim tagline and a few
 * `label value` lines, with the web's dither field drifting along its top
 * edge. Click the symbol (or bump `lifeSignal`) and the symbol becomes the
 * first generation of Conway's Game of Life over the whole splash area; when
 * the run settles it dissolves back into the symbol.
 *
 * Shown while the TUI boots (`features/boot`), on the no-session screen
 * (`features/session/draft-view.tsx`) and at the head of an empty session.
 *
 * - The symbol is `PIXEL_KORTIX_ROWS` (`@kortix/shared/pixel-mark`), the same
 *   12 × 10 grid the web's `PixelKortixMark` draws, in half blocks: 24 × 10
 *   cells at 2×, 12 × 5 at 1×, the word `kortix` below 16 columns. One mark,
 *   no typed wordmark next to it (`kortix-brand` brandmark rules); the tagline
 *   names the product. Monochrome: `theme.fg`, never `theme.brand`.
 * - The dither band is `lib/dither.ts`: braille dots in `theme.faint` on its
 *   top row and `theme.border` below, 5 fps, only while mounted and resting.
 * - Life is `lib/life.ts` at 12 fps, in braille dots (2 × 4 per cell; the
 *   symbol is too small to live at half-block resolution, see `life.ts`):
 *   cells born this generation in `theme.fg`, settled ones in `theme.dim`.
 *   It dissolves back into the symbol when the grid settles, after 600
 *   generations, or on a second click.
 *
 * The TUI leaves the mouse to the terminal (README "Mouse, selection and
 * copying"). The click needs it, so while a splash is mounted it turns
 * `renderer.useMouse` on and restores the previous value on unmount.
 */

import { PIXEL_KORTIX_ROWS } from '@kortix/shared/pixel-mark';
import type { MouseEvent } from '@opentui/core';
import { useRenderer } from '@opentui/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ditherBand, toBraille } from '../lib/dither.ts';
import {
  type LifeGrid,
  type LifeSnapshot,
  isStagnant,
  morphToward,
  snapshot,
  step,
  type ToneRun,
  seedCells,
  sprinkle,
  toBrailleRuns,
  toQuadrantRuns,
} from '../lib/life.ts';
import { demandMouse } from '../lib/mouse-demand.ts';
import { theme } from '../theme.ts';

export interface SplashLine {
  label: string;
  value: string;
}

export interface SplashProps {
  width: number;
  /** One dim line under the symbol: what this is. */
  tagline?: string;
  lines?: readonly SplashLine[];
  /** Center the block horizontally, and vertically inside `height` (the boot
   *  and no-session screens). Default: left, 2-col indent, top. */
  center?: boolean;
  /** Rows to fill. Life runs over the whole box, so pass the area the splash
   *  owns. Content that does not fit drops the band, then shrinks the symbol.
   *  Default: `splashHeight(...)`. */
  height?: number;
  /** The drifting dither band. Default true. Off: no band, no band timer. */
  ambient?: boolean;
  /** Each new value starts (or restarts) Life: the keyboard path to the
   *  click. The value at mount does not start a run. */
  lifeSignal?: number;
}

/** The text column the symbol, tagline and lines share. */
const BLOCK_WIDTH = 45;
const BAND_ROWS = 3;
const BAND_GAP = 1;
const BAND_FPS = 5;
const LIFE_FPS = 12;
/** Frames the block → dot sweep takes, each way (≈ 0.7 s at 12 fps). */
const WIPE_FRAMES = 8;
/** Frames the dissolve back into the symbol takes. */
const RETURN_FRAMES = 12;
/** 40 s at 12 fps, then the board dissolves back into the symbol. */
const MAX_GENERATIONS = 480;
/** The share of cells a stagnant board gets back, as the web page adds. */
const SPRINKLE_FRACTION = 0.01;

type Scale = 2 | 1 | 0;

const SYMBOL_COLUMNS = PIXEL_KORTIX_ROWS[0].length;
const SYMBOL_PIXEL_ROWS = PIXEL_KORTIX_ROWS.length;

/**
 * The resting symbol, one run list per terminal row: the SAME seed and the
 * SAME quadrant renderer Game of Life starts from, so generation 0 is this,
 * glyph for glyph. Solid cells, never a checker: `#` at full ink and `+` (a
 * curve cell) at half ink, the rule the web's agent mark applies at small
 * sizes (`packages/ui/src/internal/lib/pixel-mark.ts`). 2×: a cell is `██`
 * (2 columns × 1 row, square). 1×: 1 column × half a row.
 */
export function symbolRuns(scale: 1 | 2): ToneRun[][] {
  return toQuadrantRuns(
    seedCells(
      PIXEL_KORTIX_ROWS,
      SYMBOL_COLUMNS * scale * 2,
      SYMBOL_PIXEL_ROWS * scale,
      0,
      0,
      scale * 2,
      scale,
    ),
  );
}
const SYMBOL_ROWS: Record<1 | 2, ToneRun[][]> = { 1: symbolRuns(1), 2: symbolRuns(2) };

function scaleForWidth(width: number): Scale {
  if (width >= SYMBOL_COLUMNS * 2 + 4) return 2;
  if (width >= SYMBOL_COLUMNS + 4) return 1;
  return 0;
}

function artRows(scale: Scale): number {
  return scale === 0 ? 1 : SYMBOL_ROWS[scale].length;
}

function contentRows(scale: Scale, lineCount: number, tagline: boolean): number {
  return artRows(scale) + (tagline ? 2 : 1) + lineCount;
}

/**
 * The symbol's left column. The resting symbol AND Game of Life both place it
 * here, so generation 0 lands on the same columns. Not Yoga centring: Yoga
 * rounds a half column up where `Math.floor` rounds down, and on an odd free
 * width that was the one-column jump when Life started (measured).
 */
export function symbolLeft(width: number, scale: 1 | 2, center: boolean, indent: number): number {
  return center ? Math.max(Math.floor((width - SYMBOL_COLUMNS * scale) / 2), 0) : indent;
}

/** Left edge of the text column. `BootScreen` aligns its steps to it. */
export function splashIndent(width: number, center = false): number {
  if (!center) return 2;
  const block = Math.min(BLOCK_WIDTH, width - 2);
  return Math.max(Math.floor((width - block) / 2), 0);
}

/** Rows the splash draws for `lineCount` metadata lines at `width`, without
 *  a `height`. Pass the same `tagline` / `ambient` the splash gets. */
export function splashHeight(
  width: number,
  lineCount: number,
  tagline = true,
  ambient = true,
): number {
  const band = ambient ? BAND_ROWS + BAND_GAP : 0;
  return band + contentRows(scaleForWidth(width), lineCount, tagline);
}

interface Layout {
  scale: Scale;
  bandRows: number;
  /** Row of the symbol's top edge inside the box. */
  contentTop: number;
  total: number;
  indent: number;
}

function layoutFor(
  width: number,
  height: number | undefined,
  lineCount: number,
  tagline: boolean,
  ambient: boolean,
  center: boolean,
): Layout {
  const indent = splashIndent(width, center);
  const widest = scaleForWidth(width);
  const band = (on: boolean) => (on ? BAND_ROWS + BAND_GAP : 0);
  if (height === undefined) {
    return {
      scale: widest,
      bandRows: ambient ? BAND_ROWS : 0,
      contentTop: band(ambient),
      total: band(ambient) + contentRows(widest, lineCount, tagline),
      indent,
    };
  }
  // Largest symbol first; the band is decoration, so it goes before the symbol shrinks.
  const options: [Scale, boolean][] = [];
  for (const scale of [2, 1, 0] as const) {
    if (scale > widest) continue;
    if (ambient) options.push([scale, true]);
    options.push([scale, false]);
  }
  const fit = options.find(
    ([scale, on]) => band(on) + contentRows(scale, lineCount, tagline) <= height,
  );
  const [scale, on] = fit ?? options[options.length - 1];
  const free = Math.max(height - band(on) - contentRows(scale, lineCount, tagline), 0);
  return {
    scale,
    bandRows: on ? BAND_ROWS : 0,
    contentTop: band(on) + (center ? Math.floor(free / 2) : 0),
    total: Math.max(height, 1),
    indent,
  };
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

interface LifeRun {
  /**
   * `wipe-in`: the solid symbol sweeps into braille dots, in place. `run`:
   * Life. `return`: the board morphs back into the symbol's dots. `wipe-out`:
   * the dots sweep back into the solid symbol, then the run ends.
   */
  phase: 'wipe-in' | 'run' | 'return' | 'wipe-out';
  /** Frames spent in the current phase. */
  frame: number;
  generation: number;
  grid: LifeGrid;
  previous?: LifeGrid;
  seed: LifeGrid;
  history: LifeSnapshot[];
}

/** One clock tick of a run. Returns null when the run is over. */
function advance(run: LifeRun): LifeRun | null {
  if (run.phase === 'wipe-in') {
    return run.frame + 1 >= WIPE_FRAMES
      ? { ...run, phase: 'run', frame: 0 }
      : { ...run, frame: run.frame + 1 };
  }
  if (run.phase === 'wipe-out') {
    return run.frame + 1 >= WIPE_FRAMES ? null : { ...run, frame: run.frame + 1 };
  }
  if (run.phase === 'return') {
    const frame = run.frame + 1;
    if (frame > RETURN_FRAMES) {
      return { ...run, phase: 'wipe-out', frame: 0, grid: run.seed, previous: undefined };
    }
    return {
      ...run,
      frame,
      previous: run.grid,
      grid: morphToward(run.grid, run.seed, frame / RETURN_FRAMES),
    };
  }
  const grid = step(run.grid);
  const history = [...run.history.slice(-64), snapshot(grid)];
  const generation = run.generation + 1;
  if (generation >= MAX_GENERATIONS) {
    return { ...run, previous: run.grid, grid, history, generation, phase: 'return', frame: 0 };
  }
  if (isStagnant(history)) {
    // Stagnant before the cap: sprinkle 1 % of the cells, as the web page
    // does, and keep going. The rule itself never changes.
    const fresh = sprinkle(grid, SPRINKLE_FRACTION);
    return {
      ...run,
      previous: run.grid,
      grid: fresh,
      history: [snapshot(fresh)],
      generation,
      frame: 0,
    };
  }
  return { ...run, previous: run.grid, grid, history, generation, phase: 'run', frame: 0 };
}

/**
 * During a wipe, whether a symbol character already shows as dots: a diagonal
 * sweep from the top-left. `progress` 0 is all blocks, 1 is all dots.
 */
export function wiped(
  cx: number,
  cy: number,
  cols: number,
  rows: number,
  progress: number,
): boolean {
  return (cx + cy * 2) / (cols + rows * 2) < progress;
}

/** One character with its tone, for the wipe merge. */
type ToneChar = { ch: string; tone: ToneRun['tone'] };

function explode(runs: ToneRun[]): ToneChar[] {
  return runs.flatMap((run) => [...run.text].map((ch) => ({ ch, tone: run.tone })));
}

function implode(chars: ToneChar[]): ToneRun[] {
  const out: ToneRun[] = [];
  for (const { ch, tone } of chars) {
    const last = out.at(-1);
    if (last && (ch === ' ' || last.tone === tone)) last.text += ch;
    else out.push({ text: ch, tone });
  }
  return out;
}

/**
 * The Life frame with the resting symbol laid over the characters the wipe
 * has not reached yet. `progress` 1 is pure Life.
 */
function mergeWipe(
  life: ToneRun[][],
  scale: Scale,
  left: number,
  top: number,
  progress: number,
): ToneRun[][] {
  if (progress >= 1 || scale === 0) return life;
  const symbol = SYMBOL_ROWS[scale];
  const cols = SYMBOL_COLUMNS * scale;
  return life.map((runs, row) => {
    const cy = row - top;
    const art = symbol[cy];
    if (!art) return runs;
    const chars = explode(runs);
    const blocks = explode(art);
    for (let cx = 0; cx < cols; cx += 1) {
      const block = blocks[cx];
      if (!block || wiped(cx, cy, cols, symbol.length, progress)) continue;
      chars[left + cx] = block;
    }
    return implode(chars);
  });
}

/** Keep the mouse on while mounted; restore exactly the previous value. */
function useSplashMouse() {
  const renderer = useRenderer();
  useEffect(() => demandMouse(renderer), [renderer]);
}

export function Splash({
  width,
  tagline,
  lines = [],
  center = false,
  height,
  ambient = false,
  lifeSignal,
}: SplashProps) {
  useSplashMouse();
  const layout = layoutFor(width, height, lines.length, Boolean(tagline), ambient, center);
  const { scale, bandRows, contentTop, total, indent } = layout;

  const runRef = useRef<LifeRun | null>(null);
  const [living, setLiving] = useState(false);
  const [, setFrame] = useState(0);

  const start = useCallback(() => {
    if (scale === 0) return;
    // Braille grid: 2 × 4 Life cells per terminal cell. A resting 2× cell is
    // `██` (2 columns × 1 row) = 4 × 4 dots; a 1× cell is 2 × 2. Same left
    // column and top row as the resting symbol (`symbolLeft`).
    const left = symbolLeft(width, scale, center, indent);
    const seed = seedCells(
      PIXEL_KORTIX_ROWS,
      width * 2,
      total * 4,
      left * 2,
      contentTop * 4,
      scale * 2,
      scale * 2,
    );
    runRef.current = {
      phase: 'wipe-in',
      frame: 0,
      generation: 0,
      grid: seed,
      seed,
      history: [snapshot(seed)],
    };
    setLiving(true);
    setFrame((value) => value + 1);
  }, [scale, width, total, indent, contentTop, center]);

  const finish = useCallback(() => {
    const run = runRef.current;
    if (run && run.phase === 'run') runRef.current = { ...run, phase: 'return', frame: 0 };
  }, []);

  // A new size invalidates the grid: drop the run, show the symbol again.
  const layoutKey = `${width}x${total}:${scale}:${indent}:${contentTop}`;
  useEffect(() => {
    runRef.current = null;
    setLiving(false);
  }, [layoutKey]);

  const seenSignal = useRef(lifeSignal);
  useEffect(() => {
    if (lifeSignal === undefined || lifeSignal === seenSignal.current) return;
    seenSignal.current = lifeSignal;
    // A toggle: the first signal starts Life, the next one sends it home.
    if (runRef.current?.phase === 'run') finish();
    else if (!runRef.current) start();
  }, [lifeSignal, start, finish]);

  useEffect(() => {
    if (!living) return;
    const timer = setInterval(() => {
      const run = runRef.current;
      const next = run ? advance(run) : null;
      runRef.current = next;
      if (!next) setLiving(false);
      setFrame((value) => value + 1);
    }, 1000 / LIFE_FPS);
    return () => clearInterval(timer);
  }, [living]);

  // The band clock: seconds since mount, from 4 s in (the web's still frame).
  const mountedAt = useRef(performance.now());
  const [bandTime, setBandTime] = useState(4);
  const animateBand = bandRows > 0 && !living;
  useEffect(() => {
    if (!animateBand) return;
    const timer = setInterval(
      () => setBandTime(4 + (performance.now() - mountedAt.current) / 1000),
      1000 / BAND_FPS,
    );
    return () => clearInterval(timer);
  }, [animateBand]);
  const band = useMemo(
    () =>
      bandRows > 0 ? toBraille(ditherBand(width * 2, bandRows * 4, bandTime), width, bandRows) : [],
    [width, bandRows, bandTime],
  );

  const labelWidth = Math.max(...lines.map((line) => line.label.length), 0) + 1;
  const blockWidth = Math.min(BLOCK_WIDTH, width - 2);
  const valueWidth = Math.max(blockWidth - labelWidth, 8);

  // The hint and the lines: one element for both states, so they never move
  // when Life starts or ends.
  const textBlock = (
    <box
      flexDirection="column"
      paddingLeft={center ? 0 : indent}
      alignItems={center ? 'center' : 'flex-start'}
      width={width}
      flexShrink={0}
    >
      {tagline ? (
        <text fg={theme.dim} wrapMode="none" height={1} marginTop={1}>
          {clip(tagline, Math.max(width - indent - 1, 8))}
        </text>
      ) : (
        <box height={1} />
      )}
      {lines.some((line) => line.label) ? (
        // Labelled lines stay one aligned block; the block is what centres.
        <box flexDirection="column" alignItems="flex-start" flexShrink={0}>
          {lines.map((line) => (
            <text key={line.label || line.value} wrapMode="none" height={1}>
              <span fg={theme.faint}>{line.label.padEnd(labelWidth)}</span>
              <span fg={theme.dim}>
                {line.value.length > valueWidth
                  ? `${line.value.slice(0, valueWidth - 1)}…`
                  : line.value}
              </span>
            </text>
          ))}
        </box>
      ) : (
        // Lines with no label are quiet phrases, each centred (the empty state).
        lines.map((line) => (
          <text key={line.value} fg={theme.faint} wrapMode="none" height={1}>
            {clip(line.value, Math.max(width - 2, 8))}
          </text>
        ))
      )}
    </box>
  );
  const textTop = contentTop + artRows(scale);

  const run = runRef.current;
  if (living && run) {
    // Newborn cells draw full, settled ones half. During a wipe the symbol's
    // characters not yet swept stay the resting blocks, on the same columns.
    const wipe =
      run.phase === 'wipe-in'
        ? run.frame / WIPE_FRAMES
        : run.phase === 'wipe-out'
          ? 1 - run.frame / WIPE_FRAMES
          : 1;
    const textRows = (tagline ? 2 : 1) + lines.length;
    const merged = mergeWipe(
      toBrailleRuns(run.grid, run.phase === 'run' ? run.previous : undefined),
      scale,
      scale === 0 ? indent : symbolLeft(width, scale, center, indent),
      contentTop,
      wipe,
    );
    // Life keeps running under the hint, but never draws over it.
    const rows = merged.map((runs, row) =>
      row >= textTop && row < textTop + textRows ? [{ text: '', tone: 'half' as const }] : runs,
    );
    return (
      <box
        width={width}
        height={total}
        flexShrink={0}
        overflow="hidden"
        onMouseDown={(event: MouseEvent) => {
          if (event.button !== 0) return;
          event.preventDefault();
          // Ours: the container that also listens must not toggle it again.
          event.stopPropagation();
          finish();
        }}
      >
        <box
          flexDirection="column"
          position="absolute"
          top={0}
          left={0}
          width={width}
          height={total}
        >
          {rows.map((runs, row) => (
            <text key={row} wrapMode="none" height={1}>
              {runs.map((part, index) => (
                <span key={index} fg={part.tone === 'full' ? theme.fg : theme.dim}>
                  {part.text}
                </span>
              ))}
            </text>
          ))}
        </box>
        <box position="absolute" top={textTop} left={0} width={width}>
          {textBlock}
        </box>
      </box>
    );
  }

  return (
    <box flexDirection="column" width={width} height={total} flexShrink={0} overflow="hidden">
      {band.map((row, index) => (
        <text key={index} fg={index === 0 ? theme.faint : theme.border} wrapMode="none" height={1}>
          {row}
        </text>
      ))}
      <box height={Math.max(contentTop - bandRows, 0)} flexShrink={0} />
      {scale === 0 ? (
        <box
          width={width}
          alignItems={center ? 'center' : 'flex-start'}
          paddingLeft={center ? 0 : indent}
        >
          <text fg={theme.fg} wrapMode="none" height={1}>
            kortix
          </text>
        </box>
      ) : (
        <box width={width} paddingLeft={symbolLeft(width, scale, center, indent)} flexShrink={0}>
          <box
            flexDirection="column"
            width={SYMBOL_COLUMNS * scale}
            height={artRows(scale)}
            onMouseDown={(event: MouseEvent) => {
              if (event.button !== 0) return;
              // The click is ours: no renderer auto-focus of an ancestor, and no
              // second toggle from a container that also listens.
              event.preventDefault();
              event.stopPropagation();
              start();
            }}
          >
            {SYMBOL_ROWS[scale].map((runs, index) => (
              <text key={index} wrapMode="none" height={1}>
                {runs.map((part, key) => (
                  <span key={key} fg={part.tone === 'full' ? theme.fg : theme.dim}>
                    {part.text}
                  </span>
                ))}
              </text>
            ))}
          </box>
        </box>
      )}
      {textBlock}
    </box>
  );
}
