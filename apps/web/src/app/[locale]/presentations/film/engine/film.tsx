'use client';

import { cn } from '@/lib/utils';
import { useReducedMotion } from 'motion/react';
import { PauseIcon, PlayIcon, SpeakerHighIcon, SpeakerSlashIcon } from '@phosphor-icons/react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
  type ReactNode,
  type Ref,
} from 'react';
import { flushSync } from 'react-dom';
import { FPS, interp } from './time';

/** The default stage is designed at 720p and scaled; the renderer multiplies by device scale. */
export const STAGE_W = 1280;
export const STAGE_H = 720;

/** Stage size in CSS px. 1280 × 720 unless a film sets its own (1080 × 1080, 720 × 1280). */
const sizeOf = (film: FilmDef) => film.size ?? { w: STAGE_W, h: STAGE_H };

export type Cue = { frame: number; sfx: string; gain?: number };

type SectionKind = 'intro' | 'reveal' | 'groove' | 'break' | 'lift' | 'end';

/** The score `scripts/film/soundtrack.py` synthesizes for a film. Bars on the 120 BPM grid. */
export type Score = {
  bars: number;
  sections: readonly (readonly [number, SectionKind])[];
  /** The bar the Am–F–C–G cycle starts on; Am holds before it. */
  cycle_from: number;
  /** [bar, seconds]: a swell that lands on the bar. */
  risers?: readonly (readonly [number, number])[];
  /** [bar, gain]: a hit on the bar. */
  impacts?: readonly (readonly [number, number])[];
};

export type FilmDef = {
  /** URL segment: /presentations/film/<slug>. */
  slug: string;
  title: string;
  description: string;
  frames: number;
  Film: ComponentType;
  /** Sound effects placed by `scripts/film/soundtrack.py` on their frames. */
  cues: readonly Cue[];
  score: Score;
  /** The mixed soundtrack, served from `public/`. Absent until the first audio render. */
  audio?: string;
  /** Stage size in CSS px, for square and vertical cuts. Default 1280 × 720. */
  size?: { w: number; h: number };
  /** Named starts, for chapter lists outside the player. */
  chapters?: readonly { frame: number; label: string }[];
};

type Mode = 'play' | 'pause' | 'render';

const FrameCtx = createContext(0);
const ModeCtx = createContext<Mode>('pause');

/** The frame, relative to the nearest enclosing `Seq`. */
export const useFrame = () => useContext(FrameCtx);

/**
 * A span of the timeline. Children see a local frame that is 0 at `from`.
 * `pre` mounts the span that many frames early, so a scene never arrives
 * blank — its clock is already running when the cut lands.
 */
export function Seq({
  from,
  dur,
  pre = 0,
  children,
}: {
  from: number;
  dur: number;
  pre?: number;
  children: ReactNode;
}) {
  const f = useFrame();
  if (f < from - pre || f >= from + dur) return null;
  return <FrameCtx.Provider value={f - from}>{children}</FrameCtx.Provider>;
}

/**
 * A full-stage scene with its transition grammar. `push` slides between
 * scenes of the same tone; `settle` shrinks out into a gap frame and lands
 * from slightly above scale — for a tonal jump. A slow camera push (1 → 1.035)
 * runs under every shot so a hold never reads as a still.
 */
export function Shot({
  from,
  dur,
  enter = 'push',
  exit = 'push',
  children,
}: {
  from: number;
  dur: number;
  enter?: 'push' | 'settle' | 'cut';
  exit?: 'push' | 'settle' | 'cut';
  children: ReactNode;
}) {
  const PRE = 14;
  return (
    <Seq from={from} dur={dur} pre={enter === 'push' ? PRE : 0}>
      <ShotFrame dur={dur} enter={enter} exit={exit}>
        {children}
      </ShotFrame>
    </Seq>
  );
}

function ShotFrame({
  dur,
  enter,
  exit,
  children,
}: {
  dur: number;
  enter: 'push' | 'settle' | 'cut';
  exit: 'push' | 'settle' | 'cut';
  children: ReactNode;
}) {
  const f = useFrame();
  const camera = interp(f, 0, dur, 1, 1.035, (t) => t);
  let x = 0;
  let scale = camera;
  let opacity = 1;
  let blur = 0;

  if (enter === 'push') {
    x += interp(f, -14, 22, 64, 0);
    opacity *= interp(f, -14, 0, 0, 1);
  } else if (enter === 'settle') {
    scale *= interp(f, 0, 40, 1.06, 1);
    blur += interp(f, 0, 18, 10, 0);
    opacity *= interp(f, 0, 12, 0, 1);
  }
  if (exit === 'push') {
    x += interp(f, dur - 14, dur, 0, -64, (t) => t * t * (3 - 2 * t));
    opacity *= interp(f, dur - 12, dur, 1, 0);
  } else if (exit === 'settle') {
    scale *= interp(f, dur - 18, dur - 4, 1, 0.965);
    opacity *= interp(f, dur - 16, dur - 4, 1, 0);
  }

  return (
    <div
      className="absolute inset-0"
      style={{
        opacity,
        transform: `translate3d(${x}px,0,0) scale(${scale})`,
        filter: blur ? `blur(${blur}px)` : undefined,
      }}
    >
      {children}
    </div>
  );
}

