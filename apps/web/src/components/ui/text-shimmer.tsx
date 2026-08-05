'use client';

import React, { useMemo, type JSX } from 'react';
import { m } from 'motion/react';
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

function TextShimmerComponent({
  children,
  as: Component = 'span',
  className,
  duration = 2,
  spread = 2,
  repeat = Infinity,
}: TextShimmerProps) {
  // Memoized on `as`: `m.create` returns a NEW component type on every
  // call, and a new type is not reconcilable — React unmounts and remounts this
  // subtree on each re-render, restarting the shimmer sweep from frame zero.
  // Any caller that re-renders on live data sees that as a flicker; the session
  // transcript's busy line and every running tool row do.
  const MotionComponent = useMemo(
    () => m.create(Component as keyof JSX.IntrinsicElements),
    [Component],
  );

  const dynamicSpread = useMemo(() => {
    return children.length * spread;
  }, [children, spread]);

  return (
    <MotionComponent
      className={cn(
        'relative inline-block bg-[length:250%_100%,auto] bg-clip-text',
        'text-transparent [--base-color:#a1a1aa] [--base-gradient-color:#000]',
        '[background-repeat:no-repeat,padding-box] [--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--base-gradient-color),#0000_calc(50%+var(--spread)))]',
        'dark:[--base-color:#71717a] dark:[--base-gradient-color:#ffffff] dark:[--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--base-gradient-color),#0000_calc(50%+var(--spread)))] text-sm',
        className,
      )}
      initial={{ backgroundPosition: '100% center' }}
      animate={{ backgroundPosition: '0% center' }}
      transition={{
        repeat: repeat === Infinity ? Infinity : repeat - 1,
        duration,
        ease: 'linear',
        repeatDelay: repeat === Infinity ? 0.5 : 0,
      }}
      style={
        {
          '--spread': `${dynamicSpread}px`,
          backgroundImage: `var(--bg), linear-gradient(var(--base-color), var(--base-color))`,
        } as React.CSSProperties
      }
    >
      {children}
    </MotionComponent>
  );
}

export const TextShimmer = React.memo(TextShimmerComponent);
