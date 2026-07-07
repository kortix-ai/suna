'use client';

import { KORTIX_SYMBOL_PATH } from './mark-math';
import { MarkStage } from './mark-stage';

// The symbol (30×25) scaled ×8 and centred inside the 300×250 viewBox, leaving
// an even margin. Drifting, blurred, screen-blended colour blobs glow through
// it — a calm brand aurora. Fixed dark medium (the effect *is* the light).
const SYMBOL_TRANSFORM = 'translate(30,25) scale(8)';

const CSS = `
  .aurora-blob { mix-blend-mode: screen; }
  @media (prefers-reduced-motion: no-preference) {
    .aurora-b1 { animation: aurora-b1 11s ease-in-out infinite; }
    .aurora-b2 { animation: aurora-b2 13s ease-in-out infinite; }
    .aurora-b3 { animation: aurora-b3 9s ease-in-out infinite; }
    .aurora-b4 { animation: aurora-b4 15s ease-in-out infinite; }
  }
  @keyframes aurora-b1 { 0%,100% { transform: translate(90px,80px); } 50% { transform: translate(165px,155px); } }
  @keyframes aurora-b2 { 0%,100% { transform: translate(215px,90px); } 50% { transform: translate(120px,170px); } }
  @keyframes aurora-b3 { 0%,100% { transform: translate(150px,185px); } 50% { transform: translate(205px,70px); } }
  @keyframes aurora-b4 { 0%,100% { transform: translate(120px,120px); } 50% { transform: translate(85px,60px); } }
`;

export type AuroraMarkProps = { className?: string };

/**
 * The Kortix symbol as a window onto a slowly drifting multi-colour aurora
 * (orange · blue · violet · green), masked to the mark and glowing on ink.
 */
export function AuroraMark({ className }: AuroraMarkProps) {
  return (
    <MarkStage tone="ink" aspect="aspect-[6/5]" className={className}>
      <svg
        viewBox="0 0 300 250"
        className="h-full w-full"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="Kortix"
      >
        <defs>
          <filter id="aurora-blur" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="30" />
          </filter>
          <mask id="aurora-mask">
            <rect width="300" height="250" fill="black" />
            <path d={KORTIX_SYMBOL_PATH} fill="white" transform={SYMBOL_TRANSFORM} />
          </mask>
        </defs>

        <g mask="url(#aurora-mask)">
          <rect width="300" height="250" fill="#0a0a0a" />
          <g filter="url(#aurora-blur)">
            <circle className="aurora-blob aurora-b1" r="82" fill="#e08a33" />
            <circle className="aurora-blob aurora-b2" r="92" fill="#3d7bd6" />
            <circle className="aurora-blob aurora-b3" r="72" fill="#a974d6" />
            <circle className="aurora-blob aurora-b4" r="86" fill="#2fae63" />
          </g>
          <path
            d={KORTIX_SYMBOL_PATH}
            transform={SYMBOL_TRANSFORM}
            fill="none"
            stroke="rgba(255,255,255,0.16)"
            strokeWidth="0.25"
          />
        </g>

        <style dangerouslySetInnerHTML={{ __html: CSS }} />
      </svg>
    </MarkStage>
  );
}