/* ── footage: real product recordings, seeked frame-accurately ───────────── */

const pendingSeeks = new Set<Promise<void>>();

/**
 * A product recording on the film clock. In render mode each frame seeks the
 * video and the renderer waits for `seeked`; in live playback the video plays
 * and is only corrected when it drifts.
 */
export function Footage({
  src,
  start = 0,
  className,
  style,
}: {
  src: string;
  start?: number;
  className?: string;
  style?: CSSProperties;
}) {
  const f = useFrame();
  const mode = useContext(ModeCtx);
  const ref = useRef<HTMLVideoElement>(null);
  const t = start + Math.max(0, f) / FPS;

  useLayoutEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (mode === 'play') {
      if (Math.abs(v.currentTime - t) > 0.2) v.currentTime = t;
      if (v.paused) void v.play().catch(() => {});
      return;
    }
    v.pause();
    if (Math.abs(v.currentTime - t) < 1 / (FPS * 2)) return;
    const done = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 4000);
      v.addEventListener('seeked', () => (clearTimeout(timer), resolve()), { once: true });
    });
    pendingSeeks.add(done);
    void done.then(() => pendingSeeks.delete(done));
    v.currentTime = t;
  });

  return (
    <video
      ref={ref}
      src={src}
      muted
      playsInline
      preload="auto"
      className={className}
      style={style}
    />
  );
}

/* ── the stage ───────────────────────────────────────────────────────────── */

function Stage({ film, frame, mode }: { film: FilmDef; frame: number; mode: Mode }) {
  const { Film } = film;
  return (
    <div
      className="dark bg-background text-foreground relative overflow-hidden antialiased"
      style={{ width: sizeOf(film).w, height: sizeOf(film).h }}
    >
      <ModeCtx.Provider value={mode}>
        <FrameCtx.Provider value={frame}>
          <Film />
        </FrameCtx.Provider>
      </ModeCtx.Provider>
    </div>
  );
}

/** Scales the fixed-size stage to fit its parent. */
function Fit({ size, children }: { size: { w: number; h: number }; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [k, setK] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) =>
      setK(Math.min(e.contentRect.width / size.w, e.contentRect.height / size.h)),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, [size.w, size.h]);
  return (
    <div ref={ref} className="relative size-full overflow-hidden">
      <div
        className="absolute top-1/2 left-1/2"
        style={{
          width: size.w,
          height: size.h,
          transform: `translate(-50%, -50%) scale(${k})`,
          visibility: k ? 'visible' : 'hidden',
        }}
      >
        {children}
      </div>
    </div>
  );
}

