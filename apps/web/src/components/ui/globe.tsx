'use client';

import { useEffect, useRef } from 'react';
import createGlobe, { type COBEOptions } from 'cobe';
import { useMotionValue, useSpring } from 'motion/react';

import { cn } from '@/lib/utils';

const MOVEMENT_DAMPING = 1400;

const GLOBE_CONFIG: COBEOptions = {
  width: 800,
  height: 800,
  onRender: () => {},
  devicePixelRatio: 2,
  phi: 0,
  theta: 0.3,
  dark: 0,
  diffuse: 0.4,
  mapSamples: 16000,
  mapBrightness: 1.2,
  baseColor: [1, 1, 1],
  markerColor: [251 / 255, 100 / 255, 21 / 255],
  glowColor: [1, 1, 1],
  markers: [
    { location: [14.5995, 120.9842], size: 0.03 },
    { location: [19.076, 72.8777], size: 0.1 },
    { location: [23.8103, 90.4125], size: 0.05 },
    { location: [30.0444, 31.2357], size: 0.07 },
    { location: [39.9042, 116.4074], size: 0.08 },
    { location: [-23.5505, -46.6333], size: 0.1 },
    { location: [19.4326, -99.1332], size: 0.1 },
    { location: [40.7128, -74.006], size: 0.1 },
    { location: [34.6937, 135.5022], size: 0.05 },
    { location: [41.0082, 28.9784], size: 0.06 },
  ],
};

export function Globe({
  className,
  config = GLOBE_CONFIG,
  autoRotate = true,
  targetPhi,
  targetTheta,
}: {
  className?: string;
  config?: COBEOptions;
  autoRotate?: boolean;
  targetPhi?: number;
  targetTheta?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const phiRef = useRef(targetPhi ?? config.phi ?? 0);
  const thetaRef = useRef(targetTheta ?? config.theta ?? 0.3);
  const targetPhiRef = useRef(phiRef.current);
  const targetThetaRef = useRef(thetaRef.current);
  const widthRef = useRef(0);
  const pointerInteracting = useRef<number | null>(null);
  const pointerInteractionMovement = useRef(0);
  const autoRotateRef = useRef(autoRotate);
  const globeRef = useRef<ReturnType<typeof createGlobe> | null>(null);

  const r = useMotionValue(0);
  const rs = useSpring(r, {
    mass: 1,
    damping: 30,
    stiffness: 100,
  });

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

  // Update targets when props change (without recreating globe)
  useEffect(() => {
    if (targetPhi !== undefined) targetPhiRef.current = targetPhi;
  }, [targetPhi]);

  useEffect(() => {
    if (targetTheta !== undefined) targetThetaRef.current = targetTheta;
  }, [targetTheta]);

  useEffect(() => {
    autoRotateRef.current = autoRotate;
  }, [autoRotate]);

  useEffect(() => {
    const onResize = () => {
      if (canvasRef.current) {
        widthRef.current = canvasRef.current.offsetWidth;
      }
    };

    window.addEventListener('resize', onResize);
    onResize();

    if (!canvasRef.current) return;
    const globe = createGlobe(canvasRef.current, {
      ...config,
      phi: phiRef.current,
      theta: thetaRef.current,
      width: widthRef.current * 2,
      height: widthRef.current * 2,
      onRender: (state) => {
        if (!pointerInteracting.current && autoRotateRef.current) {
          phiRef.current += 0.005;
        }

        // Lerp phi towards target (shortest path)
        const dp = targetPhiRef.current - phiRef.current;
        if (Math.abs(dp) > 0.01) {
          phiRef.current += dp * 0.08;
        }

        // Lerp theta towards target
        const dt = targetThetaRef.current - thetaRef.current;
        if (Math.abs(dt) > 0.005) {
          thetaRef.current += dt * 0.08;
        }

        state.phi = phiRef.current + rs.get();
        state.theta = thetaRef.current;
        state.width = widthRef.current * 2;
        state.height = widthRef.current * 2;
      },
    });

    globeRef.current = globe;
    setTimeout(() => (canvasRef.current!.style.opacity = '1'), 0);
    return () => {
      globe.destroy();
      globeRef.current = null;
      window.removeEventListener('resize', onResize);
    };
  }, [rs, config]);

  return (
    <div
      className={cn(
        'absolute inset-0 mx-auto aspect-square w-full max-w-150',
        className,
      )}
    >
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
        onTouchMove={(e) =>
          e.touches[0] && updateMovement(e.touches[0].clientX)
        }
      />
    </div>
  );
}
