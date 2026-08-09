import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { AttachmentTiles } from './attachment-tiles';
import type { AttachedFile } from './types';

/**
 * `renderToStaticMarkup` never commits effects, so the HEIC-decode and
 * text-preview `useEffect`s in `attachment-tiles.tsx` never run here — these
 * assertions cover the synchronous shape: same tile surface as the sent
 * message, two-line-clamped filenames, and the always-reachable remove
 * button. The effects themselves (HEIC conversion, the text-preview read) are
 * exercised indirectly via `attachment-tiles-logic.test.ts`, which covers
 * their pure decision logic.
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
    expect(markup).toContain('AdmitCard-260411128971.pdf');
    expect(markup).toContain('line-clamp-2');
  });

  test('the tile uses the exact surface shape shared with the sent message', () => {
    const markup = renderToStaticMarkup(
      <AttachmentTiles files={[localDoc('notes.txt')]} onRemove={() => {}} />,
    );
    // Same TILE_SURFACE string user-message.tsx renders its tiles with.
    expect(markup).toContain('size-20');
    expect(markup).toContain('rounded-md');
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
});
