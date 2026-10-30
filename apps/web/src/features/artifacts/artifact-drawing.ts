import type { ArtifactCommentMark } from '@kortix/sdk';

export type DrawingPoint = { x: number; y: number };
export type DrawingRect = DrawingPoint & { width: number; height: number };
export type DrawingStroke = {
  tool: ArtifactCommentMark['tool'];
  color: ArtifactCommentMark['color'];
  points: DrawingPoint[];
  width: number;
};
const MAX_POINTS = 1024;
const MAX_TOTAL_POINTS = 8192;
const MAX_STROKES = 64;
const validPoint = (point: DrawingPoint) => Number.isFinite(point.x) && Number.isFinite(point.y);
const fraction = (value: number) => Math.max(0, Math.min(1, value));

function sample(points: DrawingPoint[], count: number): DrawingPoint[] {
  if (points.length <= count) return points;
  return Array.from(
    { length: count },
    (_, index) => points[Math.round((index * (points.length - 1)) / (count - 1))]!,
  );
}

export function appendDrawingPoint(points: DrawingPoint[], next: DrawingPoint): DrawingPoint[] {
  if (!validPoint(next)) return points;
  const last = points.at(-1);
  if (last && Math.hypot(next.x - last.x, next.y - last.y) < 0.75) return points;
  const compact = points.length >= MAX_POINTS ? sample(points, MAX_POINTS / 2) : points;
  return [...compact, next];
}

export function finishDrawingStroke(
  tool: DrawingStroke['tool'],
  color: DrawingStroke['color'],
  points: DrawingPoint[],
): DrawingStroke | null {
  if (!points.length || !points.every(validPoint)) return null;
  const first = points[0]!;
  const last = points.at(-1)!;
  if (tool === 'arrow' && first.x === last.x && first.y === last.y) return null;
  if (tool === 'rectangle' && (first.x === last.x || first.y === last.y)) return null;
  const bounded =
    tool === 'pen'
      ? sample(points.length === 1 ? [first, first] : points, MAX_POINTS)
      : [first, last];
  return { tool, color, points: bounded, width: 2 };
}

export function canAddDrawingStroke(strokes: readonly DrawingStroke[]): boolean {
  return (
    strokes.length < MAX_STROKES &&
    strokes.reduce((total, item) => total + item.points.length, 0) <= MAX_TOTAL_POINTS - 2
  );
}

export function addDrawingStroke(strokes: DrawingStroke[], stroke: DrawingStroke): DrawingStroke[] {
  const remaining =
    MAX_TOTAL_POINTS - strokes.reduce((total, item) => total + item.points.length, 0);
  if (!canAddDrawingStroke(strokes)) return strokes;
  return [
    ...strokes,
    { ...stroke, points: sample(stroke.points, Math.min(MAX_POINTS, remaining)) },
  ];
}

export function drawingViewportRect(
  strokes: DrawingStroke[],
  viewport: { width: number; height: number },
): DrawingRect | null {
  if (
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    viewport.width <= 0 ||
    viewport.height <= 0
  )
    return null;
  const points = strokes.flatMap((stroke) => stroke.points);
  if (
    !points.length ||
    points.some(
      (point) =>
        !validPoint(point) ||
        point.x < 0 ||
        point.y < 0 ||
        point.x > viewport.width ||
        point.y > viewport.height,
    )
  )
    return null;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const bounds = (min: number, max: number, size: number) => {
    const length = Math.min(size, Math.max(64, max - min + 48));
    const start = Math.max(0, Math.min(size - length, (min + max - length) / 2));
    return { start, length };
  };
  const x = bounds(Math.min(...xs), Math.max(...xs), viewport.width);
  const y = bounds(Math.min(...ys), Math.max(...ys), viewport.height);
  return { x: x.start, y: y.start, width: x.length, height: y.length };
}

const normalizedWidth = (width: number, regionWidth: number) =>
  Math.max(0.001, Math.min(0.05, width / regionWidth));
export const drawingStrokeWidth = (width: number, regionWidth: number) =>
  normalizedWidth(width, regionWidth) * regionWidth;

export function normalizeDrawing(
  strokes: DrawingStroke[],
  region: DrawingRect,
): ArtifactCommentMark[] {
  return strokes.map((stroke) => ({
    tool: stroke.tool,
    color: stroke.color,
    width: normalizedWidth(stroke.width, region.width),
    points: stroke.points.map((point) => ({
      x: fraction((point.x - region.x) / region.width),
      y: fraction((point.y - region.y) / region.height),
    })),
  }));
}

export function projectDrawingMark(mark: ArtifactCommentMark, rect: DrawingRect) {
  const points = mark.points.map((point) => ({
    x: rect.x + point.x * rect.width,
    y: rect.y + point.y * rect.height,
  }));
  const width = mark.width * rect.width;
  const first = points[0]!;
  const last = points.at(-1)!;
  const angle = Math.atan2(last.y - first.y, last.x - first.x);
  const head = Math.min(width * 4, Math.hypot(last.x - first.x, last.y - first.y) / 3);
  return {
    points,
    width,
    arrow: [
      {
        x: last.x - head * Math.cos(angle - Math.PI / 6),
        y: last.y - head * Math.sin(angle - Math.PI / 6),
      },
      last,
      {
        x: last.x - head * Math.cos(angle + Math.PI / 6),
        y: last.y - head * Math.sin(angle + Math.PI / 6),
      },
    ],
    rectangle: {
      x: Math.min(first.x, last.x),
      y: Math.min(first.y, last.y),
      width: Math.abs(last.x - first.x),
      height: Math.abs(last.y - first.y),
    },
  };
}
