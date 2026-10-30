import { artifactCommentMarksSchema } from '@kortix/shared/artifact-comments';
import { expect, test } from 'bun:test';
import {
  addDrawingStroke,
  appendDrawingPoint,
  canAddDrawingStroke,
  drawingViewportRect,
  finishDrawingStroke,
  normalizeDrawing,
} from './artifact-drawing';

test('drawing bounds retain edge strokes inside the visible page and normalize without moving them', () => {
  const stroke = finishDrawingStroke('pen', 'red', [
    { x: 2, y: 3 },
    { x: 90, y: 65 },
  ])!;
  const region = drawingViewportRect([stroke], { width: 200, height: 120 })!;
  expect(region.x).toBeGreaterThanOrEqual(0);
  expect(region.y).toBeGreaterThanOrEqual(0);
  expect(region.x + region.width).toBeLessThanOrEqual(200);
  expect(region.y + region.height).toBeLessThanOrEqual(120);
  const marks = normalizeDrawing([stroke], region);
  expect(artifactCommentMarksSchema.safeParse(marks).success).toBe(true);
  for (let index = 0; index < stroke.points.length; index++) {
    expect(marks[0]!.points[index]!.x * region.width + region.x).toBeCloseTo(
      stroke.points[index]!.x,
      6,
    );
    expect(marks[0]!.points[index]!.y * region.height + region.y).toBeCloseTo(
      stroke.points[index]!.y,
      6,
    );
  }
});

test('click dots work for pen while zero arrows and rectangles are discarded', () => {
  const point = { x: 20, y: 30 };
  expect(finishDrawingStroke('pen', 'black', [point])?.points).toEqual([point, point]);
  expect(finishDrawingStroke('arrow', 'black', [point, point])).toBeNull();
  expect(finishDrawingStroke('rectangle', 'blue', [point, { x: 30, y: 30 }])).toBeNull();
  expect(finishDrawingStroke('arrow', 'blue', [point, { x: 30, y: 30 }])?.points).toHaveLength(2);
});

test('long pen gestures stay bounded while retaining both endpoints', () => {
  let points = [{ x: 0, y: 0 }];
  for (let index = 1; index < 5000; index++)
    points = appendDrawingPoint(points, { x: index, y: index % 20 });
  expect(points.length).toBeLessThanOrEqual(1024);
  expect(points[0]).toEqual({ x: 0, y: 0 });
  expect(points.at(-1)).toEqual({ x: 4999, y: 19 });
  expect(appendDrawingPoint(points, { x: 4999.1, y: 19.1 })).toBe(points);
});

test('stroke and aggregate point limits preserve an API-valid drawing', () => {
  const long = finishDrawingStroke(
    'pen',
    'black',
    Array.from({ length: 1024 }, (_, i) => ({ x: i / 10, y: i % 50 })),
  )!;
  let strokes = [] as NonNullable<ReturnType<typeof finishDrawingStroke>>[];
  for (let index = 0; index < 100; index++) strokes = addDrawingStroke(strokes, long);
  expect(strokes.length).toBeLessThanOrEqual(64);
  expect(strokes.reduce((total, stroke) => total + stroke.points.length, 0)).toBeLessThanOrEqual(
    8192,
  );
  const region = drawingViewportRect(strokes, { width: 300, height: 100 })!;
  expect(artifactCommentMarksSchema.safeParse(normalizeDrawing(strokes, region)).success).toBe(
    true,
  );
});

test('empty or invalid viewports cannot produce an anchor region', () => {
  expect(drawingViewportRect([], { width: 300, height: 200 })).toBeNull();
  const stroke = finishDrawingStroke('rectangle', 'red', [
    { x: 1, y: 1 },
    { x: 20, y: 20 },
  ])!;
  expect(drawingViewportRect([stroke], { width: 0, height: 200 })).toBeNull();
  expect(drawingViewportRect([stroke], { width: Number.NaN, height: 200 })).toBeNull();
});

test('an 8191-point drawing reports full capacity before another stroke can be silently lost', () => {
  const strokes = Array.from({ length: 8 }, (_, index) => ({
    tool: 'pen' as const,
    color: 'black' as const,
    width: 2,
    points: Array.from({ length: index === 7 ? 1023 : 1024 }, (_, point) => ({
      x: point,
      y: index,
    })),
  }));
  const extra = finishDrawingStroke('pen', 'red', [
    { x: 1, y: 1 },
    { x: 2, y: 2 },
  ])!;
  expect(canAddDrawingStroke(strokes)).toBe(false);
  expect(addDrawingStroke(strokes, extra)).toBe(strokes);
  expect(canAddDrawingStroke(strokes.slice(0, -1))).toBe(true);
});
