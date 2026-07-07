'use client';

import { useRef } from 'react';

import { flowAngle } from './mark-math';
import { MARK_CANVAS_CLASS, MarkStage } from './mark-stage';
import { useCanvasScene } from './use-canvas';

// Fixed ink medium so the trails glow — the effect *is* the light. White
// currents laced with Kortix orange.
// Gentle fade → long, silky trails (a heavier wash chops them into busy dashes).
const FADE = 'rgba(10,10,10,0.04)';
const BASE = 'rgba(232,232,232,0.42)';
const ORANGE = 'rgba(224,138,51,0.8)';

const COUNT = 900;
const SPEED = 1.05;
const ORANGE_RATIO = 0.14;

type Particle = { x: number; y: number; life: number; orange: boolean };

function spawn(width: number, height: number): Particle {
  return {
    x: Math.random() * width,
    y: Math.random() * height,
    life: 120 + Math.random() * 260,
    orange: Math.random() < ORANGE_RATIO,
  };
}

export type CurrentsProps = { className?: string };

/**
 * A flow field: particles ride a slowly shifting pseudo-curl field, leaving
 * silky trails. Trails persist because each frame only paints a faint ink wash
 * over the last, rather than clearing.
 */
export function Currents({ className }: CurrentsProps) {
  const particles = useRef<Particle[] | null>(null);

  const { containerRef, canvasRef } = useCanvasScene(({ ctx, width, height, now }) => {
    if (!particles.current) {
      particles.current = Array.from({ length: COUNT }, () => spawn(width, height));
    }
    const points = particles.current;
    const t = now / 4200;

    ctx.globalAlpha = 1;
    ctx.fillStyle = FADE;
    ctx.fillRect(0, 0, width, height);
    ctx.lineWidth = 1;
    ctx.lineCap = 'round';

    for (const p of points) {
      const angle = flowAngle(p.x, p.y, t);
      const nx = p.x + Math.cos(angle) * SPEED;
      const ny = p.y + Math.sin(angle) * SPEED;

      ctx.strokeStyle = p.orange ? ORANGE : BASE;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(nx, ny);
      ctx.stroke();

      p.x = nx;
      p.y = ny;
      p.life -= 1;
      if (p.life <= 0 || nx < -10 || nx > width + 10 || ny < -10 || ny > height + 10) {
        Object.assign(p, spawn(width, height));
      }
    }
  });

  return (
    <MarkStage containerRef={containerRef} tone="ink" className={className}>
      <canvas ref={canvasRef} className={MARK_CANVAS_CLASS} />
    </MarkStage>
  );
}
