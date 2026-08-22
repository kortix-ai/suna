import type { FilePart } from '@/ui';
import { describe, expect, test } from 'bun:test';

import { normalizeAttachments } from './user-message';

// The bug this guards: an upload reaches the transcript as a
// `<file path mime filename>` TAG in the message text (uploaded-file-refs.ts),
// which `parseFileReferences` strips back out into `uploadedFiles`. Nothing
// rendered that list, so the tag left the visible text and the file vanished —
// attach a PNG or a CSV and the message showed only what you typed.

function part(id: string, filename: string, mime: string, url?: string): FilePart {
  return { id, type: 'file', filename, mime, url } as unknown as FilePart;
}

const upload = (path: string, mime: string, filename: string) => ({ path, mime, filename });

describe('normalizeAttachments', () => {
  test('an upload survives normalization — it used to be dropped entirely', () => {
    const result = normalizeAttachments(
      [],
      [upload('/workspace/data.csv', 'text/csv', 'data.csv')],
    );

    expect(result).toHaveLength(1);
    expect(result[0].filename).toBe('data.csv');
    expect(result[0].mime).toBe('text/csv');
  });

  test('an upload carries a path, so it can be opened and fetched', () => {
    const [file] = normalizeAttachments(
      [],
      [upload('/workspace/shot.png', 'image/png', 'shot.png')],
    );

    // `path` is what makes the row clickable and what SandboxImage resolves.
    expect(file.path).toBe('/workspace/shot.png');
    expect(file.src).toBe('/workspace/shot.png');
  });

  test('a message file-part carries a url and no path — it is not openable', () => {
    const [file] = normalizeAttachments(
      [part('p1', 'chart.png', 'image/png', 'https://x/chart.png')],
      [],
    );

    expect(file.src).toBe('https://x/chart.png');
    expect(file.path).toBeUndefined();
  });

  test('both routes render as one list', () => {
    const result = normalizeAttachments(
      [part('p1', 'chart.png', 'image/png', 'https://x/chart.png')],
      [upload('/workspace/notes.md', 'text/markdown', 'notes.md')],
    );

    expect(result.map((f) => f.filename)).toEqual(['chart.png', 'notes.md']);
  });

  test('keys stay unique across routes so React does not collide them', () => {
    const result = normalizeAttachments(
      [part('same', 'a.txt', 'text/plain')],
      [upload('same', 'text/plain', 'b.txt')],
    );

    expect(new Set(result.map((f) => f.key)).size).toBe(2);
  });

  test('two uploads with the SAME path still get different keys', () => {
    // Paste three screenshots and the clipboard names them all `image.png`
    // (clipboard-files.ts). Keyed by path alone, that was three identical
    // `upload:/workspace/uploads/image.png` keys and React kept one tile.
    const result = normalizeAttachments(
      [],
      [
        upload('/workspace/uploads/image.png', 'image/png', 'image.png'),
        upload('/workspace/uploads/image.png', 'image/png', 'image.png'),
        upload('/workspace/uploads/image.png', 'image/png', 'image.png'),
      ],
    );

    expect(result).toHaveLength(3);
    expect(new Set(result.map((f) => f.key)).size).toBe(3);
  });

  test('an in-flight upload is keyed by its id and renders as pending', () => {
    // An optimistic ref has no path at all — the daemon has not answered yet —
    // so the tile must not try to resolve one.
    const result = normalizeAttachments(
      [],
      [
        { path: '', mime: 'image/png', filename: 'image.png', pending: 'upl_0' },
        { path: '', mime: 'image/png', filename: 'image.png', pending: 'upl_1' },
      ],
    );

    expect(new Set(result.map((f) => f.key)).size).toBe(2);
    expect(result.every((f) => f.pending)).toBe(true);
    expect(result.every((f) => f.src === undefined && f.path === undefined)).toBe(true);
    expect(result.map((f) => f.filename)).toEqual(['image.png', 'image.png']);
  });

  test('a landed upload is not pending', () => {
    const [file] = normalizeAttachments([], [upload('/workspace/a.png', 'image/png', 'a.png')]);
    expect(file.pending).toBe(false);
  });

  test('a nameless upload falls back to the basename of its path', () => {
    const [file] = normalizeAttachments([], [upload('/workspace/deep/report.pdf', 'x', '')]);
    expect(file.filename).toBe('report.pdf');
  });

  test('a data: URL file-part renders through an object URL, decoded once per part', () => {
    // A composer screenshot rides the message as a `data:image/...;base64,`
    // file part (uploaded-file-refs.ts). The transcript must never hand that
    // multi-MB string to `<img src>`: the render reads a `blob:` object URL
    // created ONCE per part id (attachment-object-url.ts). The part itself
    // keeps the data URL — it is the persisted form.
    const dataUrl =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const p1 = part('prt_img', 'shot.png', 'image/png', dataUrl);
    const [first] = normalizeAttachments([p1], []);
    const [second] = normalizeAttachments([p1], []);
    expect(first.src?.startsWith('blob:')).toBe(true);
    expect(second.src).toBe(first.src);
    expect(p1.url).toBe(dataUrl);
  });

  test('no attachments produces an empty list, not undefined', () => {
    expect(normalizeAttachments([], [])).toEqual([]);
  });
});
