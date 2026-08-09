'use client';

import { m, type MotionProps, useReducedMotion } from 'motion/react';
import { useEffect, useId, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

import { buildCells, type Cell, CELL_FONT_SIZE, VIEW_H, VIEW_W } from './kortix-hyper-logo.cells';

const LOGO_PATH =
  'M25.5614 24.916H29.8268C29.8268 19.6306 26.9378 15.0039 22.6171 12.4587C26.9377 9.91355 29.8267 5.28685 29.8267 0.00146484H25.5613C25.5613 5.00287 21.8906 9.18692 17.0654 10.1679V0.00146484H12.8005V10.1679C7.9526 9.20401 4.3046 5.0186 4.3046 0.00146484H0.0391572C0.0391572 5.28685 2.92822 9.91355 7.24884 12.4587C2.92818 15.0039 0.0390625 19.6306 0.0390625 24.916H4.30451C4.30451 19.8989 7.95259 15.7135 12.8005 14.7496V24.9206H17.0654V14.7496C21.9133 15.7134 25.5614 19.8989 25.5614 24.916Z';

interface KortixHyperLogoProps extends Omit<MotionProps, 'children'> {
  className?: string;
  size?: number;
  duration?: number;
  delay?: number;
  startOnView?: boolean;
  animateOnHover?: boolean;
  /** Replay the reveal continuously — use when this is a loading indicator. */
  loop?: boolean;
}

export function KortixHyperLogo({
  className,
  size = 80,
  duration = 800,
  delay = 0,
  startOnView = true,
  animateOnHover = true,
  loop = false,
  ...props
}: KortixHyperLogoProps) {
  const clipId = useId();
  const [cells, setCells] = useState<Cell[]>(() => buildCells(false));
  const [progress, setProgress] = useState(1);
  const [isAnimating, setIsAnimating] = useState(false);
  const [cycle, setCycle] = useState(0);
  const svgRef = useRef<SVGSVGElement | null>(null);
  /**
   * The reveal is a dissolve — 72 cells popping in on a random ramp — and
   * `loop` replays it forever with no pause control, which is exactly what
   * `prefers-reduced-motion: reduce` is for. Reduced motion never sets
   * `isAnimating`, so `progress` stays at its initial `1` and the solid mark
   * renders at rest: the logo is still there, it just does not dissolve.
   *
   * `useReducedMotion()` is `null` on the server, so the server render is
   * byte-identical either way and nothing can mismatch on hydration.
   */
  const reduceMotion = useReducedMotion();

  const handleAnimationTrigger = () => {
    if (animateOnHover && !isAnimating && !reduceMotion) {
      setCells(buildCells(true));
      setIsAnimating(true);
    }
  };

  // Randomize the grid once mounted — after hydration, so it never diverges
  // from the deterministic server render.
  useEffect(() => {
    const frame = requestAnimationFrame(() => setCells(buildCells(true)));
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (reduceMotion) return;

    if (!startOnView) {
      const startTimeout = setTimeout(() => setIsAnimating(true), delay);
      return () => clearTimeout(startTimeout);
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setTimeout(() => setIsAnimating(true), delay);
          observer.disconnect();
        }
      },
      { threshold: 0.1, rootMargin: '-30% 0px -30% 0px' },
    );

    if (svgRef.current) {
      observer.observe(svgRef.current);
    }

    return () => observer.disconnect();
  }, [delay, reduceMotion, startOnView]);

  useEffect(() => {
    let animationFrameId: number | null = null;
    let restartTimer: ReturnType<typeof setTimeout> | null = null;

    if (isAnimating) {
      const startTime = performance.now();

      const animate = (currentTime: number) => {
        const p = Math.min((currentTime - startTime) / duration, 1);
        setProgress(p);

        if (p < 1) {
          animationFrameId = requestAnimationFrame(animate);
        } else {
          setProgress(1);
          if (loop) {
            // hold the resolved logo briefly, then re-scramble and replay
            restartTimer = setTimeout(() => {
              setCells(buildCells(true));
              setCycle((c) => c + 1);
            }, 700);
          } else {
            setIsAnimating(false);
          }
        }
      };

      animationFrameId = requestAnimationFrame((currentTime) => {
        setProgress(0);
        animate(currentTime);
      });
    }

    return () => {
      if (animationFrameId !== null) cancelAnimationFrame(animationFrameId);
      if (restartTimer !== null) clearTimeout(restartTimer);
    };
  }, [duration, isAnimating, loop, cycle]);

  const fillPhase = Math.min(progress / 0.6, 1);
  const solidOpacity = progress <= 0.6 ? 0 : (progress - 0.6) / 0.4;

  return (
    <m.svg
      ref={svgRef}
      width={size}
      height={size}
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn('flex-shrink-0', className)}
      style={{ width: `${size}px`, height: `${size}px` }}
      onMouseEnter={handleAnimationTrigger}
      {...props}
    >
      <defs>
        <clipPath id={clipId}>
          <path d={LOGO_PATH} />
        </clipPath>
      </defs>

      <path d={LOGO_PATH} fill="currentColor" style={{ opacity: solidOpacity }} />

      <g clipPath={`url(#${clipId})`} style={{ opacity: 1 - solidOpacity }}>
        {cells.map((cell, i) => {
          const visible = cell.threshold <= fillPhase;
          return (
            <text
              key={i}
              x={cell.x}
              y={cell.y}
              fontSize={CELL_FONT_SIZE}
              textAnchor="middle"
              dominantBaseline="central"
              fill="currentColor"
              style={{
                opacity: visible ? 1 : 0,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
              }}
            >
              {cell.char}
            </text>
          );
        })}
      </g>
    </m.svg>
  );
}
