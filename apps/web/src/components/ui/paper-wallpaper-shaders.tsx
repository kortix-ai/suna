'use client';

import { ShaderSafe } from '@/components/ui/shader-safe';
import { useWallpaperTheme } from '@/components/ui/wallpaper-shaders';
import dynamic from 'next/dynamic';
import { memo, type ReactNode } from 'react';

const GrainGradient = dynamic(
  () => import('@paper-design/shaders-react').then((m) => m.GrainGradient),
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
const MAX_PIXEL_COUNT = 1920 * 1080;

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
export const GrainShader = memo(function GrainShader() {
  const { isDark, bg, reduceMotion } = useWallpaperTheme();

  return (
    <PaperRoot className="opacity-60">
      <GrainGradient
        colorBack={bg}
        colors={isDark ? ['#191a1e', '#232429', '#2f3037'] : ['#f3f3f6', '#e6e6ea', '#d5d5dc']}
        intensity={0.15}
        maxPixelCount={MAX_PIXEL_COUNT}
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
export const NeuroShader = memo(function NeuroShader() {
  const { isDark, bg, reduceMotion } = useWallpaperTheme();

  return (
    <PaperRoot>
      <NeuroNoise
        brightness={isDark ? 0.03 : 0.02}
        colorBack={bg}
        colorFront={isDark ? '#7a7b85' : '#8f9099'}
        colorMid={isDark ? '#2a2b33' : '#eaeaee'}
        contrast={0.25}
        maxPixelCount={MAX_PIXEL_COUNT}
        scale={1.2}
        speed={reduceMotion ? 0 : 0.5}
        style={FILL_STYLE}
      />
    </PaperRoot>
  );
});
