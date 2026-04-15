'use client';

import { memo } from 'react';
import dynamic from 'next/dynamic';

const Shader = dynamic(() => import('shaders/react').then((m) => m.Shader), {
  ssr: false,
});
const Ascii = dynamic(() => import('shaders/react').then((m) => m.Ascii), {
  ssr: false,
});
const CRTScreen = dynamic(
  () => import('shaders/react').then((m) => m.CRTScreen),
  { ssr: false },
);
const FallingLines = dynamic(
  () => import('shaders/react').then((m) => m.FallingLines),
  { ssr: false },
);
const Glow = dynamic(() => import('shaders/react').then((m) => m.Glow), {
  ssr: false,
});
const SolidColor = dynamic(
  () => import('shaders/react').then((m) => m.SolidColor),
  { ssr: false },
);

// Dark-only wallpaper — the picker hides this in light mode. The iconic
// green katakana code rain only reads as itself on a black page.
export const MatrixShader = memo(function MatrixShader() {
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
        <SolidColor color="#0b1410" />
        <Ascii
          cellSize={25}
          characters="ﾊﾐﾋｰｳｼﾅﾓﾆｻﾜﾂｵﾘｱﾎﾃﾏｹﾒｴｶｷﾑﾕﾗｾﾈｽﾀﾇﾍ"
          fontFamily="Geist Mono"
          spacing={0.9}
        >
          <FallingLines
            colorA="#40ff5c"
            colorB="#032103ff"
            colorSpace="oklab"
            density={34}
            speed={0.45}
            speedVariance={0.55}
            strokeWidth={0.5}
            trailLength={0.7}
            visible={true}
          />
        </Ascii>
        <Glow intensity={6.8} size={2} threshold={0.4} visible={true} />
        {/* `tilt` and `zoom` aren't in the TS ComponentProps but the preset
            generator emits them; the shader runtime consumes them. */}
        <CRTScreen
          colorShift={0}
          pixelSize={112}
          scanlineFrequency={100}
          scanlineIntensity={0.1}
          vignetteIntensity={0.1}
          vignetteRadius={0.35}
          {...({ tilt: 30, zoom: 0.9 } as Record<string, number>)}
        />
      </Shader>
    </div>
  );
});
