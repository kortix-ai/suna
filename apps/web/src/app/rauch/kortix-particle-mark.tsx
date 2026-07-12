'use client';

import { useEffect, useRef } from 'react';
import {
  advanceParticle,
  BRANDMARK_SRC,
  buildBrandmarkParticles,
  getParticleMarkSize,
  type Particle,
} from './particle-mark';

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

      const { width: targetWidth, height: targetHeight } = getParticleMarkSize({
        sourceWidth: brandmark.naturalWidth,
        sourceHeight: brandmark.naturalHeight,
        viewportWidth,
        viewportHeight,
        dpr,
      });

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
      particles = buildBrandmarkParticles({
        targetWidth,
        targetHeight,
        particleStride,
        offsetX,
        offsetY,
        canvasHeight: canvas.height,
        dpr,
        alphaAt: (x, y) => imageData.data[(y * targetWidth + x) * 4 + 3],
      });
      sceneStartedAt = performance.now();
    };

    const drawFrame = (now: number) => {
      const elapsed = now - sceneStartedAt;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#000000';

      for (const particle of particles) {
        if (elapsed < particle.delay) continue;
        advanceParticle(particle, {
          elapsed,
          dpr,
          isPointerActive,
          pointerX,
          pointerY,
          pointerVelocityX,
          pointerVelocityY,
        });

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
