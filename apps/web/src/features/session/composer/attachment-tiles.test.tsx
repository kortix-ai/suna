import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { AttachmentTiles, FileTileWithPreview } from './attachment-tiles';
import type { AttachedFile } from './types';

/**
 * `renderToStaticMarkup` never commits effects, so the HEIC-decode and
 * text-preview `useEffect`s in `attachment-tiles.tsx` never run here — these
 * assertions cover the synchronous shape: the sent message's own tile
 * surfaces, two-line-clamped filenames, a positioning anchor the remove
 * button can actually use, and the always-reachable remove button. The
 * effects themselves (HEIC conversion, the text-preview read) are exercised
 * indirectly via `attachment-tiles-logic.test.ts`, which covers their pure
 * decision logic. The preview's stacking order is exercised directly below
 * via `FileTileWithPreview`, which takes its `preview` as a prop precisely so
 * it doesn't need an effect to test.
 */

const localImage = (name: string, localUrl = 'blob:local-1'): AttachedFile => ({
  kind: 'local',
  file: new File([''], name, { type: 'image/png' }),
  localUrl,
  isImage: true,
});

const localDoc = (name: string): AttachedFile => ({
  kind: 'local',
  file: new File(['hello'], name, { type: 'application/pdf' }),
  localUrl: 'blob:local-doc',
  isImage: false,
});

/** Every `class="..."` attribute value in a markup string. */
function classAttrs(html: string): string[] {
  return [...html.matchAll(/class="([^"]*)"/g)].map((m) => m[1]);
}

