'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type RefObject,
} from 'react';
import { dateParam, isSameDay } from './reminder-calendar-model';
import type { RemindersUrlPatch } from './use-reminders-url-state';

/** A grid position: the row (Month) or column (Week) of `date`, plus `delta` px past its start. */
export type GridTop = { date: Date; delta: number };

/** Where the grid scrolls after its next commit. */
export type ScrollRequest = GridTop & { smooth: boolean };

type Jump = { date: Date; smooth: boolean };

/** `?date=` is written once the grid has been still this long. */
const URL_SETTLE_MS = 400;
/** The title and Month's muted days follow the top once it has held still this long. */
export const TITLE_SETTLE_MS = 150;
/** How long a jump's target cell or column stays ringed before it fades. */
const HIGHLIGHT_MS = 1200;
/** The window may re-centre once the scroll has been still this long. */
const GRID_SETTLE_MS = 150;

/**
 * The calendar position, shared by the toolbar title and the grid without
 * rendering the page on every scroll step. The grid reports its top day with
 * `setTop`; the title reads it with `useCalendarTop`; Today and "Jump to next
 * fire" call `jump`.
 *
 * `?date=` is output only: written when the scroll settles, so a reload lands
 * on the same day, and read once, when the store is created. It is never read
 * back while the page is mounted. Next applies a `replaceState` URL on a later
 * render, so reading it back mid-scroll saw an older day than the grid had
 * reached, took it for a jump, and scrolled the grid back to it.
 */
export function createCalendarStore(initial: Date, write: (patch: RemindersUrlPatch) => void) {
  let top = initial;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** The fire a jump landed on (ms): its day's cell or column rings briefly. */
  let highlighted: number | null = null;
  let highlightTimer: ReturnType<typeof setTimeout> | undefined;
  const tops = new Set<() => void>();
  const jumps = new Set<(jump: Jump) => void>();

  const setTop = (date: Date) => {
    if (isSameDay(date, top)) return;
    top = date;
    tops.forEach((listener) => listener());
    clearTimeout(timer);
    timer = setTimeout(
      () => write({ date: isSameDay(top, new Date()) ? null : dateParam(top) }),
      URL_SETTLE_MS,
    );
  };

  const setHighlight = (day: number | null) => {
    if (day === highlighted) return;
    highlighted = day;
    tops.forEach((listener) => listener());
  };

  return {
    top: () => top,
    highlighted: () => highlighted,
    subscribe(listener: () => void) {
      tops.add(listener);
      return () => void tops.delete(listener);
    },
    setTop,
    /**
     * Scroll the grid to `date`; only Today glides. `highlight` is a fire's
     * time: its day's cell (Month) or column (Week, Day) rings for a moment,
     * and Week and Day scroll to its hour.
     */
    jump(date: Date, smooth = false, highlight: Date | null = null) {
      setTop(date);
      jumps.forEach((listener) => listener({ date, smooth }));
      clearTimeout(highlightTimer);
      if (!highlight) return setHighlight(null);
      setHighlight(highlight.getTime());
      highlightTimer = setTimeout(() => setHighlight(null), HIGHLIGHT_MS);
    },
    onJump(listener: (jump: Jump) => void) {
      jumps.add(listener);
      return () => void jumps.delete(listener);
    },
    dispose: () => {
      clearTimeout(timer);
      clearTimeout(highlightTimer);
    },
  };
}

export type CalendarStore = ReturnType<typeof createCalendarStore>;

export const CalendarStoreContext = createContext<CalendarStore | null>(null);

export function useCalendarStore(): CalendarStore {
  const store = useContext(CalendarStoreContext);
  if (!store) throw new Error('useCalendarStore needs a CalendarStoreContext provider');
  return store;
}

/** The fire a jump landed on (ms), while its day rings; else null. */
export function useCalendarHighlight(): number | null {
  const store = useCalendarStore();
  return useSyncExternalStore(store.subscribe, store.highlighted, store.highlighted);
}

/** A value derived from the top day, re-rendering only when it changes. */
export function useCalendarTop<T>(select: (top: Date) => T): T {
  const store = useCalendarStore();
  const snapshot = () => select(store.top());
  return useSyncExternalStore(store.subscribe, snapshot, snapshot);
}

/**
 * The scroll mechanics of a calendar grid, shared by Week and Month.
 *
 * - `request` is applied after the commit that renders it, before paint, so a
 *   new window and its compensating scroll land in the same frame.
 * - `measure.top` is reported once per frame while the grid scrolls.
 * - `onSettle` runs once the grid has been still for 150 ms and no pointer is
 *   down on it. The window only moves then: moving it mid-scroll stopped the
 *   momentum and jumped the grid, and moving it under a dragged scrollbar
 *   jumps it on the next drag step.
 */
export function useGridScroll({
  scroller,
  axis,
  request,
  measure,
  onTop,
  onSettle,
}: {
  scroller: RefObject<HTMLDivElement | null>;
  axis: 'x' | 'y';
  request: ScrollRequest;
  measure: { offsetOf: (date: Date) => number | null; top: () => GridTop | null };
  onTop: (date: Date) => void;
  onSettle: (top: GridTop) => void;
}) {
  const latest = useRef({ measure, onTop, onSettle });
  useLayoutEffect(() => {
    latest.current = { measure, onTop, onSettle };
  });

  useLayoutEffect(() => {
    const element = scroller.current;
    const offset = latest.current.measure.offsetOf(request.date);
    if (!element || offset === null) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    element.scrollTo({
      [axis === 'x' ? 'left' : 'top']: offset + request.delta,
      behavior: request.smooth && !reduced ? 'smooth' : 'instant',
    });
  }, [request, axis, scroller]);

  const frame = useRef(0);
  const settle = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pressed = useRef(false);

  useEffect(() => {
    const release = () => {
      pressed.current = false;
    };
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    return () => {
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
      cancelAnimationFrame(frame.current);
      clearTimeout(settle.current);
    };
  }, []);

  // Re-armed while a pointer is down: the window waits for the release.
  const scheduleSettle = useCallback(() => {
    clearTimeout(settle.current);
    const wait = () => {
      settle.current = setTimeout(() => {
        if (pressed.current) return wait();
        const top = latest.current.measure.top();
        if (top) latest.current.onSettle(top);
      }, GRID_SETTLE_MS);
    };
    wait();
  }, []);

  const onScroll = useCallback(() => {
    scheduleSettle();
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const top = latest.current.measure.top();
      if (top) latest.current.onTop(top.date);
    });
  }, [scheduleSettle]);

  const onPointerDown = useCallback(() => {
    pressed.current = true;
  }, []);

  return { onScroll, onPointerDown };
}
