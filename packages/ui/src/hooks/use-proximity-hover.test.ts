import { describe, expect, test } from 'bun:test';
import { pickNearestItem, type ItemRect } from './use-proximity-hover';

const rects: ItemRect[] = [
  { left: 0, top: 0, width: 20, height: 20 },
  { left: 40, top: 40, width: 20, height: 20 },
];
const container = {
  scrollLeft: 0, scrollTop: 0, clientLeft: 0, clientTop: 0,
  offsetWidth: 100, offsetHeight: 100,
} as HTMLElement;
const bounds = { left: 0, top: 0, width: 100, height: 100 } as DOMRect;

describe('proximity pick (characterization)', () => {
  for (const axis of ['x', 'y', 'xy'] as const) {
    test(`${axis}: containment wins over a nearer center`, () => {
      expect(pickNearestItem(rects, axis, { x: 20, y: 20 }, container, bounds)).toBe(0);
    });
    test(`${axis}: nearest center without containment`, () => {
      expect(pickNearestItem(rects, axis, { x: 35, y: 35 }, container, bounds)).toBe(1);
    });
  }
  test('scroll and scale project layout coordinates to viewport', () => {
    expect(pickNearestItem(rects, 'xy', { x: 90, y: 90 },
      { ...container, scrollLeft: 10, scrollTop: 10 } as HTMLElement,
      { ...bounds, left: 10, top: 10, width: 200, height: 200 } as DOMRect)).toBe(1);
  });
  test('empty and sparse rects return null', () => {
    expect(pickNearestItem([], 'xy', { x: 0, y: 0 }, container, bounds)).toBeNull();
    expect(pickNearestItem(new Array(2), 'x', { x: 0, y: 0 }, container, bounds)).toBeNull();
  });
});
