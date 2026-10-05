'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { MOMENTUM_STOP, SPP_MAX, SPP_MIN, clamp, momentumStep } from './track-model';

/**
 * The playhead: the time at the center of the track (`T`) and the scale
 * (`spp`, ms per pixel). It changes up to 60 times a second while a person
 * scrubs, so it lives outside React state: the track canvas repaints from it
 * directly, and React reads a copy at most once per animation frame.
 *
 * Motion follows the engine window and the kit's motion budget: a pointer
 * move glides for 200 ms ease-out, a keyboard move never animates, drag and
 * wheel are direct manipulation, reduced motion removes the glide and inertia.
 */
export interface Scrubber {
  get: () => { T: number; spp: number };
  setT: (t: number) => void;
  panTo: (t: number, instant?: boolean) => void;
  zoom: (factor: number) => void;
  zoomTween: (factor: number) => void;
  startMomentum: (v: number) => void;
  stop: () => void;
  subscribe: (fn: () => void) => () => void;
}

const GLIDE_MS = 200;
const easeOut = (k: number) => 1 - Math.pow(1 - k, 3);
const reduceMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function useScrubber(initialT: number, bounds: { first: number; last: number } | null) {
  const state = useRef({ T: initialT, spp: 1000 });
  const boundsRef = useRef(bounds);
  useLayoutEffect(() => {
    boundsRef.current = bounds;
  }, [bounds]);
  const [view, setView] = useState(() => ({ T: initialT, spp: 1000 }));

  const scrubber = useMemo<Scrubber>(() => {
    const listeners = new Set<() => void>();
    let viewRaf = 0;
    let panRaf = 0;
    let zoomRaf = 0;
    let momRaf = 0;
    let zoomTarget: number | null = null;
    const emit = () => {
      for (const fn of listeners) fn();
      if (!viewRaf) {
        viewRaf = requestAnimationFrame(() => {
          viewRaf = 0;
          setView({ ...state.current });
        });
      }
    };
    const setT = (t: number) => {
      const b = boundsRef.current;
      state.current.T = b ? clamp(t, b.first, b.last) : t;
      emit();
    };
    const stop = () => {
      cancelAnimationFrame(momRaf);
      cancelAnimationFrame(panRaf);
      momRaf = 0;
    };
    const zoom = (factor: number) => {
      state.current.spp = clamp(state.current.spp * factor, SPP_MIN, SPP_MAX);
      emit();
    };
    return {
      get: () => state.current,
      setT,
      stop,
      zoom,
      subscribe: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      panTo: (t, instant = false) => {
        stop();
        if (instant || reduceMotion()) {
          setT(t);
          return;
        }
        const from = state.current.T;
        const t0 = performance.now();
        const tick = (now: number) => {
          const k = Math.min(1, (now - t0) / GLIDE_MS);
          setT(k < 1 ? from + (t - from) * easeOut(k) : t);
          if (k < 1) panRaf = requestAnimationFrame(tick);
        };
        panRaf = requestAnimationFrame(tick);
      },
      zoomTween: (factor) => {
        const target = clamp((zoomTarget ?? state.current.spp) * factor, SPP_MIN, SPP_MAX);
        if (reduceMotion()) {
          zoom(target / state.current.spp);
          return;
        }
        cancelAnimationFrame(zoomRaf);
        zoomTarget = target;
        const from = state.current.spp;
        const t0 = performance.now();
        const tick = (now: number) => {
          const k = Math.min(1, (now - t0) / GLIDE_MS);
          zoom((from * Math.pow(target / from, easeOut(k))) / state.current.spp);
          if (k < 1) zoomRaf = requestAnimationFrame(tick);
          else zoomTarget = null;
        };
        zoomRaf = requestAnimationFrame(tick);
      },
      startMomentum: (v) => {
        stop();
        if (reduceMotion()) return;
        let last = performance.now();
        let vel = v;
        const tick = (now: number) => {
          const dt = Math.min(now - last, 50);
          last = now;
          const m = momentumStep(vel, dt);
          vel = m.v;
          const before = state.current.T;
          setT(state.current.T - m.dx * state.current.spp);
          if (Math.abs(vel) < MOMENTUM_STOP || state.current.T === before) {
            momRaf = 0;
            return;
          }
          momRaf = requestAnimationFrame(tick);
        };
        momRaf = requestAnimationFrame(tick);
      },
    };
  }, []);

  useEffect(() => () => scrubber.stop(), [scrubber]);
  return { scrubber, view };
}
