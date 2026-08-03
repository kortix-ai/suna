import { describe, expect, test } from 'bun:test';
import type { FilePart } from '@/ui';

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
    const result = normalizeAttachments([], [upload('/workspace/data.csv', 'text/csv', 'data.csv')]);

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

  test('a nameless upload falls back to the basename of its path', () => {
    const [file] = normalizeAttachments([], [upload('/workspace/deep/report.pdf', 'x', '')]);
    expect(file.filename).toBe('report.pdf');
  });

  test('no attachments produces an empty list, not undefined', () => {
    expect(normalizeAttachments([], [])).toEqual([]);
  });
});
