'use client';

import { useReducedMotion } from 'motion/react';
import { useTheme } from 'next-themes';
import dynamic from 'next/dynamic';
import { memo, type ReactNode } from 'react';

const Shader = dynamic(() => import('@/lib/shaders-react').then((m) => m.Shader), {
  ssr: false,
});
const Dither = dynamic(() => import('@/lib/shaders-react').then((m) => m.Dither), {
  ssr: false,
});
const FlowingGradient = dynamic(
  () => import('@/lib/shaders-react').then((m) => m.FlowingGradient),
  {
    ssr: false,
  },
);
const LinearGradient = dynamic(() => import('@/lib/shaders-react').then((m) => m.LinearGradient), {
  ssr: false,
});
const WaveDistortion = dynamic(() => import('@/lib/shaders-react').then((m) => m.WaveDistortion), {
  ssr: false,
});

// Ambient wallpapers share the Kortix monochrome palette (pure white page
// in light mode, near-black in dark mode) and stay at one generator plus
// at most one filter per composition. Only the selected wallpaper renders
// live on the page — the settings picker uses pre-rendered thumbnails —
// so at most one canvas animates at a time.
export function useWallpaperTheme() {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  // Reduced motion freezes the composition (speed/twinkle 0) instead of
  // removing it — a still wallpaper is still a wallpaper.
  const reduceMotion = useReducedMotion() ?? false;
  return { isDark, bg: isDark ? '#121214' : '#ffffff', reduceMotion };
}

function ShaderRoot({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`pointer-events-none absolute inset-0 overflow-hidden ${className ?? ''}`}
      aria-hidden="true"
    >
      <Shader
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
        }}
      >
        {children}
      </Shader>
    </div>
  );
}

// A dithered sky: a smooth vertical luminance ramp quantized through the
// bayer matrix, so the top edge is a field of ordered pixels that thins
// band by band and dissolves into clean page well before the center. A
// fainter rise from the bottom edge frames the composer. The beauty of
// ordered dithering is the stepped density bands of a smooth gradient —
// no noise, no blobs, and the middle of the screen stays empty. Static.
//
// Dither math: a dot fires when luminance ≥ 1 − threshold + (bayer −
// 0.5) · spread, so with threshold 0.47 / spread 1 the ramp maps ~1:1 to
// density and pure black stays truly empty.
export const DitherShader = memo(function DitherShader() {
  const { isDark, bg, reduceMotion } = useWallpaperTheme();

  return (
    <ShaderRoot className="opacity-10">
      <Dither
        colorA={bg}
        colorB={isDark ? '#84858d' : '#55565d'}
        colorMode="custom"
        pattern="bayer8"
        pixelSize={6}
        spread={1}
        threshold={0.47}
      >
        {/* Sky: peaks at ~48% dot density on the top edge (never a full
            checkerboard, which reads heavy), empty by 40% down. */}
        <LinearGradient
          colorA="#7c7c7c"
          colorB="#000000"
          start={{ x: 0.5, y: 0 }}
          end={{ x: 0.5, y: 0.4 }}
        />
        {/* Ground: a quieter rise from the bottom edge, gone by ~72% height.
            `lighten` adds it onto the sky layer's black without darkening. */}
        <LinearGradient
          blendMode="lighten"
          colorA="#4d4d4d"
          colorB="#000000"
          start={{ x: 0.5, y: 1 }}
          end={{ x: 0.5, y: 0.72 }}
        />
        {/* A slow sine warp on the ramps makes the density bands undulate
            like a tide — the sky breathes without ever crossing the empty
            middle. */}
        <WaveDistortion
          angle={90}
          edges="stretch"
          frequency={1.3}
          speed={reduceMotion ? 0 : 0.5}
          strength={0.15}
          waveType="sine"
        />
      </Dither>
    </ShaderRoot>
  );
});

// Slow flowing gradient in four near-page tones — silk in monochrome.
export const SilkShader = memo(function SilkShader() {
  const { isDark, reduceMotion } = useWallpaperTheme();

  return (
    <ShaderRoot>
      <FlowingGradient
        colorA={isDark ? '#121214' : '#ffffff'}
        colorB={isDark ? '#1a1b1f' : '#f2f2f5'}
        colorC={isDark ? '#222329' : '#e6e6ea'}
        colorD={isDark ? '#17181c' : '#f7f7fa'}
        distortion={0.4}
        speed={reduceMotion ? 0 : 0.8}
      />
    </ShaderRoot>
  );
});
