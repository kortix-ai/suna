import { describe, expect, test } from 'bun:test';
import { GLIDE_MAX_MS, GLIDE_MIN_MS, clampPoint, glideMs, glidePoint, inside, typingPoint } from './cursor-path';

const o = { x: 0, y: 0 };

describe('agent cursor glide', () => {
  test('a longer trip takes longer, between the shortest and the longest glide', () => {
    expect(glideMs(o, { x: 1, y: 2 })).toBe(0); // a re-sent point or a drag step: jump
    const near = glideMs(o, { x: 40, y: 0 }), far = glideMs(o, { x: 800, y: 0 });
    expect(near).toBeGreaterThanOrEqual(GLIDE_MIN_MS);
    expect(far).toBeGreaterThan(near);
    expect(glideMs(o, { x: 5000, y: 5000 })).toBe(GLIDE_MAX_MS);
  });

  test('the path starts and ends on the points and bows to one side in between', () => {
    const to = { x: 400, y: 0 };
    expect(glidePoint(o, to, 0)).toEqual(o);
    expect(glidePoint(o, to, 1)).toEqual(to);
    const mid = glidePoint(o, to, 0.5);
    expect(mid.x).toBeCloseTo(200, 5);
    expect(mid.y).toBeLessThan(-10); // a shallow arc, not a straight line
    expect(mid.y).toBeGreaterThan(-40);
    // Eased: slow out of the start, so the first 10% of the time covers less than 10% of the way.
    expect(glidePoint(o, to, 0.1).x).toBeLessThan(40);
    expect(glidePoint(o, to, 2)).toEqual(to); // progress past the end stays at the end
  });

  test('the drawn cursor stays on screen when a client clicks outside the viewport', () => {
    expect(clampPoint({ x: 260, y: -2078 }, 1280, 720)).toEqual({ x: 260, y: 0 });
    expect(clampPoint({ x: 2000, y: 900 }, 1280, 720)).toEqual({ x: 1279, y: 719 });
  });
});

describe('agent cursor at a text field', () => {
  const box = { left: 100, top: 200, width: 300, height: 36 };
  test('rests inside the field, near the start of the text', () => {
    expect(typingPoint(box, 1280, 720)).toEqual({ x: 116, y: 218 });
    expect(typingPoint({ ...box, height: 400 }, 1280, 720)).toEqual({ x: 116, y: 218 }); // a tall textarea: its first line
  });
  test('no point for a field that is off screen or has no size', () => {
    expect(typingPoint({ ...box, top: -100, height: 36 }, 1280, 720)).toBeUndefined();
    expect(typingPoint({ ...box, top: 800 }, 1280, 720)).toBeUndefined();
    expect(typingPoint({ ...box, width: 0 }, 1280, 720)).toBeUndefined();
  });
  test('inside: the cursor already on the field does not move', () => {
    expect(inside({ x: 120, y: 210 }, box)).toBe(true);
    expect(inside({ x: 98, y: 238 }, box)).toBe(true); // within the 4 px margin
    expect(inside({ x: 50, y: 210 }, box)).toBe(false);
  });
});
