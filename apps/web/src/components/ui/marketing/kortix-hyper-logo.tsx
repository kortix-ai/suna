'use client';

import { motion, type MotionProps } from 'motion/react';
import { useEffect, useId, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

const LOGO_PATH =
  'M25.5614 24.916H29.8268C29.8268 19.6306 26.9378 15.0039 22.6171 12.4587C26.9377 9.91355 29.8267 5.28685 29.8267 0.00146484H25.5613C25.5613 5.00287 21.8906 9.18692 17.0654 10.1679V0.00146484H12.8005V10.1679C7.9526 9.20401 4.3046 5.0186 4.3046 0.00146484H0.0391572C0.0391572 5.28685 2.92822 9.91355 7.24884 12.4587C2.92818 15.0039 0.0390625 19.6306 0.0390625 24.916H4.30451C4.30451 19.8989 7.95259 15.7135 12.8005 14.7496V24.9206H17.0654V14.7496C21.9133 15.7134 25.5614 19.8989 25.5614 24.916Z';

const VIEW_W = 30;
const VIEW_H = 25;

const RAMP = ['░', '▒', '▓', '█'] as const;

const COLS = 9;
const ROWS = 8;
const CELL_W = VIEW_W / COLS;
const CELL_H = VIEW_H / ROWS;

interface KortixHyperLogoProps extends Omit<MotionProps, 'children'> {
  className?: string;
  size?: number;
  duration?: number;
  delay?: number;
  startOnView?: boolean;
  animateOnHover?: boolean;
}

const getRandomInt = (max: number): number => Math.floor(Math.random() * max);

interface Cell {
  x: number;
  y: number;
  char: string;
  threshold: number;
}

const buildCells = (): Cell[] => {
  const cells: Cell[] = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      cells.push({
        x: c * CELL_W + CELL_W / 2,
        y: r * CELL_H + CELL_H / 2,
        char: RAMP[getRandomInt(RAMP.length)],
        threshold: Math.random(),
      });
    }
  }
  return cells;
};

export function KortixHyperLogo({
  className,
  size = 80,
  duration = 800,
  delay = 0,
  startOnView = true,
  animateOnHover = true,
  ...props
}: KortixHyperLogoProps) {
  const clipId = useId();
  const [cells, setCells] = useState<Cell[]>(() => buildCells());
  const [progress, setProgress] = useState(1);
  const [isAnimating, setIsAnimating] = useState(false);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const handleAnimationTrigger = () => {
    if (animateOnHover && !isAnimating) {
      setCells(buildCells());
      setIsAnimating(true);
    }
  };

  useEffect(() => {
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
  }, [delay, startOnView]);

  useEffect(() => {
    let animationFrameId: number | null = null;

    if (isAnimating) {
      const startTime = performance.now();

      const animate = (currentTime: number) => {
        const p = Math.min((currentTime - startTime) / duration, 1);
        setProgress(p);

        if (p < 1) {
          animationFrameId = requestAnimationFrame(animate);
        } else {
          setProgress(1);
          setIsAnimating(false);
        }
      };

      setProgress(0);
      animationFrameId = requestAnimationFrame(animate);
    }

    return () => {
      if (animationFrameId !== null) cancelAnimationFrame(animationFrameId);
    };
  }, [duration, isAnimating]);

  const fillPhase = Math.min(progress / 0.6, 1);
  const solidOpacity = progress <= 0.6 ? 0 : (progress - 0.6) / 0.4;

  return (
    <motion.svg
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
              fontSize={CELL_H * 1.25}
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
    </motion.svg>
  );
}
