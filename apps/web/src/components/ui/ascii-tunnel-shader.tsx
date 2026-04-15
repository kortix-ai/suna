'use client';

import { memo } from 'react';
import dynamic from 'next/dynamic';
import { useTheme } from 'next-themes';

const Shader = dynamic(() => import('shaders/react').then((m) => m.Shader), {
  ssr: false,
});
const Ascii = dynamic(() => import('shaders/react').then((m) => m.Ascii), {
  ssr: false,
});
const FallingLines = dynamic(
  () => import('shaders/react').then((m) => m.FallingLines),
  { ssr: false },
);
const Form3D = dynamic(() => import('shaders/react').then((m) => m.Form3D), {
  ssr: false,
});
const RadialGradient = dynamic(
  () => import('shaders/react').then((m) => m.RadialGradient),
  { ssr: false },
);
const StudioBackground = dynamic(
  () => import('shaders/react').then((m) => m.StudioBackground),
  { ssr: false },
);

// Palette identical to Pixel Beams (Kortix monochrome brand): pure
// white in light mode, near-black in dark mode. The studio's directional
// lighting is flattened in light mode so the white page reads as flat
// (otherwise key/back lights subtract toward grey, leaving smudges).
export const AsciiTunnelShader = memo(function AsciiTunnelShader() {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  const bgColor = isDark ? '#121214' : '#ffffff';
  const lineColorA = isDark ? '#ffffff' : '#c9c9cd';
  const lineColorB = isDark ? '#202124' : '#ffffff';
  const ambientIntensity = isDark ? 98 : 0;
  const keyIntensity = isDark ? 5 : 0;
  const backIntensity = isDark ? 25 : 0;

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
        <RadialGradient
          center={{ x: 0.5, y: 1 }}
          colorA={bgColor}
          colorB={bgColor}
          radius={0.8}
          visible={false}
        />
        <StudioBackground
          ambientIntensity={ambientIntensity}
          ambientSpeed={5}
          brightness={100}
          center={{ x: 0.5, y: 1 }}
          color={bgColor}
          fillIntensity={0}
          keyIntensity={keyIntensity}
          {...({ backIntensity } as Record<string, number>)}
          lightTarget={0}
        />
        <Ascii
          alphaThreshold={0.14}
          cellSize={12}
          characters="┉╳┉╳"
          gamma={0.25}
          preserveAlpha={false}
        >
          <Form3D
            glossiness={0}
            lighting={0}
            // The library's TS type declares shape3d as string, but the
            // preset generator emits an object which is parsed at runtime.
            shape3d={
              {
                type: 'torus',
                outerRadius: 102,
                tubeRadius: 100,
                rotX: -90,
                rotY: 0,
                rotZ: 0,
                spinX: 0,
                spinY: 0.5,
                spinZ: 0,
              } as unknown as string
            }
            shape3dType="torus"
            zoom={92}
          >
            <FallingLines
              colorA={lineColorA}
              colorB={lineColorB}
              density={17}
              speed={0.25}
              speedVariance={0.55}
              strokeWidth={0.38}
              trailLength={0.49}
            />
          </Form3D>
        </Ascii>
      </Shader>
    </div>
  );
});
