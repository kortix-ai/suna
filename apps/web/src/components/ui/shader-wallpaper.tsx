'use client';

import { memo } from 'react';
import dynamic from 'next/dynamic';
import { useTheme } from 'next-themes';

const Shader = dynamic(() => import('shaders/react').then((m) => m.Shader), {
  ssr: false,
});
const Dither = dynamic(() => import('shaders/react').then((m) => m.Dither), {
  ssr: false,
});
const Plasma = dynamic(() => import('shaders/react').then((m) => m.Plasma), {
  ssr: false,
});
const WaveDistortion = dynamic(
  () => import('shaders/react').then((m) => m.WaveDistortion),
  { ssr: false },
);

export const ShaderWallpaper = memo(function ShaderWallpaper() {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  // Kortix brand is pure monochrome (white/black). Light mode mirrors the
  // dark preset: pure white base with a mid-grey dither tone (so the dots
  // read clearly on white the same way the dark preset's lighter tone
  // reads on near-black).
  const colorA = isDark ? '#121214' : '#ffffff';
  const colorB = isDark ? '#202124' : '#c9c9cd';
  const waveAngle = isDark ? 256 : 285;

  return (
    <div
      className="absolute inset-0 pointer-events-none overflow-hidden"
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
        <Dither
          colorA={colorA}
          colorB={colorB}
          pattern="bayer8"
          pixelSize={7}
          threshold={0.41}
        >
          <Plasma
            colorA="#ffffff"
            contrast={0.9}
            density={0.3}
            intensity={1.3}
            speed={1}
          />
          <WaveDistortion
            angle={waveAngle}
            edges="mirror"
            frequency={1.8}
            strength={1}
            visible={true}
            waveType="square"
          />
        </Dither>
      </Shader>
    </div>
  );
});
