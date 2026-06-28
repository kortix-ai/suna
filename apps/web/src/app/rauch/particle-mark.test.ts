import { describe, expect, test } from 'bun:test';

import {
  advanceParticle,
  buildBrandmarkParticles,
  getParticleMarkSize,
  type Particle,
} from './particle-mark';

describe('getParticleMarkSize', () => {
  test('keeps the Kortix brandmark aspect ratio at desktop scale', () => {
    expect(
      getParticleMarkSize({
        sourceWidth: 164,
        sourceHeight: 140,
        viewportWidth: 1280,
        viewportHeight: 720,
        dpr: 1,
      }),
    ).toEqual({ width: 244, height: 208 });
  });

  test('scales by device pixel ratio without changing css geometry', () => {
    expect(
      getParticleMarkSize({
        sourceWidth: 164,
        sourceHeight: 140,
        viewportWidth: 375,
        viewportHeight: 812,
        dpr: 2,
      }),
    ).toEqual({ width: 405, height: 346 });
  });
});

describe('buildBrandmarkParticles', () => {
  test('samples only opaque mask cells into hard-pixel home positions', () => {
    const particles = buildBrandmarkParticles({
      targetWidth: 6,
      targetHeight: 6,
      particleStride: 2,
      offsetX: 10,
      offsetY: 20,
      canvasHeight: 100,
      dpr: 1,
      random: () => 0,
      alphaAt: (x, y) => (x === y ? 255 : 0),
    });

    expect(particles).toHaveLength(3);
    expect(particles.map(({ hx, hy }) => ({ hx, hy }))).toEqual([
      { hx: 10, hy: 20 },
      { hx: 12, hy: 22 },
      { hx: 14, hy: 24 },
    ]);
    expect(particles.every((particle) => particle.x === particle.hx)).toBe(true);
    expect(particles.every((particle) => particle.y === -100)).toBe(true);
  });

  test('stages lower particles first like the Rauch reference', () => {
    const particles = buildBrandmarkParticles({
      targetWidth: 2,
      targetHeight: 6,
      particleStride: 2,
      offsetX: 0,
      offsetY: 0,
      canvasHeight: 100,
      dpr: 1,
      random: () => 0,
      alphaAt: () => 255,
    });

    const delays = particles.map((particle) => particle.delay);
    expect(delays[0]).toBe(220);
    expect(delays[1]).toBeCloseTo(440 / 3);
    expect(delays[2]).toBeCloseTo(220 / 3);
  });
});

describe('advanceParticle', () => {
  test('lands falling particles exactly on their home cell', () => {
    const particle: Particle = {
      x: 20,
      y: 18,
      vx: 0,
      vy: 8,
      hx: 20,
      hy: 20,
      delay: 0,
    };

    advanceParticle(particle, {
      elapsed: 10,
      dpr: 1,
      isPointerActive: false,
      pointerX: 0,
      pointerY: 0,
      pointerVelocityX: 0,
      pointerVelocityY: 0,
    });

    expect(particle).toMatchObject({ x: 20, y: 20, vx: 0, vy: 0 });
  });

  test('pushes settled particles away from an active pointer', () => {
    const particle: Particle = {
      x: 30,
      y: 20,
      vx: 0,
      vy: 0,
      hx: 30,
      hy: 20,
      delay: 0,
    };

    advanceParticle(particle, {
      elapsed: 1000,
      dpr: 1,
      isPointerActive: true,
      pointerX: 20,
      pointerY: 20,
      pointerVelocityX: 4,
      pointerVelocityY: 0,
    });

    expect(particle.x).toBeGreaterThan(30);
    expect(particle.vx).toBeGreaterThan(0);
  });
});
