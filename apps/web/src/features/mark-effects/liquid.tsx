'use client';

import { MarkStage } from './mark-stage';

// The classic SVG "goo": blur the blobs, then crank alpha contrast so nearby
// blobs fuse with a liquid surface tension. Blobs drift on CSS keyframes; the
// filter does the merging every frame. Molten Kortix orange on ink.
const CSS = `
  @media (prefers-reduced-motion: no-preference) {
    .liquid-a { animation: liquid-a 9s ease-in-out infinite; }
    .liquid-b { animation: liquid-b 11s ease-in-out infinite; }
    .liquid-c { animation: liquid-c 8s ease-in-out infinite; }
    .liquid-d { animation: liquid-d 13s ease-in-out infinite; }
    .liquid-e { animation: liquid-e 10s ease-in-out infinite; }
  }
  @keyframes liquid-a { 0%,100% { transform: translate(0,0); } 50% { transform: translate(46px,-14px); } }
  @keyframes liquid-b { 0%,100% { transform: translate(0,0); } 50% { transform: translate(-38px,18px); } }
  @keyframes liquid-c { 0%,100% { transform: translate(0,0); } 50% { transform: translate(30px,26px); } }
  @keyframes liquid-d { 0%,100% { transform: translate(0,0); } 50% { transform: translate(-52px,-10px); } }
  @keyframes liquid-e { 0%,100% { transform: translate(0,0); } 50% { transform: translate(18px,-30px); } }
`;

export type LiquidProps = { className?: string };

/**
 * Molten Kortix-orange metaballs that drift, merge, and part — an SVG goo
 * filter standing in for surface tension. Fixed ink backdrop.
 */
export function Liquid({ className }: LiquidProps) {
  return (
    <MarkStage tone="ink" className={className}>
      <svg viewBox="0 0 320 180" className="h-full w-full" preserveAspectRatio="xMidYMid slice">
        <defs>
          <filter id="liquid-goo">
            <feGaussianBlur in="SourceGraphic" stdDeviation="9" result="blur" />
            <feColorMatrix
              in="blur"
              mode="matrix"
              values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 20 -9"
            />
          </filter>
          <linearGradient id="liquid-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#f0a44f" />
            <stop offset="100%" stopColor="#cf6f1c" />
          </linearGradient>
        </defs>

        <rect width="320" height="180" fill="#0a0a0a" />
        <g filter="url(#liquid-goo)" fill="url(#liquid-grad)">
          <circle className="liquid-a" cx="96" cy="92" r="34" />
          <circle className="liquid-b" cx="150" cy="86" r="27" />
          <circle className="liquid-c" cx="206" cy="94" r="36" />
          <circle className="liquid-d" cx="132" cy="98" r="22" />
          <circle className="liquid-e" cx="186" cy="82" r="29" />
        </g>

        <style dangerouslySetInnerHTML={{ __html: CSS }} />
      </svg>
    </MarkStage>
  );
}
