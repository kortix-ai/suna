import type { ArtifactCommentAnchor } from '@kortix/sdk';
import { expect, test } from 'bun:test';
import { prepareDrawingDraft } from './artifact-drawing-draft';
const anchor: ArtifactCommentAnchor = {
  type: 'region',
  version: 'commit',
  selector: 'body',
  snippet: '',
  viewport_width: 200,
  scroll: { x: 0, y: 100 },
  offset: { x: 0, y: 0, width: 1, height: 1 },
};
const strokes = [
  {
    tool: 'pen' as const,
    color: 'red' as const,
    width: 2,
    points: [
      { x: 20, y: 30 },
      { x: 40, y: 50 },
    ],
  },
];
test('a failed frame capture preserves the trusted anchor and normalized marks without an image', async () => {
  const result = await prepareDrawingDraft(
    strokes,
    { width: 200, height: 120, scroll: { x: 0, y: 100 } },
    {
      regionForViewportRect: () => ({
        anchor,
        documentRect: { x: 0, y: 100, width: 100, height: 100 },
      }),
      capture: async () => ({ ok: false, reason: 'tainted' }),
    },
  );
  expect(result?.anchor).toBe(anchor);
  expect(result?.marks[0]?.points).toEqual([
    { x: 0.2, y: 0.3 },
    { x: 0.4, y: 0.5 },
  ]);
  expect(result?.image).toBeUndefined();
  expect(result?.imageFailed).toBe(true);
});
test('a changed page rejects an untrusted region before requesting image bytes', async () => {
  let captures = 0;
  expect(
    await prepareDrawingDraft(
      strokes,
      { width: 200, height: 120, scroll: { x: 0, y: 0 } },
      {
        regionForViewportRect: () => null,
        capture: async () => {
          captures++;
          return { ok: false, reason: 'unavailable' };
        },
      },
    ),
  ).toBeNull();
  expect(captures).toBe(0);
});
