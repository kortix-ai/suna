'use client';

import { ShaderSafe } from '@/components/ui/shader-safe';
import { useWallpaperTheme } from '@/components/ui/wallpaper-shaders';
import dynamic from 'next/dynamic';
import { memo, type ReactNode } from 'react';

const GrainGradient = dynamic(
  () => import('@paper-design/shaders-react').then((m) => m.GrainGradient),
  { ssr: false },
);
const PaperTexture = dynamic(
  () => import('@paper-design/shaders-react').then((m) => m.PaperTexture),
  { ssr: false },
);
const NeuroNoise = dynamic(() => import('@paper-design/shaders-react').then((m) => m.NeuroNoise), {
  ssr: false,
});

// Wallpapers built on Paper Shaders (@paper-design/shaders-react) —
// single-pass WebGL2 fragments, much lighter than the multi-pass WebGPU
// engine behind the older presets. `maxPixelCount` caps GPU work on
// large/high-DPR displays: the canvas renders at most ~2M pixels and
// upscales in CSS, which is invisible on soft, organic compositions.
export const MAX_PIXEL_COUNT = 1920 * 1080;

/**
 * Shared props for the Paper Shader wallpapers. `maxPixelCount` exists so a
 * still-image export can render the composition at its true pixel size
 * (a 5K wallpaper must not be a 2 MP canvas upscaled by CSS). App surfaces
 * never pass it and keep the 2 MP cap.
 */
interface PaperShaderProps {
  maxPixelCount?: number;
}

const FILL_STYLE = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
} as const;

function PaperRoot({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`pointer-events-none absolute inset-0 overflow-hidden ${className ?? ''}`}
      aria-hidden="true"
    >
      <ShaderSafe>{children}</ShaderSafe>
    </div>
  );
}

// Soft banded gradient with a fine film-grain finish — print texture in
// page tones.
export const GrainShader = memo(function GrainShader({
  maxPixelCount = MAX_PIXEL_COUNT,
}: PaperShaderProps = {}) {
  const { isDark, bg, reduceMotion } = useWallpaperTheme();

  return (
    <PaperRoot className="opacity-60">
      <GrainGradient
        colorBack={bg}
        colors={isDark ? ['#191a1e', '#232429', '#2f3037'] : ['#f3f3f6', '#e6e6ea', '#d5d5dc']}
        intensity={0.15}
        maxPixelCount={maxPixelCount}
        noise={0.3}
        shape="wave"
        softness={0.7}
        speed={reduceMotion ? 0 : 1.8}
        style={FILL_STYLE}
      />
    </PaperRoot>
  );
});

// Living filament mesh drifting like a slow neural network.
export const NeuroShader = memo(function NeuroShader({
  maxPixelCount = MAX_PIXEL_COUNT,
}: PaperShaderProps = {}) {
  const { isDark, bg, reduceMotion } = useWallpaperTheme();

  return (
    <PaperRoot>
      <NeuroNoise
        brightness={isDark ? 0.03 : 0.02}
        colorBack={bg}
        colorFront={isDark ? '#7a7b85' : '#8f9099'}
        colorMid={isDark ? '#2a2b33' : '#eaeaee'}
        contrast={0.25}
        maxPixelCount={maxPixelCount}
        scale={1.2}
        speed={reduceMotion ? 0 : 0.5}
        style={FILL_STYLE}
      />
    </PaperRoot>
  );
});

const BEAMS_BACK = '#040807';

// Four soft light beams on near-black, warm at the leading edge and cool at
// the trailing one. An SVG so it paints before (and without) WebGL2.
const BEAMS_IMAGE = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1440" viewBox="0 0 600 960">
<defs>
<linearGradient id="a"><stop offset="0" stop-color="#b8935a"/><stop offset=".3" stop-color="#d9c9a3"/><stop offset=".55" stop-color="#f0ede4"/><stop offset=".78" stop-color="#b9c8de"/><stop offset="1" stop-color="#4f76b0"/></linearGradient>
<linearGradient id="b"><stop offset="0" stop-color="#55664a"/><stop offset=".5" stop-color="#cdbf9c"/><stop offset="1" stop-color="#dfe3e6"/></linearGradient>
<filter id="f" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="34"/></filter>
</defs>
<rect width="600" height="960" fill="${BEAMS_BACK}"/>
<g filter="url(#f)" transform="rotate(-24 300 480)">
<rect x="-200" y="215" width="1000" height="70" fill="url(#a)" opacity=".75"/>
<rect x="-200" y="330" width="1000" height="120" fill="url(#a)" opacity=".95"/>
<rect x="-200" y="560" width="1000" height="130" fill="url(#a)" opacity=".8"/>
<rect x="-200" y="800" width="1000" height="110" fill="url(#b)" opacity=".6"/>
</g>
</svg>`,
)}`;