const clock = (frame: number) => {
  const s = Math.floor(frame / FPS);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * Live playback. The soundtrack is the clock when there is one — a muted
 * `<audio>` still advances — so picture and sound cannot drift apart.
 */
export function FilmPlayer({
  film,
  autoPlay = false,
  loop = false,
  className,
  onFrame,
  ref,
}: {
  film: FilmDef;
  autoPlay?: boolean;
  loop?: boolean;
  className?: string;
  /** Reports the current frame, for chapter lists outside the player. */
  onFrame?: (frame: number) => void;
  /** `seek(frame)` from outside the player — a chapter list. */
  ref?: Ref<{ seek: (frame: number) => void }>;
}) {
  const [frame, setFrame] = useState(0);
  // Derived, not stored: autoplay waits for the reduced-motion answer, and a
  // click always wins over it.
  const reduced = useReducedMotion();
  const [choice, setChoice] = useState<boolean | null>(null);
  const playing = choice ?? (autoPlay && reduced === false);
  const [muted, setMuted] = useState(true);
  const audio = useRef<HTMLAudioElement>(null);
  const origin = useRef({ at: 0, frame: 0 });
  const frameRef = useRef(0);

  const seek = useCallback((next: number) => {
    const n = Math.max(0, Math.min(film.frames - 1, Math.round(next)));
    frameRef.current = n;
    origin.current = { at: performance.now(), frame: n };
    if (audio.current) audio.current.currentTime = n / FPS;
    setFrame(n);
  }, [film.frames]);

  useImperativeHandle(ref, () => ({ seek }), [seek]);

  useEffect(() => {
    onFrame?.(frame);
  }, [frame, onFrame]);

  /** Sound starts on the click itself: a gesture is what lets a page unmute. */
  const toggleSound = useCallback(() => {
    const a = audio.current;
    const next = !muted;
    setMuted(next);
    if (!a) return;
    a.muted = next;
    if (!next && playing && a.paused) {
      a.currentTime = frameRef.current / FPS;
      void a.play().catch(() => {});
    }
  }, [muted, playing]);

  useEffect(() => {
    if (!playing) {
      audio.current?.pause();
      return;
    }
    origin.current = { at: performance.now(), frame: frameRef.current };
    const a = audio.current;
    if (a) {
      a.currentTime = frameRef.current / FPS;
      void a.play().catch(() => {});
    }
    let raf = 0;
    const tick = () => {
      let next =
        a && !a.paused
          ? a.currentTime * FPS
          : origin.current.frame + ((performance.now() - origin.current.at) / 1000) * FPS;
      if (next >= film.frames - 1) {
        if (loop) {
          seek(0);
          raf = requestAnimationFrame(tick);
          return;
        }
        next = film.frames - 1;
        setChoice(false);
      }
      frameRef.current = Math.floor(next);
      setFrame(frameRef.current);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, film.frames, loop, seek]);

  const toggle = useCallback(() => {
    if (!playing && frameRef.current >= film.frames - 1) seek(0);
    setChoice(!playing);
  }, [playing, film.frames, seek]);

  return (
    <div className={cn('group bg-background relative size-full', className)}>
      <button
        type="button"
        aria-label={playing ? 'Pause' : 'Play'}
        onClick={toggle}
        className="absolute inset-0 cursor-pointer"
      >
        <Fit size={sizeOf(film)}>
          <Stage film={film} frame={frame} mode={playing ? 'play' : 'pause'} />
        </Fit>
      </button>
      {film.audio ? <audio ref={audio} src={film.audio} preload="auto" muted /> : null}
      <div className="absolute inset-x-0 bottom-0 flex items-center gap-3 px-4 py-3 opacity-0 transition-opacity duration-normal group-hover:opacity-100 focus-within:opacity-100">
        <button
          type="button"
          aria-label={playing ? 'Pause' : 'Play'}
          onClick={toggle}
          className="text-foreground hover:bg-hover grid size-8 place-items-center rounded-full active:scale-[0.96]"
        >
          {playing ? <PauseIcon weight="fill" className="size-4" /> : <PlayIcon weight="fill" className="size-4" />}
        </button>
        <input
          type="range"
          aria-label="Seek"
          min={0}
          max={film.frames - 1}
          value={frame}
          onChange={(e) => seek(Number(e.target.value))}
          className="accent-foreground h-1 flex-1 cursor-pointer"
        />
        <span className="text-muted-foreground font-mono text-xs tabular-nums">
          {clock(frame)} / {clock(film.frames)}
        </span>
        {film.audio ? (
          <button
            type="button"
            aria-label={muted ? 'Sound on' : 'Sound off'}
            onClick={toggleSound}
            className="text-foreground hover:bg-hover grid size-8 place-items-center rounded-full active:scale-[0.96]"
          >
            {muted ? <SpeakerSlashIcon className="size-4" /> : <SpeakerHighIcon className="size-4" />}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** A single frame, fitted. For stills on the landing page. */
export function FilmStill({ film, frame }: { film: FilmDef; frame: number }) {
  return (
    <Fit size={sizeOf(film)}>
      <Stage film={film} frame={frame} mode="pause" />
    </Fit>
  );
}

declare global {
  interface Window {
    __film?: {
      frames: number;
      fps: number;
      size: { w: number; h: number };
      cues: readonly Cue[];
      score: Score;
      seek: (f: number) => Promise<void>;
    };
  }
}

const nextPaint = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

/**
 * Render mode (`?render=1`): the stage at its native size, top-left, and a
 * `window.__film.seek(frame)` that resolves once the frame is fully painted —
 * fonts loaded, images decoded, footage seeked. `scripts/film/render.ts`
 * drives it.
 */
export function FilmRender({ film }: { film: FilmDef }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    window.__film = {
      frames: film.frames,
      fps: FPS,
      size: sizeOf(film),
      cues: film.cues,
      score: film.score,
      seek: async (f) => {
        flushSync(() => setFrame(f));
        await document.fonts.ready;
        await Promise.all(
          [...document.images].map((img) => (img.complete ? null : img.decode().catch(() => {}))),
        );
        await Promise.all([...pendingSeeks]);
        await nextPaint();
      },
    };
    return () => {
      delete window.__film;
    };
  }, [film]);
  return (
    <div className="fixed top-0 left-0">
      <Stage film={film} frame={frame} mode="render" />
    </div>
  );
}
