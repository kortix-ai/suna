import { describe, expect, test } from 'bun:test';
import { sandboxMediaPath, withoutEdgeQuotes, withoutTrailingSlashes } from './media-path';
import { chooser, within } from './testing';

// The image and video renderers' regexes (web image-output-path.ts, mobile
// web-media.ts), kept ONLY as parity oracles. ROOTS is the SDK's SANDBOX_FS_ROOTS.
const ROOTS = ['/workspace', '/tmp', '/home', '/opt'] as const;
const IMAGE_RE = new RegExp(
  `(?:${ROOTS.join('|')})/[^\\s"']+\\.(?:png|jpe?g|gif|webp|svg|bmp|ico)`,
  'i',
);
const VIDEO_RE = new RegExp(
  `(?:${ROOTS.join('|')})/[^\\s"']+\\.(?:mp4|webm|mov|avi|mkv|m4v|ogv)`,
  'i',
);

/** Runs `check` on 3000 texts from `make` and proves at least 600 of them matched. */
function fuzz(
  seed: number,
  make: (c: ReturnType<typeof chooser>) => string,
  check: (text: string) => boolean,
) {
  const c = chooser(seed);
  let matched = 0;
  for (let i = 0; i < 3000; i++) if (check(make(c))) matched++;
  expect(matched).toBeGreaterThan(600);
}

describe('the media path readers return what their regexes returned', () => {
  test('withoutEdgeQuotes', () =>
    fuzz(
      131,
      (c) => c.some(['"', "'", 'a', ' ', '/x.png', '"a"', "''"], 6),
      (text) => {
        const expected = text.replace(/^["']+|["']+$/g, '');
        expect(withoutEdgeQuotes(text)).toBe(expected);
        return expected !== text;
      },
    ));

  test('sandboxMediaPath for images and videos', () =>
    fuzz(
      132,
      (c) =>
        c.some(
          [
            '/workspace',
            '/tmp',
            '/HOME',
            '/opt',
            '/',
            'a',
            '.png',
            '.PNG',
            '.jpeg',
            '.jpg',
            '.mp4',
            '.mov',
            '.',
            ' ',
            '"',
            "'",
            'x',
            '\n',
            'png',
            '/tmp/a.png',
          ],
          8,
        ),
      (text) => {
        const image = text.match(IMAGE_RE)?.[0] ?? null;
        const video = text.match(VIDEO_RE)?.[0] ?? null;
        expect(sandboxMediaPath(text, ROOTS, 'image')).toBe(image);
        expect(sandboxMediaPath(text, ROOTS, 'video')).toBe(video);
        return image !== null || video !== null;
      },
    ));

  test('withoutTrailingSlashes', () =>
    fuzz(
      133,
      (c) => c.some(['/', '//', 'a', 'b/', '\\', ' ', '.', '/x'], 6),
      (text) => {
        const expected = text.replace(/\/+$/, '');
        expect(withoutTrailingSlashes(text)).toBe(expected);
        return expected !== text;
      },
    ));

  test('reads a real path out of prose', () => {
    expect(sandboxMediaPath('Saved the image to /workspace/out/cat.png.', ROOTS, 'image')).toBe(
      '/workspace/out/cat.png',
    );
    expect(sandboxMediaPath('see /tmp/a.png/b.jpg now', ROOTS, 'image')).toBe('/tmp/a.png/b.jpg');
    expect(withoutEdgeQuotes('"/tmp/a.png"')).toBe('/tmp/a.png');
  });
});

describe('no image or video output can freeze the renderer', () => {
  within('48k "/tmp/" roots in one run with no extension (240k characters)', () =>
    sandboxMediaPath('/tmp/'.repeat(48_000), ROOTS, 'image'),
  );
  within('a path whose run holds 240k characters and no extension', () =>
    sandboxMediaPath(`/workspace/${'a'.repeat(240_000)}`, ROOTS, 'video'),
  );
  within('240k quotes inside the output', () => withoutEdgeQuotes(`a${'"'.repeat(240_000)}b`));
  within('240k slashes inside a path', () => withoutTrailingSlashes(`a${'/'.repeat(240_000)}b`));
});