describe('AttachmentTiles', () => {
  test('no files renders nothing', () => {
    expect(renderToStaticMarkup(<AttachmentTiles files={[]} onRemove={() => {}} />)).toBe('');
  });

  test('an image tile paints the picture, not a filename tile', () => {
    const markup = renderToStaticMarkup(
      <AttachmentTiles files={[localImage('photo.png')]} onRemove={() => {}} />,
    );
    expect(markup).toContain('src="blob:local-1"');
    expect(markup).toContain('alt="photo.png"');
  });

  test('a non-image tile shows the icon + two-line-clamped filename treatment', () => {
    const markup = renderToStaticMarkup(
      <AttachmentTiles files={[localDoc('AdmitCard-260411128971.pdf')]} onRemove={() => {}} />,
    );
    // Body text once (title= and aria-label= also mention the name).
    expect(markup.match(/>AdmitCard-260411128971\.pdf</g)?.length).toBe(1);
    expect(markup).toContain('line-clamp-2');
    // Cap + min-w-0 let the clamp ellipsize; `truncate` (nowrap) defeats it.
    expect(markup).toContain('max-w-60');
    expect(markup).toContain('min-w-0');
    expect(markup).not.toMatch(/line-clamp-2[^"]*\btruncate\b|\btruncate\b[^"]*line-clamp-2/);
  });

  test('an image tile is the sent message square (TILE_SURFACE), not the file rectangle', () => {
    const markup = renderToStaticMarkup(
      <AttachmentTiles files={[localImage('photo.png')]} onRemove={() => {}} />,
    );
    // TILE_SURFACE — an 80×80 square.
    expect(markup).toContain('size-20');
    // NOT FILE_TILE_SURFACE's rectangle sizing.
    expect(markup).not.toContain('min-w-40');
  });

  test('a non-image tile is the sent message rectangle (FILE_TILE_SURFACE), not the image square', () => {
    // A PDF used to render as an 80×80 square while composing and an 80×160
    // rectangle once sent (`user-message.tsx`'s file-tile branch) — the exact
    // drift this task exists to eliminate. Pin the correct shape per kind.
    const markup = renderToStaticMarkup(
      <AttachmentTiles files={[localDoc('notes.txt')]} onRemove={() => {}} />,
    );
    expect(markup).toContain('h-20');
    expect(markup).toContain('min-w-40');
    expect(markup).toContain('max-w-60');
    // NOT TILE_SURFACE's square sizing.
    expect(markup).not.toContain('size-20');
  });

  test('remove button is reachable without hover: touch and keyboard-focus classes', () => {
    const markup = renderToStaticMarkup(
      <AttachmentTiles files={[localDoc('notes.txt')]} onRemove={() => {}} />,
    );
    expect(markup).toContain('aria-label="Remove notes.txt"');
    expect(markup).toContain('focus-visible:opacity-100');
    expect(markup).toContain('[@media(pointer:coarse)]:opacity-100');
  });

  test('multiple attachments each get their own remove button', () => {
    const markup = renderToStaticMarkup(
      <AttachmentTiles
        files={[localDoc('a.txt'), localImage('b.png'), localDoc('c.pdf')]}
        onRemove={() => {}}
      />,
    );
    expect(markup).toContain('aria-label="Remove a.txt"');
    expect(markup).toContain('aria-label="Remove b.png"');
    expect(markup).toContain('aria-label="Remove c.pdf"');
  });

  test('the tile has no cursor-pointer / press-scale affordance (nothing to click)', () => {
    // TILE_INTERACTIVE ships `cursor-pointer` + `active:scale-[0.97]` — a
    // click promise. The composer tile has no click handler, so applying it
    // unconditionally (as an earlier version of this component did) would be
    // a broken promise, unlike the sent message's `canOpen && TILE_INTERACTIVE`
    // (`user-message.tsx`), which only offers it when there is something to
    // open.
    const markup = renderToStaticMarkup(
      <AttachmentTiles
        files={[localDoc('notes.txt'), localImage('photo.png')]}
        onRemove={() => {}}
      />,
    );
    expect(markup).not.toContain('cursor-pointer');
    expect(markup).not.toContain('active:scale-[0.97]');
  });

  test('no element is both `contents` and `relative` — that combination is inert', () => {
    // `display: contents` removes an element's own box; an element with no
    // box cannot anchor `position: absolute` children. A `<li>` that was
    // `"group relative contents"` looked like a positioning anchor and
    // wasn't one — the remove button silently anchored to whatever real
    // positioned ancestor existed further up instead of its own tile.
    const markup = renderToStaticMarkup(
      <AttachmentTiles files={[localDoc('notes.txt')]} onRemove={() => {}} />,
    );
    for (const cls of classAttrs(markup)) {
      const words = cls.split(/\s+/);
      const hasBoth = words.includes('contents') && words.includes('relative');
      expect(hasBoth).toBe(false);
    }
  });

  test('the remove button is not nested inside the overflow-hidden tile (would clip its corner)', () => {
    // The tile box is `overflow-hidden` (to clip the image/icon to its
    // rounded corners). The remove button's `-top-1.5 -right-1.5` offset
    // puts part of it outside that box's edge on purpose — nesting the
    // button inside an `overflow-hidden` ancestor would silently chop that
    // part off. Confirm the tile div fully closes before the button opens,
    // i.e. they are siblings, not parent/child.
    const markup = renderToStaticMarkup(
      <AttachmentTiles files={[localDoc('notes.txt')]} onRemove={() => {}} />,
    );
    const overflowDivStart = markup.indexOf('overflow-hidden');
    expect(overflowDivStart).toBeGreaterThan(-1);
    const tileDivCloses = markup.indexOf('</div>', overflowDivStart);
    const buttonOpens = markup.indexOf('<button');
    expect(tileDivCloses).toBeGreaterThan(-1);
    expect(buttonOpens).toBeGreaterThan(-1);
    expect(tileDivCloses).toBeLessThan(buttonOpens);
  });
});

describe('FileTileWithPreview', () => {
  test('no preview renders only the icon/filename wrapper', () => {
    const markup = renderToStaticMarkup(
      <FileTileWithPreview filename="notes.txt" preview={null} />,
    );
    expect(markup).toContain('notes.txt');
    expect(markup).not.toContain('<pre');
  });

  test('a preview and the filename wrapper get different, explicit z-index — the wrapper wins', () => {
    // Two sibling positioned elements with differing non-auto z-index stack
    // by that value alone, regardless of DOM/paint order — so asserting both
    // classes are present and distinct is what proves the fix is wired up:
    // the icon/filename layer (z-10) is stated to sit above the preview
    // layer (z-0), rather than left to accidental in-flow-vs-positioned
    // paint-order rules (which would have put the preview on top instead).
    const markup = renderToStaticMarkup(
      <FileTileWithPreview filename="notes.txt" preview={'const x = 1;\nconst y = 2;'} />,
    );
    expect(markup).toContain('const x = 1;');
    expect(markup).toContain('z-0');
    expect(markup).toContain('z-10');
    // The filename must still be present and on the higher-z wrapper — not
    // swallowed by the preview.
    const wrapperStart = markup.indexOf('z-10');
    expect(markup.indexOf('notes.txt')).toBeGreaterThan(wrapperStart);
  });
});
