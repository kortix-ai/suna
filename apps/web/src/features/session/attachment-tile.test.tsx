import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  AttachmentTile,
  TILE_SURFACE,
  attachmentExtension,
  isPreviewableImage,
  middleTruncateFilename,
  splitFilenameForTile,
} from './attachment-tile';

describe('attachmentExtension', () => {
  test('reads the extension off the name, lowercased', () => {
    expect(attachmentExtension('Jay Suthar.svg')).toBe('svg');
    expect(attachmentExtension('pr-context.ZIP')).toBe('zip');
    expect(attachmentExtension('kortix-critical-thinking-chatux.md')).toBe('md');
    expect(attachmentExtension('component.tsx')).toBe('tsx');
  });

  test('falls back to the MIME subtype when the name has none', () => {
    expect(attachmentExtension('photo', 'image/jpeg')).toBe('jpeg');
    expect(attachmentExtension('logo', 'image/svg+xml')).toBe('svg');
    expect(attachmentExtension('doc', 'application/pdf')).toBe('pdf');
    expect(attachmentExtension('README', 'text/markdown; charset=utf-8')).toBe('markdown');
  });

  test('is empty when nothing says what the file is', () => {
    expect(attachmentExtension('README')).toBe('');
    expect(attachmentExtension('.env')).toBe('');
    expect(attachmentExtension('trailing.', 'application/octet-stream')).toBe('octet-stream');
  });
});

describe('middleTruncateFilename', () => {
  test('leaves a short name alone', () => {
    expect(middleTruncateFilename('doc.pdf')).toBe('doc.pdf');
  });

  // The tail is what tells two exports of the same thing apart, and it
  // carries the extension. An end-ellipsis threw exactly that away.
  test('keeps the start AND the end of a long name', () => {
    const out = middleTruncateFilename('kortix-critical-thinking-chatux.md');
    expect(out.length).toBeLessThanOrEqual(22);
    expect(out.startsWith('kortix-crit')).toBe(true);
    expect(out.endsWith('-chatux.md')).toBe(true);
    expect(out).toContain('…');
  });
});

const render = (el: React.ReactElement) => renderToStaticMarkup(el);

describe('AttachmentTile', () => {
  test('a named file: name top, extension badge bottom, one square', () => {
    const html = render(<AttachmentTile filename="pr-context.zip" mime="application/zip" />);
    expect(html).toContain('pr-context.zip');
    // The badge is the design system's Badge, xs, medium weight. The ext is
    // lowercase in the DOM and uppercase on screen: the badge centres a
    // capital's height, and a lowercase body sits ~1.3px low in it (see the
    // note at the badge). `secondary` is `normal-case`; `uppercase` must win.
    expect(html).toMatch(/data-slot="badge"[^>]*>zip</);
    expect(html).toMatch(/data-slot="badge" class="[^"]*\buppercase\b/);
    expect(html).not.toMatch(/data-slot="badge" class="[^"]*normal-case/);
    expect(html).toContain('font-medium');
    expect(html).toContain(TILE_SURFACE);
    expect(html).toContain('size-28');
    expect(html).toContain('rounded-md');
    expect(html).not.toContain('<svg'); // no leading icon — the badge says what it is
  });

  test('an image IS the picture — no name, no badge', () => {
    const html = render(
      <AttachmentTile filename="photo.png" mime="image/png" imageSrc="blob:local-1" />,
    );
    expect(html).toContain('src="blob:local-1"');
    expect(html).toContain('alt="photo.png"');
    expect(html).toContain('object-cover');
    expect(html).not.toContain('data-slot="badge"');
    expect(html.match(/>photo\.png</g)).toBeNull();
  });

  // An SVG is text that happens to draw: a logo on a 100px tile is a blob, and
  // its NAME is what tells it from the next logo. Named treatment, always —
  // even when a src is handed in.
  test('an SVG is never the picture, even with a src', () => {
    const html = render(
      <AttachmentTile filename="Jay Suthar.svg" mime="image/svg+xml" imageSrc="blob:local-2" />,
    );
    expect(html).not.toContain('<img');
    expect(html).toContain('Jay Suthar.svg');
    expect(html).toMatch(/>svg</);
    expect(isPreviewableImage('logo.svg', 'image/svg+xml')).toBe(false);
    expect(isPreviewableImage('shot.png', 'image/png')).toBe(true);
    expect(isPreviewableImage('doc.pdf', 'application/pdf')).toBe(false);
  });

  test('pending shows the one spinner opposite the badge', () => {
    const html = render(<AttachmentTile filename="doc.pdf" mime="application/pdf" pending />);
    expect(html).toContain('animate-spinner-orbit');
    expect(html).toMatch(/>pdf</);
  });

  test('is a button with the press affordance only when it opens something', () => {
    const inert = render(<AttachmentTile filename="notes.txt" />);
    expect(inert.startsWith('<span')).toBe(true);
    expect(inert).not.toContain('cursor-pointer');
    const opens = render(<AttachmentTile filename="notes.txt" onOpen={() => {}} />);
    expect(opens.startsWith('<button')).toBe(true);
    expect(opens).toContain('cursor-pointer');
    expect(opens).toContain('active:scale-[0.96]');
  });

  // The reference: `kortix-critical…` on line one, `ng-chatux.md` on line two.
  test('a long name is two lines — an ellipsized head and the verbatim tail', () => {
    const html = render(<AttachmentTile filename="kortix-critical-thinking-chatux.md" />);
    expect(html).toMatch(/class="block truncate">kortix-critical-thinking</);
    expect(html).toMatch(/class="block truncate">-chatux\.md</);
    expect(html).not.toContain('line-clamp-2');
  });

  test('a short name wraps naturally instead', () => {
    const html = render(<AttachmentTile filename="doc.pdf" />);
    expect(html).toContain('line-clamp-2');
    expect(html).toContain('>doc.pdf<');
  });

  test('splitFilenameForTile keeps exactly the last ten characters', () => {
    expect(splitFilenameForTile('doc.pdf')).toBeNull();
    expect(splitFilenameForTile('kortix-critical-thinking-chatux.md')).toEqual({
      head: 'kortix-critical-thinking',
      tail: '-chatux.md',
    });
  });
});
