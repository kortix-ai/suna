import { describe, expect, test } from 'bun:test';

import {
  ATTACHMENT_TILE_CAP,
  planAttachmentGrid,
  type NormalizedAttachment,
} from './user-message';

// One shape, one cap, one overflow tile.
//
// This replaces the old `imagesRenderAsTiles` rule, whose "a file in the message
// pulls images back to rows" branch turned a 15-attachment message into 15
// filename-width rows right-aligned into a ~700px staircase.
//
// Everything is now the same square tile on a shared 4-column track: an image
// shows its picture, anything else shows an icon with the name at the bottom.
// Because the two kinds are the same shape, there is nothing left to decide —
// no rows-vs-tiles mode, no per-kind caps, no reflow. `planAttachmentGrid` only
// answers "how many fit before we collapse".

const tile = (name: string, mime: string, src?: string): NormalizedAttachment => ({
  key: `k-${name}`,
  filename: name,
  mime,
  src,
  path: src,
});

const image = (name: string) => tile(name, 'image/png', `/workspace/uploads/${name}`);
const file = (name: string) => tile(name, 'application/pdf', `/workspace/uploads/${name}`);
const many = (n: number, make: (name: string) => NormalizedAttachment, prefix: string) =>
  Array.from({ length: n }, (_, i) => make(`${prefix}${i}.x`));

describe('planAttachmentGrid', () => {
  test('a handful of attachments is shown whole, with nothing hidden', () => {
    const plan = planAttachmentGrid([image('a.png'), file('b.pdf'), image('c.png')], false);

    expect(plan.visible).toHaveLength(3);
    expect(plan.hidden).toBe(0);
  });

  test('attachment order is preserved — images and files are the same shape now', () => {
    // Nothing gets grouped or reordered. A square is a square, so the grid can
    // simply lay them out in the order the user attached them.
    const plan = planAttachmentGrid([file('doc.pdf'), image('shot.png'), file('two.pdf')], false);

    expect(plan.visible.map((a) => a.filename)).toEqual(['doc.pdf', 'shot.png', 'two.pdf']);
  });

  test('past the cap, the remainder is reported instead of more tiles', () => {
    const plan = planAttachmentGrid(many(15, image, 'img'), false);

    expect(plan.visible).toHaveLength(ATTACHMENT_TILE_CAP);
    expect(plan.hidden).toBe(15 - ATTACHMENT_TILE_CAP);
  });

  test('the reported message — 11 images + 4 files — collapses to two rows', () => {
    const plan = planAttachmentGrid([...many(11, image, 'img'), ...many(4, file, 'doc')], false);

    expect(plan.visible).toHaveLength(ATTACHMENT_TILE_CAP);
    expect(plan.hidden).toBe(15 - ATTACHMENT_TILE_CAP);
  });

  test('exactly at the cap nothing is hidden — no "+0" tile', () => {
    const plan = planAttachmentGrid(many(ATTACHMENT_TILE_CAP, image, 'img'), false);

    expect(plan.visible).toHaveLength(ATTACHMENT_TILE_CAP);
    expect(plan.hidden).toBe(0);
  });

  test('expanding shows everything', () => {
    const plan = planAttachmentGrid(many(15, image, 'img'), true);

    expect(plan.visible).toHaveLength(15);
    expect(plan.hidden).toBe(0);
  });

  test('nothing attached produces an empty list, not undefined', () => {
    const plan = planAttachmentGrid([], false);

    expect(plan.visible).toEqual([]);
    expect(plan.hidden).toBe(0);
  });

  test('the cap is whole rows of four, so the block is always a rectangle', () => {
    // A cap that leaves a half-filled tail trades one ragged shape for another.
    expect(ATTACHMENT_TILE_CAP % 4).toBe(0);
  });
});
