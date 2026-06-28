'use client';

import { useEffect, useRef } from 'react';

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  hx: number;
  hy: number;
  delay: number;
};

const BRANDMARK_SRC = '/brandkit/Logo/Brandmark/SVG/Brandmark Black.svg';

/**
 * A Rauch-style hard-pixel particle canvas that resolves into the Kortix
 * brandmark, then lets pointer/touch movement disturb and settle the mark.
 */
export function KortixParticleMark() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    let dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
    let particleStride = 2 * dpr;
    let particleSize = dpr;
    let particles: Particle[] = [];
    let sceneStartedAt = performance.now();
    let isPointerActive = false;
    let pointerX = 0;
    let pointerY = 0;
    let pointerVelocityX = 0;
    let pointerVelocityY = 0;
    let isDisposed = false;

    const brandmark = new Image();
    brandmark.decoding = 'async';
    brandmark.src = BRANDMARK_SRC;

    const rebuildParticles = () => {
      if (!brandmark.complete || brandmark.naturalWidth === 0) return;

      dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
      particleStride = 2 * dpr;
      particleSize = dpr;

      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      canvas.width = viewportWidth * dpr;
      canvas.height = viewportHeight * dpr;
      canvas.style.width = `${viewportWidth}px`;
      canvas.style.height = `${viewportHeight}px`;
      ctx.imageSmoothingEnabled = false;

      const aspectRatio = brandmark.naturalWidth / brandmark.naturalHeight;
      const targetWidthCss = Math.max(
        132,
        Math.min(244, viewportWidth * 0.54, viewportHeight * 0.7 * aspectRatio),
      );
      const targetWidth = Math.round(targetWidthCss * dpr);
      const targetHeight = Math.round(targetWidth / aspectRatio);

      const offscreen = document.createElement('canvas');
      offscreen.width = targetWidth;
      offscreen.height = targetHeight;

      const offscreenCtx = offscreen.getContext('2d');
      if (!offscreenCtx) return;

      offscreenCtx.imageSmoothingEnabled = true;
      offscreenCtx.drawImage(brandmark, 0, 0, targetWidth, targetHeight);

      const imageData = offscreenCtx.getImageData(0, 0, targetWidth, targetHeight);
      const offsetX = (canvas.width - targetWidth) / 2;
      const offsetY = (canvas.height - targetHeight) / 2;
      const nextParticles: Particle[] = [];

      for (let y = 0; y < targetHeight; y += particleStride) {
        for (let x = 0; x < targetWidth; x += particleStride) {
          const alpha = imageData.data[(y * targetWidth + x) * 4 + 3];
          if (alpha <= 32) continue;

          const hx = Math.round((offsetX + x) / particleStride) * particleStride;
          const hy = Math.round((offsetY + y) / particleStride) * particleStride;
          nextParticles.push({
            x: hx,
            y: -(Math.random() * canvas.height * 0.6 + 100 * dpr),
            vx: 0,
            vy: 0,
            hx,
            hy,
            delay: ((targetHeight - y) / targetHeight) * 220 + Math.random() * 90,
          });
        }
      }

      particles = nextParticles;
      sceneStartedAt = performance.now();
    };

    const drawFrame = (now: number) => {
      const elapsed = now - sceneStartedAt;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#000000';

      const influenceRadius = 36 * dpr;
      const influenceRadiusSquared = influenceRadius * influenceRadius;
      const pointerForce = 2.6 * dpr;
      const maxVelocity = 28 * dpr;
      const homeForce = 0.02;
      const fallGravity = 2.4 * dpr;

      for (const particle of particles) {
        if (elapsed < particle.delay) continue;

        if (particle.y < particle.hy - 1 && elapsed < particle.delay + 900) {
          particle.vy += fallGravity;
          particle.vx += (particle.hx - particle.x) * homeForce;
          particle.vx *= 0.86;
          particle.x += particle.vx;
          particle.y += particle.vy;

          if (particle.y >= particle.hy) {
            particle.x = particle.hx;
            particle.y = particle.hy;
            particle.vx = 0;
            particle.vy = 0;
          }
        } else {
          const dx = particle.x - pointerX;
          const dy = particle.y - pointerY;
          const distanceSquared = dx * dx + dy * dy;

          if (isPointerActive && distanceSquared < influenceRadiusSquared) {
            const distance = Math.sqrt(distanceSquared) || 0.0001;
            const falloff = 1 - distance / influenceRadius;
            const force = falloff * falloff;
            particle.vx += (dx / distance) * force * pointerForce;
            particle.vy += (dy / distance) * force * pointerForce;
            particle.vx += pointerVelocityX * force * 0.9;
            particle.vy += pointerVelocityY * force * 0.9;
          } else {
            particle.vx += (particle.hx - particle.x) * homeForce;
            particle.vy += (particle.hy - particle.y) * homeForce;
          }

          particle.vx *= 0.86;
          particle.vy *= 0.86;

          const velocity = Math.sqrt(
            particle.vx * particle.vx + particle.vy * particle.vy,
          );
          if (velocity > maxVelocity) {
            particle.vx = (particle.vx / velocity) * maxVelocity;
            particle.vy = (particle.vy / velocity) * maxVelocity;
          }

          particle.x += particle.vx;
          particle.y += particle.vy;
        }

        const pixelX = Math.round(particle.x / dpr) * dpr;
        const pixelY = Math.round(particle.y / dpr) * dpr;
        ctx.fillRect(pixelX, pixelY, particleSize, particleSize);
      }

      pointerVelocityX *= 0.6;
      pointerVelocityY *= 0.6;
      animationRef.current = requestAnimationFrame(drawFrame);
    };

    const resize = debounce(rebuildParticles, 150);

    const pointerPosition = (event: PointerEvent) => {
      const bounds = canvas.getBoundingClientRect();
      return {
        x: (event.clientX - bounds.left) * dpr,
        y: (event.clientY - bounds.top) * dpr,
      };
    };

    const handlePointerDown = (event: PointerEvent) => {
      isPointerActive = true;
      const position = pointerPosition(event);
      pointerX = position.x;
      pointerY = position.y;
      pointerVelocityX = 0;
      pointerVelocityY = 0;
      canvas.setPointerCapture?.(event.pointerId);
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (!isPointerActive) return;
      const position = pointerPosition(event);
      pointerVelocityX += position.x - pointerX;
      pointerVelocityY += position.y - pointerY;
      pointerX = position.x;
      pointerY = position.y;
    };

    const handlePointerUp = () => {
      isPointerActive = false;
      pointerVelocityX = 0;
      pointerVelocityY = 0;
    };

    brandmark.onload = () => {
      if (isDisposed) return;
      rebuildParticles();
    };

    rebuildParticles();
    animationRef.current = requestAnimationFrame(drawFrame);
    window.addEventListener('resize', resize);
    canvas.addEventListener('pointerdown', handlePointerDown);
    canvas.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);

    return () => {
      isDisposed = true;
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
      window.removeEventListener('resize', resize);
      canvas.removeEventListener('pointerdown', handlePointerDown);
      canvas.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-label="Kortix symbol rendered as hard subpixel particles"
      className="block h-full w-full touch-none [image-rendering:pixelated]"
    />
  );
}

function debounce<T extends (...args: never[]) => void>(func: T, wait: number) {
  let timeout: ReturnType<typeof setTimeout>;
  return function executedFunction(...args: Parameters<T>) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  };
}
