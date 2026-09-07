'use client';

/**
 * MagicUI's `Confetti` (https://magicui.design/docs/components/confetti),
 * ported into this codebase rather than pulled through the shadcn CLI.
 *
 * Three deliberate departures from upstream:
 *
 * 1. `canvas-confetti` was ALREADY a dependency (`apps/web/package.json`) and
 *    already wrapped once, in `src/lib/confetti.ts`, for the billing win. The
 *    registry install would have added it a second time and left two copies of
 *    the brand colour list. This file imports the same module and re-exports
 *    nothing that `lib/confetti.ts` already owns.
 * 2. `disableForReducedMotion: true` is baked into the component's own
 *    defaults instead of being a caller's job. Upstream leaves it off, so an
 *    unaware host ships an unstoppable 200-particle burst to a user who asked
 *    for less motion. It is still overridable — a caller's `options` spread
 *    after it — but the default is the accessible one.
 * 3. The canvas defaults to a non-interactive, full-viewport overlay. Upstream
 *    ships an unstyled `<canvas>`, which collapses to 300x150 and swallows
 *    clicks wherever it lands. Every use in this app wants the same thing:
 *    particles over the page, pointer events straight through.
 *
 * `ConfettiButton` is kept as upstream ships it, on this repo's `Button`.
 */

import type {
  GlobalOptions as ConfettiGlobalOptions,
  CreateTypes as ConfettiInstance,
  Options as ConfettiOptions,
} from 'canvas-confetti';
import confetti from 'canvas-confetti';
import React, {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';

import { Button, type ButtonProps } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface ConfettiApi {
  fire: (options?: ConfettiOptions) => void;
}

export type ConfettiRef = ConfettiApi | null;

type ConfettiProps = React.ComponentPropsWithoutRef<'canvas'> & {
  /** Merged UNDER every `fire()` argument, so a per-shot option wins. */
  options?: ConfettiOptions;
  globalOptions?: ConfettiGlobalOptions;
  /** Skip the on-mount burst and wait for an explicit `ref.current.fire()`. */
  manualstart?: boolean;
  children?: ReactNode;
};

const ConfettiContext = createContext<ConfettiApi | null>(null);

/**
 * `useWorker` keeps the particle loop off the main thread — the burst survives
 * a React render storm, which is exactly what a celebration mounted next to a
 * route change has to do. `resize` re-reads the canvas box on window resize.
 */
const DEFAULT_GLOBAL_OPTIONS: ConfettiGlobalOptions = { resize: true, useWorker: true };

const ConfettiComponent = forwardRef<ConfettiRef, ConfettiProps>(function Confetti(
  { options, globalOptions = DEFAULT_GLOBAL_OPTIONS, manualstart = false, children, ...rest },
  ref,
) {
  const instanceRef = useRef<ConfettiInstance | null>(null);

  // A callback ref, not `useRef` + an effect: `confetti.create` has to run
  // against the REAL node the first time React hands it over, and has to be
  // torn down the moment React takes it back. An effect would fire a frame
  // late — after `manualstart={false}`'s auto-fire below had already looked
  // for an instance that did not exist yet.
  const canvasRef = useCallback(
    (node: HTMLCanvasElement | null) => {
      if (node) {
        if (!instanceRef.current) {
          instanceRef.current = confetti.create(node, globalOptions);
        }
        return;
      }
      instanceRef.current?.reset();
      instanceRef.current = null;
    },
    [globalOptions],
  );

  const fire = useCallback(
    (opts: ConfettiOptions = {}) => {
      // `confetti.create` returns a promise that rejects if the canvas is gone
      // mid-flight (a route change during the burst). Nothing downstream can
      // act on that, and an unhandled rejection in a celebration is noise.
      void instanceRef
        .current?.({
          disableForReducedMotion: true,
          ...options,
          ...opts,
        })
        ?.catch(() => {});
    },
    [options],
  );

  const api = useMemo<ConfettiApi>(() => ({ fire }), [fire]);
  useImperativeHandle(ref, () => api, [api]);

  useEffect(() => {
    if (!manualstart) fire();
  }, [manualstart, fire]);

  return (
    <ConfettiContext.Provider value={api}>
      <canvas
        ref={canvasRef}
        aria-hidden
        {...rest}
        // After the spread: a full-viewport, click-through overlay is the
        // contract this component makes, not a default a caller can half-undo
        // by passing `className` and accidentally dropping `fixed`. `cn` still
        // lets a caller override any individual utility (`z-*`, `inset-*`).
        className={cn('pointer-events-none fixed inset-0 z-50 size-full', rest.className)}
      />
      {children}
    </ConfettiContext.Provider>
  );
});

export const Confetti = ConfettiComponent;

/** Fire the nearest ancestor `<Confetti>` from anywhere inside it. */
export function useConfetti(): ConfettiApi {
  const api = useContext(ConfettiContext);
  if (!api) throw new Error('useConfetti must be used inside <Confetti>');
  return api;
}

interface ConfettiButtonProps extends ButtonProps {
  options?: ConfettiOptions;
  children?: ReactNode;
}

/**
 * Upstream's demo trigger: fires the DEFAULT global cannon from the button's
 * own centre. It does not use the `<Confetti>` canvas above — the global
 * instance owns its own full-screen canvas — so the two are independent.
 */
export function ConfettiButton({ options, children, ...props }: ConfettiButtonProps) {
  return (
    <Button
      {...props}
      onClick={(event) => {
        props.onClick?.(event);
        const rect = event.currentTarget.getBoundingClientRect();
        void confetti({
          disableForReducedMotion: true,
          ...options,
          origin: {
            x: (rect.left + rect.width / 2) / window.innerWidth,
            y: (rect.top + rect.height / 2) / window.innerHeight,
          },
        })?.catch(() => {});
      }}
    >
      {children}
    </Button>
  );
}
