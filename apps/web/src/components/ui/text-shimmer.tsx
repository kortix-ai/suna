'use client';

import React from 'react';
import { cn } from '@/lib/utils';

export type TextShimmerProps = {
  children: string;
  as?: React.ElementType;
  className?: string;
  duration?: number;
  spread?: number;
  /** Number of times to play. Defaults to Infinity (loop forever). Use 1 for a single sweep. */
  repeat?: number;
};

/**
 * The sweep, as native CSS `@keyframes` rather than a per-frame Motion
 * (`motion/react`) animation.
 *
 * `backgroundPosition` is not compositor-animatable — every frame forces a
 * style recalc and a `bg-clip-text` repaint either way, JS-driven or not.
 * The cost this removes is the JS side of it: the old version drove the
 * sweep with `animate={{ backgroundPosition }}` + `repeat: Infinity`, which
 * is a `requestAnimationFrame` loop running Motion's interpolation and a
 * React-visible style write on every single frame, for as long as the
 * shimmer stays mounted. A running burst mounts several at once (the
 * summary line, every running group row, every live "Thinking" row, the
 * chat's own busy line) — that is several rAF loops competing with the
 * turn's own SSE-driven re-renders for the same main-thread frame budget,
 * forever, while nothing about the text is even changing.
 *
 * A CSS animation is scheduled by the browser's style/animation engine, not
 * by application JS: no rAF callback, no Motion interpolation, no
 * React-visible write, on every frame this component is visible. Steady
 * state (nothing streaming, a burst just sitting open) goes from N
 * `requestAnimationFrame` callbacks per shimmer per frame to zero JS.
 *
 * `kx-shimmer-sweep-hold` reproduces the old `repeatDelay: 0.5` pause
 * between loops (infinite case) as an 80/20 split of the animation's own
 * duration — the sweep finishes at the 80% mark, then holds until 100%.
 * Driving `animation-duration` at `duration / 0.8` puts the sweep itself at
 * exactly `duration` seconds (80% of `duration / 0.8` is `duration`), and
 * the hold scales proportionally with it (`duration * 0.25`). For the
 * default `duration={2}` every caller but two uses, that hold is 0.5s —
 * an exact match. CSS keyframe percentages cannot express a duration-
 * independent flat 0.5s without a separate stylesheet per `duration` value,
 * and a hold that scales with sweep speed reads the same as a fixed one at
 * the 1s/2.2s durations this component is actually called with.
 * `kx-shimmer-sweep` (no hold) backs the finite-`repeat` case, matching the
 * old transition's `repeatDelay: 0` there.
 *
 * These keyframes are scoped to this file via an inline `<style>` — the
 * same technique `components/ui/chart.tsx` already uses for component-local
 * CSS — because `globals.css` is out of scope for this change and this
 * codebase has no CSS Modules precedent (`bun test` has no loader for
 * `.css` imports, so a `.module.css` file would break every test that
 * imports this component). The tag is a static string, so every instance
 * renders the identical bytes; the DOM tolerates duplicate `<style>`
 * content fine, and it costs a one-time parse per mount, not a per-frame
 * cost — nothing like the loop it replaces.
 */
const SHIMMER_STYLE = `
@keyframes kx-shimmer-sweep {
  from { background-position: 100% center; }
  to { background-position: 0% center; }
}
@keyframes kx-shimmer-sweep-hold {
  0% { background-position: 100% center; }
  80% { background-position: 0% center; }
  100% { background-position: 0% center; }
}
@media (prefers-reduced-motion: reduce) {
  [data-kx-text-shimmer] {
    animation: none !important;
    background-image: none !important;
    color: var(--base-color) !important;
    -webkit-text-fill-color: var(--base-color) !important;
  }
}
`;

function TextShimmerComponent({
  children,
  as: Component = 'span',
  className,
  duration = 2,
  spread = 2,
  repeat = Infinity,
}: TextShimmerProps) {
  const dynamicSpread = children.length * spread;

  const infinite = repeat === Infinity;

  // `React.ElementType` resolves too broadly for JSX to infer a concrete
  // props type from (TS collapses `children`/`style` to `never`) — the old
  // code sidestepped this by handing `Component` to `m.create`, which returns
  // a properly-typed Motion component. There is no Motion component to ask
  // for that anymore, so the tag itself is cast to accept the fixed, known
  // set of props this file actually passes it.
  const Tag = Component as React.ComponentType<Record<string, unknown>>;

  return (
    <Tag
      data-kx-text-shimmer=""
      className={cn(
        'relative inline-block bg-[length:250%_100%,auto] bg-clip-text',
        'text-transparent [--base-color:#a1a1aa] [--base-gradient-color:#000]',
        '[background-repeat:no-repeat,padding-box] [--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--base-gradient-color),#0000_calc(50%+var(--spread)))]',
        'dark:[--base-color:#71717a] dark:[--base-gradient-color:#ffffff] dark:[--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--base-gradient-color),#0000_calc(50%+var(--spread)))] text-sm',
        className,
      )}
      style={
        {
          '--spread': `${dynamicSpread}px`,
          backgroundImage: `var(--bg), linear-gradient(var(--base-color), var(--base-color))`,
          backgroundPosition: '100% center',
          animationName: infinite ? 'kx-shimmer-sweep-hold' : 'kx-shimmer-sweep',
          animationDuration: `${infinite ? duration / 0.8 : duration}s`,
          animationTimingFunction: 'linear',
          animationIterationCount: infinite ? 'infinite' : repeat,
          animationFillMode: infinite ? 'none' : 'forwards',
        } as React.CSSProperties
      }
    >
      {children}
      <style>{SHIMMER_STYLE}</style>
    </Tag>
  );
}

export const TextShimmer = React.memo(TextShimmerComponent);
