'use client';

import { cmdLine, type Line } from '@/components/home/interactive-demo/cli/terminal';
import { useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { StepCliBlock } from './step-cli-terminal';

/* ───────────────────────────────────────────────────────────────────────────
 * CLI movies for the platform-stack panels.
 *
 * Two panels overlay a floating terminal that types a real `kortix` command
 * and drives the web panel behind it. Both used to carry their own copy of the
 * typing/sleep/append machinery; `useCliMovie` is that machinery, once, and a
 * movie is now a declarative list of stages.
 *
 * Every command in a script is a command that exists — checked against
 * `apps/cli/src/commands/*`. `kortix sessions create` is not one; `new` is.
 * ─────────────────────────────────────────────────────────────────────────── */

const SPEED = {
  /** Before the first keystroke, so the panel is readable first. */
  start: 520,
  type: 38,
  afterType: 260,
  afterFlush: 150,
  line: 110,
  /** How long the finished frame holds before the movie loops. */
  hold: 3000,
  afterClear: 720,
} as const;

/** One output line, and the panel state it puts on screen as it prints. */
type Beat<S> = { line: Line; state?: Partial<S>; pause?: number };

/** One typed command and everything it prints. */
export type Stage<S> = { run: string; out: Beat<S>[] };

export type CliMovie<S> = {
  state: S;
  scrollback: StepCliBlock[];
  typed: string;
  running: boolean;
  start: () => void;
};

/** The end frame, for `prefers-reduced-motion` — no typing, no loop. */
function stillFrame<S>(initial: S, stages: Stage<S>[]): { state: S; scrollback: StepCliBlock[] } {
  let state = initial;
  const scrollback = stages.map((stage) => {
    const out: Line[] = [];
    for (const beat of stage.out) {
      out.push(beat.line);
      if (beat.state) state = { ...state, ...beat.state };
    }
    return { cmd: cmdLine(stage.run), out };
  });
  return { state, scrollback };
}

/**
 * Play `stages` as a looping terminal recording, starting on `start()`.
 *
 * The panel calls `start()` from an IntersectionObserver, so nothing animates
 * until the panel is actually on screen.
 */
export function useCliMovie<S extends object>(initial: S, stages: Stage<S>[]): CliMovie<S> {
  const reduced = useReducedMotion();
  const [state, setState] = useState<S>(initial);
  const [scrollback, setScrollback] = useState<StepCliBlock[]>([]);
  const [typed, setTyped] = useState('');
  const [started, setStarted] = useState(false);

  const start = useCallback(() => setStarted(true), []);

  // The script is a literal in the calling module, so it never changes between
  // renders — but it is a fresh array each time, and the movie must not restart
  // on every parent render.
  const scriptRef = useRef({ initial, stages });
  scriptRef.current = { initial, stages };

  useEffect(() => {
    if (!reduced) return;
    const still = stillFrame(scriptRef.current.initial, scriptRef.current.stages);
    setState(still.state);
    setScrollback(still.scrollback);
  }, [reduced]);

  useEffect(() => {
    if (!started || reduced) return;
    let cancelled = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        const id = setTimeout(() => {
          timers.delete(id);
          resolve();
        }, ms);
        timers.add(id);
      });

    const script = scriptRef.current;

    const reset = () => {
      setScrollback([]);
      setState(script.initial);
      setTyped('');
    };

    const appendLine = (line: Line) =>
      setScrollback((prev) => {
        const next = prev.slice();
        const last = next[next.length - 1];
        if (last) next[next.length - 1] = { ...last, out: [...last.out, line] };
        return next;
      });

    async function typeCommand(input: string) {
      for (let i = 1; i <= input.length; i += 1) {
        if (cancelled) return;
        setTyped(input.slice(0, i));
        await sleep(SPEED.type);
      }
      await sleep(SPEED.afterType);
      if (cancelled) return;
      setScrollback((prev) => [...prev, { cmd: cmdLine(input), out: [] }]);
      setTyped('');
      await sleep(SPEED.afterFlush);
    }

    async function run() {
      reset();
      await sleep(SPEED.start);

      while (!cancelled) {
        for (const stage of script.stages) {
          await typeCommand(stage.run);
          if (cancelled) return;
          for (const beat of stage.out) {
            appendLine(beat.line);
            if (beat.state) setState((prev) => ({ ...prev, ...beat.state }));
            await sleep(beat.pause ?? SPEED.line);
            if (cancelled) return;
          }
        }

        await sleep(SPEED.hold);
        if (cancelled) return;
        reset();
        await sleep(SPEED.afterClear);
      }
    }

    void run();
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [started, reduced]);

  return { state, scrollback, typed, running: started && !reduced, start };
}
