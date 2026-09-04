import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { getFileCategory } from '@/features/file-viewer';

/**
 * A thumbnail sizes itself from what the renderer will actually PRODUCE, not
 * from the file extension.
 *
 * An SVG is an `image` by extension but arrives as text, so
 * `FileContentRenderer` draws its source — `imageDataUrl` only forms for
 * base64 bytes with an `image/*` mime. The picture branch deliberately skips
 * the thumbnail scale, because a picture fills its box on its own. An SVG
 * therefore took the picture sizing and rendered `<svg xmlns="…" width="1600"`
 * at full size inside a 120px card, while every other source file was a legible
 * scaled preview.
 */

const source = readFileSync(
  fileURLToPath(new URL('./file-thumbnail.tsx', import.meta.url)),
  'utf8',
);

describe('thumbnail sizing', () => {
  test('svg is still an image by category — that is why it needs the carve-out', () => {
    expect(getFileCategory('brand.svg')).toBe('image');
    expect(getFileCategory('brand.png')).toBe('image');
  });

  test('but svg is not sized as a picture', () => {
    const predicate = /const rendersAsPicture = ([^;]+);/.exec(source)?.[1] ?? '';

    expect(predicate).toContain("getFileCategory(fileName) === 'image'");
    expect(predicate).toContain("!== 'svg'");
  });

  test('the picture branch is the one that skips the scale', () => {
    // Pins the pairing: only `rendersAsPicture` may take the unscaled
    // width/height sizing, so a file rendered as source always gets the scale.
    expect(source).toContain('rendersAsPicture\n            ? { width: \'100%\', height: \'100%\' }');
    expect(source).toContain(`transform: \`scale(\${THUMB_SCALE})\``);
  });
});
