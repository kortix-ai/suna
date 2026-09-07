import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { TILE_SURFACE } from '../attachment-tile';
import { AttachmentTiles } from './attachment-tiles';
import type { AttachedFile } from './types';

/**
 * `renderToStaticMarkup` never commits effects, so the HEIC-decode and
 * text-preview `useEffect`s in `attachment-tiles.tsx` never run here — these
 * assertions cover the synchronous shape: the sent message's own tile
 * surfaces, two-line-clamped filenames, a positioning anchor the remove
 * button can actually use, and the always-reachable remove button. The
 * effect itself (HEIC conversion) is exercised indirectly via
 * `attachment-tiles-logic.test.ts`, which covers its pure decision logic.
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
  test('an attached SVG shows its name, not a rendered preview', () => {
    const svg: AttachedFile = {
      kind: 'local',
      file: new File(['<svg/>'], 'Jay Suthar.svg', { type: 'image/svg+xml' }),
      localUrl: 'blob:local-svg',
      isImage: true,
    };
    const markup = renderToStaticMarkup(<AttachmentTiles files={[svg]} onRemove={() => {}} />);
    expect(markup).not.toContain('<img');
    expect(markup).toContain('Jay Suthar.svg');
    expect(markup).toMatch(/>svg</);
  });

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

  test('a non-image tile shows the name + extension badge treatment', () => {
    const markup = renderToStaticMarkup(
      <AttachmentTiles files={[localDoc('AdmitCard-260411128971.pdf')]} onRemove={() => {}} />,
    );
    // A long name is an ellipsized head plus its verbatim ten-character tail,
    // and the badge names the type. `title=` and `aria-label=` carry the full
    // name.
    expect(markup).toMatch(/class="block truncate">128971\.pdf</);
    expect(markup).toMatch(/>pdf</);
    expect(markup).toContain('size-28');
    expect(markup).toContain('min-w-0');
  });

  test('image and file tiles are ONE square — the same surface the sent message uses', () => {
    // A PDF used to render as an 80×80 square while composing and a wider
    // rectangle once sent — the exact drift this module exists to eliminate.
    // Now there is one shape, taken from the shared module rather than pasted.
    const image = renderToStaticMarkup(
      <AttachmentTiles files={[localImage('photo.png')]} onRemove={() => {}} />,
    );
    const doc = renderToStaticMarkup(
      <AttachmentTiles files={[localDoc('notes.txt')]} onRemove={() => {}} />,
    );
    expect(image).toContain(TILE_SURFACE);
    expect(doc).toContain(TILE_SURFACE);
    expect(image).not.toContain('w-30');
    expect(doc).not.toContain('w-30');
  });

  test('remove button is hidden until the tile is hovered, yet reachable without hover', () => {
    const markup = renderToStaticMarkup(
      <AttachmentTiles files={[localDoc('notes.txt')]} onRemove={() => {}} />,
    );
    expect(markup).toContain('aria-label="Remove notes.txt"');
    const button = markup.slice(markup.indexOf('<button'), markup.indexOf('</button>'));
    // Invisible at rest, shown by hovering the tile…
    expect(button).toContain('opacity-0');
    expect(button).toContain('group-hover:opacity-100');
    expect(button).not.toContain('opacity-60');
    // …and still there for keyboard focus and for touch, where hover does not exist.
    expect(button).toContain('focus-visible:opacity-100');
    expect(button).toContain('[@media(pointer:coarse)]:opacity-100');
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
    // TILE_INTERACTIVE ships `cursor-pointer` + `active:scale-[0.96]` — a
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
    expect(markup).not.toContain('active:scale-[0.96]');
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
    const tileStart = markup.indexOf('overflow-hidden');
    const buttonOpens = markup.indexOf('<button');
    expect(tileStart).toBeGreaterThan(-1);
    expect(buttonOpens).toBeGreaterThan(tileStart);
    // Every element opened from the tile onward is closed again before the
    // button opens — the tile is a finished sibling, not an open ancestor.
    const between = markup.slice(tileStart, buttonOpens);
    const opens = (between.match(/<span\b/g) ?? []).length;
    const closes = (between.match(/<\/span>/g) ?? []).length;
    expect(closes).toBe(opens + 1); // +1: the tile's own opening tag sits before `tileStart`
  });
});
