'use client';

import { useEffect, useMemo, useRef } from 'react';
import createGlobe, { type COBEOptions } from 'cobe';
import { useMotionValue, useSpring } from 'motion/react';
import { useTheme } from 'next-themes';

import { cn } from '../../lib/utils';

const MOVEMENT_DAMPING = 1400;

// Markers: Falkenstein (active) + planned regions.
const DEFAULT_MARKERS: COBEOptions['markers'] = [
  { location: [50.476, 12.366], size: 0.1 },
  { location: [38.953, -77.456], size: 0.04 },
  { location: [34.052, -118.244], size: 0.04 },
  { location: [1.352, 103.819], size: 0.04 },
  { location: [-23.551, -46.633], size: 0.04 },
  { location: [-33.868, 151.209], size: 0.04 },
  { location: [35.689, 139.692], size: 0.04 },
  { location: [28.6139, 77.209], size: 0.04 },
];

// Rotate Europe (lng ≈ 12°) to the front of the visible face.
const INITIAL_PHI = (-12 * Math.PI) / 180;

// Tuned for a near-white luminous sphere on a light backdrop.
const LIGHT_CONFIG: COBEOptions = {
  width: 800,
  height: 800,
  onRender: () => {},
  devicePixelRatio: 2,
  phi: INITIAL_PHI,
  theta: 0.3,
  dark: 0,
  diffuse: 0.4,
  mapSamples: 16000,
  mapBrightness: 1.2,
  baseColor: [1, 1, 1],
  markerColor: [251 / 255, 100 / 255, 21 / 255],
  glowColor: [1, 1, 1],
  markers: DEFAULT_MARKERS,
};

// Tuned for visibility on dark bg: brighter continents, dimmer glow blending into bg.
const DARK_CONFIG: COBEOptions = {
  ...LIGHT_CONFIG,
  dark: 1,
  diffuse: 1.2,
  mapBrightness: 6,
  baseColor: [0.35, 0.35, 0.38],
  glowColor: [0.18, 0.18, 0.2],
};

export function ThreeGlobe({
  className,
  config,
  autoRotate = false,
}: {
  className?: string;
  config?: COBEOptions;
  /** Auto-spin the globe. Off by default — set true for marketing surfaces. */
  autoRotate?: boolean;
}) {
  const { resolvedTheme } = useTheme();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const phiRef = useRef(INITIAL_PHI);
  const widthRef = useRef(0);
  const pointerInteracting = useRef<number | null>(null);
  const pointerInteractionMovement = useRef(0);

  const r = useMotionValue(0);
  const rs = useSpring(r, {
    mass: 1,
    damping: 30,
    stiffness: 100,
  });

  const resolvedConfig = useMemo(() => {
    if (config) return config;
    return resolvedTheme === 'dark' ? DARK_CONFIG : LIGHT_CONFIG;
  }, [config, resolvedTheme]);

  const updatePointerInteraction = (value: number | null) => {
    pointerInteracting.current = value;
    if (canvasRef.current) {
      canvasRef.current.style.cursor = value !== null ? 'grabbing' : 'grab';
    }
  };

  const updateMovement = (clientX: number) => {
    if (pointerInteracting.current !== null) {
      const delta = clientX - pointerInteracting.current;
      pointerInteractionMovement.current = delta;
      r.set(r.get() + delta / MOVEMENT_DAMPING);
    }
  };

  useEffect(() => {
    const onResize = () => {
      if (canvasRef.current) {
        widthRef.current = canvasRef.current.offsetWidth;
      }
    };

    window.addEventListener('resize', onResize);
    onResize();

    const globe = createGlobe(canvasRef.current!, {
      ...resolvedConfig,
      width: widthRef.current * 2,
      height: widthRef.current * 2,
      onRender: (state) => {
        if (autoRotate && !pointerInteracting.current) {
          phiRef.current += 0.0022;
        }
        state.phi = phiRef.current + rs.get();
        state.width = widthRef.current * 2;
        state.height = widthRef.current * 2;
      },
    });

    setTimeout(() => (canvasRef.current!.style.opacity = '1'), 0);
    return () => {
      globe.destroy();
      window.removeEventListener('resize', onResize);
    };
  }, [rs, resolvedConfig, autoRotate]);

  return (
    <div className={cn('absolute inset-0 mx-auto aspect-square w-full max-w-150', className)}>
      <canvas
        className={cn(
          'size-full opacity-0 transition-opacity duration-500 contain-[layout_paint_size]',
        )}
        ref={canvasRef}
        onPointerDown={(e) => {
          pointerInteracting.current = e.clientX;
          updatePointerInteraction(e.clientX);
        }}
        onPointerUp={() => updatePointerInteraction(null)}
        onPointerOut={() => updatePointerInteraction(null)}
        onMouseMove={(e) => updateMovement(e.clientX)}
        onTouchMove={(e) => e.touches[0] && updateMovement(e.touches[0].clientX)}
      />
    </div>
  );
}
