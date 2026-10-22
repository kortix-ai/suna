import { expect, test } from 'bun:test';
import { zoomAtPoint } from './mermaid-render';

test('wheel and pinch factors preserve the canvas anchor and zoom limits', () => {
  for (const factor of [0.9, 1.1, 0.01, 100, 1, 2]) {
    const next = zoomAtPoint(1, { x: 20, y: -30 }, { x: 120, y: 70 }, factor);
    expect(next.zoom).toBe(Math.max(0.1, Math.min(5, factor)));
    expect((120 - next.panOffset.x) / next.zoom).toBeCloseTo(100);
    expect((70 - next.panOffset.y) / next.zoom).toBeCloseTo(100);
  }
  expect(zoomAtPoint(2, { x: 5, y: 10 }, { x: 5, y: 10 }, 0.5))
    .toEqual({ zoom: 1, panOffset: { x: 5, y: 10 } });
});
