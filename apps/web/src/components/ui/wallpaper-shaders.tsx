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
const SimplexNoise = dynamic(() => import('@/lib/shaders-react').then((m) => m.SimplexNoise), {
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

// Retro pixel clouds: slow simplex noise quantized through an ordered
// bayer dither — the pixel motif of Pixel Beams without its intensity.
export const DitherShader = memo(function DitherShader() {
  const { isDark, bg, reduceMotion } = useWallpaperTheme();

  return (
    <ShaderRoot className="opacity-60">
      <Dither
        colorA={bg}
        colorB={isDark ? '#222327' : '#e3e3e7'}
        colorMode="custom"
        pattern="bayer8"
        pixelSize={6}
      >
        {/* Higher contrast pushes large regions to pure background so the
            dither reads as drifting clouds, not full-screen texture. */}
        <SimplexNoise
          colorA="#ffffff"
          colorB="#000000"
          contrast={0.45}
          scale={2.8}
          speed={reduceMotion ? 0 : 0.09}
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