// Hairlines crossing at the corners of the middle third. Percent positions and
// a fixed 1px width, so they hold on the tall panel and on the phone banner.
const BEAM_LINES: readonly { vertical: boolean; at: string }[] = [
  { vertical: true, at: '20%' },
  { vertical: true, at: '80%' },
  { vertical: false, at: '28%' },
  { vertical: false, at: '74%' },
];

// Light beams through grained paper: Paper's PaperTexture (roughness and fiber
// only, no folds) over the beam image, then crisp hairlines. Static, and dark
// in both themes.
export const BeamsShader = memo(function BeamsShader({
  maxPixelCount = MAX_PIXEL_COUNT,
}: PaperShaderProps = {}) {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={BEAMS_IMAGE} alt="" className="absolute inset-0 size-full object-cover" />
      <ShaderSafe>
        <PaperTexture
          colorBack={BEAMS_BACK}
          colorFront={BEAMS_BACK}
          contrast={0.3}
          crumples={0}
          drops={0}
          fiber={0.15}
          fit="cover"
          folds={0}
          image={BEAMS_IMAGE}
          maxPixelCount={maxPixelCount}
          roughness={0.6}
          // Overscan: the texture displaces the image, which frays its edge.
          scale={1.04}
          style={FILL_STYLE}
        />
      </ShaderSafe>
      <svg className="absolute inset-0 size-full">
        <defs>
          <linearGradient id="beam-line-v" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="#ffffff" stopOpacity="0" />
            <stop offset=".25" stopColor="#ffffff" stopOpacity=".8" />
            <stop offset=".75" stopColor="#ffffff" stopOpacity=".8" />
            <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="beam-line-h">
            <stop offset="0" stopColor="#e8c98a" stopOpacity="0" />
            <stop offset=".2" stopColor="#ffffff" stopOpacity=".8" />
            <stop offset=".8" stopColor="#cfe0ff" stopOpacity=".8" />
            <stop offset="1" stopColor="#7fa6e6" stopOpacity="0" />
          </linearGradient>
          <filter id="beam-line-glow" x="-400%" y="-400%" width="900%" height="900%">
            <feGaussianBlur stdDeviation="2" />
          </filter>
        </defs>
        {BEAM_LINES.map(({ vertical, at }) => {
          const line = vertical
            ? { x: at, y: 0, width: 1, height: '100%', fill: 'url(#beam-line-v)' }
            : { x: 0, y: at, width: '100%', height: 1, fill: 'url(#beam-line-h)' };
          return (
            <g key={`${vertical}-${at}`}>
              <rect {...line} filter="url(#beam-line-glow)" />
              <rect {...line} />
            </g>
          );
        })}
      </svg>
    </div>
  );
});

/** How the Beams art fades into the page under the copy that sits on it. */
const BEAMS_FADE = {
  // Copy centred on the pane: dim the top under the bar, settle into the page.
  hero: 'from-background/90 via-background/40 to-background bg-linear-to-b',
  // Copy on the pane's floor: a calm band at the bottom, beams above.
  floor: 'from-background/90 via-background/30 to-transparent bg-linear-to-t',
  // A card's caption at its foot.
  card: 'from-background via-background/60 to-transparent bg-linear-to-t',
  // A band between two dark sections: dark at both edges, beams in the middle.
  band: 'from-background via-background/30 to-background bg-linear-to-b',
} as const;

/**
 * Beams plus the fade that keeps copy on it legible, as one art layer. The
 * pane it sits in must be dark in both themes (`dark` on the container).
 */
export function BeamsBackdrop({ fade }: { fade: keyof typeof BEAMS_FADE }) {
  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden="true">
      <BeamsShader />
      <div className={`absolute inset-0 ${BEAMS_FADE[fade]}`} />
    </div>
  );
}
