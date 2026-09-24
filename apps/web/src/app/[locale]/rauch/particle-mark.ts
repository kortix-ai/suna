export type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  hx: number;
  hy: number;
  delay: number;
};

export type ParticleMarkSize = {
  width: number;
  height: number;
};

export const BRANDMARK_SRC = '/brandkit/Logo/Brandmark/SVG/Brandmark Black.svg';

export function getParticleMarkSize({
  sourceWidth,
  sourceHeight,
  viewportWidth,
  viewportHeight,
  dpr,
}: {
  sourceWidth: number;
  sourceHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  dpr: number;
}): ParticleMarkSize {
  const aspectRatio = sourceWidth / sourceHeight;
  const targetWidthCss = Math.max(
    132,
    Math.min(244, viewportWidth * 0.54, viewportHeight * 0.7 * aspectRatio),
  );
  const width = Math.round(targetWidthCss * dpr);

  return {
    width,
    height: Math.round(width / aspectRatio),
  };
}

export function buildBrandmarkParticles({
  targetWidth,
  targetHeight,
  particleStride,
  offsetX,
  offsetY,
  canvasHeight,
  dpr,
  alphaAt,
  random = Math.random,
}: {
  targetWidth: number;
  targetHeight: number;
  particleStride: number;
  offsetX: number;
  offsetY: number;
  canvasHeight: number;
  dpr: number;
  alphaAt: (x: number, y: number) => number;
  random?: () => number;
}): Particle[] {
  const particles: Particle[] = [];

  for (let y = 0; y < targetHeight; y += particleStride) {
    for (let x = 0; x < targetWidth; x += particleStride) {
      if (alphaAt(x, y) <= 32) continue;

      const hx = Math.round((offsetX + x) / particleStride) * particleStride;
      const hy = Math.round((offsetY + y) / particleStride) * particleStride;
      particles.push({
        x: hx,
        y: -(random() * canvasHeight * 0.6 + 100 * dpr),
        vx: 0,
        vy: 0,
        hx,
        hy,
        delay: ((targetHeight - y) / targetHeight) * 220 + random() * 90,
      });
    }
  }

  return particles;
}

export function advanceParticle(
  particle: Particle,
  {
    elapsed,
    dpr,
    isPointerActive,
    pointerX,
    pointerY,
    pointerVelocityX,
    pointerVelocityY,
  }: {
    elapsed: number;
    dpr: number;
    isPointerActive: boolean;
    pointerX: number;
    pointerY: number;
    pointerVelocityX: number;
    pointerVelocityY: number;
  },
) {
  const influenceRadius = 36 * dpr;
  const influenceRadiusSquared = influenceRadius * influenceRadius;
  const pointerForce = 2.6 * dpr;
  const maxVelocity = 28 * dpr;
  const homeForce = 0.02;
  const fallGravity = 2.4 * dpr;

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
    return;
  }

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

  const velocity = Math.sqrt(particle.vx * particle.vx + particle.vy * particle.vy);
  if (velocity > maxVelocity) {
    particle.vx = (particle.vx / velocity) * maxVelocity;
    particle.vy = (particle.vy / velocity) * maxVelocity;
  }

  particle.x += particle.vx;
  particle.y += particle.vy;
}
