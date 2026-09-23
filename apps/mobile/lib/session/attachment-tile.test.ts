import { describe, expect, test } from 'bun:test';

import {
  ATTACHMENT_TILE_CAP,
  LONG_NAME_THRESHOLD,
  NAME_TAIL_CHARS,
  attachmentExtension,
  isPreviewableImage,
  planAttachmentGrid,
  resolveAttachmentSource,
  splitFilenameForTile,
} from './attachment-tile';

describe('attachmentExtension', () => {
  test('reads the extension from the name, lowercase', () => {
    expect(attachmentExtension('Report.PDF')).toBe('pdf');
  });

  test('falls back to the MIME subtype', () => {
    expect(attachmentExtension('noext', 'image/svg+xml')).toBe('svg');
    expect(attachmentExtension('noext', 'image/x-icon')).toBe('icon');
    // Same output as web's implementation (its comment says `excel`; the code yields `ms-excel`).
    expect(attachmentExtension('noext', 'application/vnd.ms-excel')).toBe('ms-excel');
  });

  test('is empty when neither says anything', () => {
    expect(attachmentExtension('noext')).toBe('');
    expect(attachmentExtension('.env')).toBe('');
  });

  test('rejects an "extension" longer than 8 characters', () => {
    expect(attachmentExtension('a.verylongext', 'text/plain')).toBe('plain');
  });
});

describe('isPreviewableImage', () => {
  test('raster image MIME types are previewable', () => {
    expect(isPreviewableImage('a.png', 'image/png')).toBe(true);
    expect(isPreviewableImage('a.jpg', 'image/jpeg')).toBe(true);
  });

  test('SVG is never previewable', () => {
    expect(isPreviewableImage('logo.svg', 'image/svg+xml')).toBe(false);
  });

  test('non-image MIME types are not previewable', () => {
    expect(isPreviewableImage('a.pdf', 'application/pdf')).toBe(false);
    expect(isPreviewableImage('a.png')).toBe(false);
  });
});

describe('splitFilenameForTile', () => {
  test('the thresholds match web', () => {
    expect(LONG_NAME_THRESHOLD).toBe(24);
    expect(NAME_TAIL_CHARS).toBe(10);
  });

  test('a name of 24 characters or fewer is not split', () => {
    expect(splitFilenameForTile('a'.repeat(24))).toBeNull();
  });

  test('a longer name splits into head and the last 10 characters', () => {
    const name = 'design-review-notes-chatux.md';
    expect(splitFilenameForTile(name)).toEqual({
      head: 'design-review-notes',
      tail: '-chatux.md',
    });
  });
});

describe('planAttachmentGrid', () => {
  const items = (n: number) => Array.from({ length: n }, (_, i) => `f${i}`);

  test('the cap is 8', () => {
    expect(ATTACHMENT_TILE_CAP).toBe(8);
  });

  test('up to the cap every attachment is visible', () => {
    expect(planAttachmentGrid(items(8), false)).toEqual({ visible: items(8), overflowCount: 0 });
  });

  test('past the cap, 7 tiles show and the 8th slot counts every hidden attachment', () => {
    const plan = planAttachmentGrid(items(15), false);
    expect(plan.visible).toEqual(items(7));
    expect(plan.overflowCount).toBe(8);
    expect(plan.visible.length + plan.overflowCount).toBe(15);
  });

  test('9 attachments show 7 tiles and "+2"', () => {
    expect(planAttachmentGrid(items(9), false).overflowCount).toBe(2);
  });

  test('expanded shows everything', () => {
    expect(planAttachmentGrid(items(15), true)).toEqual({ visible: items(15), overflowCount: 0 });
  });
});

describe('resolveAttachmentSource', () => {
  test('data, http and https URLs load directly', () => {
    expect(resolveAttachmentSource('data:image/png;base64,AAA')).toEqual({ uri: 'data:image/png;base64,AAA' });
    expect(resolveAttachmentSource('https://x/y.png')).toEqual({ uri: 'https://x/y.png' });
  });

  test('file:// URLs and bare paths load from the sandbox', () => {
    expect(resolveAttachmentSource('file:///workspace/uploads/a.png')).toEqual({ path: '/workspace/uploads/a.png' });
    expect(resolveAttachmentSource('/workspace/uploads/a.png')).toEqual({ path: '/workspace/uploads/a.png' });
  });

  test('empty is null', () => {
    expect(resolveAttachmentSource('')).toBeNull();
    expect(resolveAttachmentSource(undefined)).toBeNull();
  });
});
