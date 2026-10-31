import { expect, test } from 'bun:test';
import { artifactCommentMarksSchema, type ArtifactCommentMark } from './artifact-comments';

const pen: ArtifactCommentMark = { tool: 'pen', color: 'red', width: 0.006, points: [{ x: 0.1, y: 0.2 }, { x: 0.4, y: 0.6 }] };

test('marks retain normalized pen, arrow, and rectangle geometry in the three accepted colors', () => {
  const marks: ArtifactCommentMark[] = [pen, { ...pen, tool: 'arrow', color: 'black' }, { ...pen, tool: 'rectangle', color: 'blue' }];
  expect(artifactCommentMarksSchema.parse(marks)).toEqual(marks);
  expect(artifactCommentMarksSchema.parse([])).toEqual([]);
});

test('marks reject unknown tools, colors, fields, and unbounded stroke widths', () => {
  for (const change of [{ tool: 'circle' }, { color: '#fff' }, { color: 'green' }, { width: 0 }, { width: 0.051 }, { width: NaN }, { opacity: 1 }]) {
    expect(artifactCommentMarksSchema.safeParse([{ ...pen, ...change }]).success).toBe(false);
  }
});

test('marks reject nonfinite and out-of-region points', () => {
  for (const point of [{ x: -0.001, y: 0 }, { x: 0, y: 1.001 }, { x: Infinity, y: 0 }, { x: 0, y: NaN }, { x: 0, y: 0, z: 1 }]) {
    expect(artifactCommentMarksSchema.safeParse([{ ...pen, points: [point, { x: 1, y: 1 }] }]).success).toBe(false);
  }
});

test('arrows and rectangles require exactly two different endpoints', () => {
  for (const tool of ['arrow', 'rectangle']) {
    for (const points of [[], [pen.points[0]], [...pen.points, pen.points[0]], [pen.points[0], pen.points[0]]]) {
      expect(artifactCommentMarksSchema.safeParse([{ ...pen, tool, points }]).success).toBe(false);
    }
  }
});

test('mark count, per-stroke points, and aggregate points are bounded', () => {
  expect(artifactCommentMarksSchema.safeParse(Array.from({ length: 64 }, () => pen)).success).toBe(true);
  expect(artifactCommentMarksSchema.safeParse(Array.from({ length: 65 }, () => pen)).success).toBe(false);
  const full = { ...pen, points: Array.from({ length: 1024 }, (_, index) => ({ x: index / 1024, y: 0.5 })) };
  expect(artifactCommentMarksSchema.safeParse(Array.from({ length: 8 }, () => full)).success).toBe(true);
  expect(artifactCommentMarksSchema.safeParse(Array.from({ length: 9 }, () => full)).success).toBe(false);
  expect(artifactCommentMarksSchema.safeParse([{ ...full, points: [...full.points, { x: 1, y: 1 }] }]).success).toBe(false);
  expect(artifactCommentMarksSchema.safeParse([{ ...pen, points: [pen.points[0]] }]).success).toBe(false);
});
