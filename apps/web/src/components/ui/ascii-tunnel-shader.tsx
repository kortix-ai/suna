'use client';

import { memo } from 'react';
import dynamic from 'next/dynamic';

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

// Dark-only wallpaper — the picker hides this in light mode. The cool
// violet-black tunnel relies on the studio's dramatic ambient/key
// lighting subtracting toward true black, which can't be inverted to
// look right on a white page.
export const AsciiTunnelShader = memo(function AsciiTunnelShader() {
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
          colorA="#180726"
          colorB="#0f0f17"
          radius={0.8}
          visible={false}
        />
        <StudioBackground
          ambientIntensity={98}
          ambientSpeed={5}
          brightness={100}
          center={{ x: 0.5, y: 1 }}
          color="#0e1214"
          fillIntensity={0}
          keyIntensity={5}
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
              colorB="#000000"
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
