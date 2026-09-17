import type { FilePart, Part } from '@/ui';
import { sanitizePromptUploadFilename } from '@kortix/shared';
import { describe, expect, test } from 'bun:test';

import { mergeSentAttachments, normalizeAttachments } from './user-message';

// The bug this guards: an upload reaches the transcript as a
// `<file path mime filename>` TAG in the message text (uploaded-file-refs.ts),
// which `parseFileReferences` strips back out into `uploadedFiles`. Nothing
// rendered that list, so the tag left the visible text and the file vanished —
// attach a PNG or a CSV and the message showed only what you typed.

function part(id: string, filename: string, mime: string, url?: string): FilePart {
  return { id, type: 'file', filename, mime, url } as unknown as FilePart;
}

const upload = (path: string, mime: string, filename: string) => ({ path, mime, filename });

function textPart(id: string, text: string): Part {
  return { id, type: 'text', text } as unknown as Part;
}

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

  test('keeps one native part followed by workspace references in source order', () => {
    const result = normalizeAttachments(
      [part('p1', 'bundle.zip', 'application/zip', 'data:application/zip;base64,UEsDBA==')],
      [
        upload('/workspace/README.md', 'text/markdown', 'README.md'),
        upload('/workspace/shot.png', 'image/png', 'shot.png'),
      ],
    );

    expect(result.map((file) => file.filename)).toEqual(['bundle.zip', 'README.md', 'shot.png']);
  });

  test('merges references and native files by their original part positions', () => {
    const result = normalizeAttachments(
      [
        textPart('t1', 'two workspace references'),
        part('p1', 'shot.png', 'image/png', 'data:image/png;base64,iVBORw0KGgo='),
        textPart('t2', 'one later workspace reference'),
      ],
      [
        { ...upload('/workspace/README.md', 'text/markdown', 'README.md'), sourcePartIndex: 0 },
        { ...upload('/workspace/report.pdf', 'application/pdf', 'report.pdf'), sourcePartIndex: 0 },
        { ...upload('/workspace/data.csv', 'text/csv', 'data.csv'), sourcePartIndex: 2 },
      ],
    );

    expect(result.map((file) => file.filename)).toEqual([
      'README.md',
      'report.pdf',
      'shot.png',
      'data.csv',
    ]);
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

  test('a handle-backed sent upload is keyed by its identity and is never pending', () => {
    // A sent ref has no path until the runtime delivers it. It is still a
    // finished object on screen: no spinner, no sandbox read.
    const result = normalizeAttachments(
      [],
      [
        { path: '', mime: 'image/png', filename: 'image.png', attachment: 'upload-0' },
        { path: '', mime: 'image/png', filename: 'image.png', attachment: 'upload-1' },
      ],
    );

    expect(result.map((f) => f.key)).toEqual(['attachment:upload-0', 'attachment:upload-1']);
    expect(result.map((f) => f.id)).toEqual(['upload-0', 'upload-1']);
    expect(result.some((f) => 'pending' in f)).toBe(false);
    expect(result.every((f) => f.src === undefined && f.path === undefined)).toBe(true);
  });

  test('an empty path never makes a user attachment pending', () => {
    const [nameless, landed] = normalizeAttachments(
      [],
      [
        { path: '', mime: 'image/png', filename: 'image.png' },
        upload('/workspace/a.png', 'image/png', 'a.png'),
      ],
    );
    expect('pending' in nameless).toBe(false);
    expect('pending' in landed).toBe(false);
    expect(nameless.key).toBe('upload:0:');
  });

  test('a nameless upload falls back to the basename of its path', () => {
    const [file] = normalizeAttachments([], [upload('/workspace/deep/report.pdf', 'x', '')]);
    expect(file.filename).toBe('report.pdf');
  });

  test('no attachments produces an empty list, not undefined', () => {
    expect(normalizeAttachments([], [])).toEqual([]);
  });
});

describe('mergeSentAttachments', () => {
  const sent = [
    { id: 'upload-a', filename: 'a.png', mime: 'image/png' },
    { id: 'upload-b', filename: 'b.pdf', mime: 'application/pdf' },
  ];

  test('the echo text part lands before its file parts: every submitted tile stays, keyed by identity', () => {
    const result = mergeSentAttachments([], sent);
    expect(result.map((f) => f.key)).toEqual(['attachment:upload-a', 'attachment:upload-b']);
    expect(result.map((f) => f.id)).toEqual(['upload-a', 'upload-b']);
  });

  test('a delivered part takes its submitted identity and send order, even when it lands first', () => {
    const arrived = normalizeAttachments(
      [part('p-b', 'b.pdf', 'application/pdf', 'data:application/pdf;base64,JVBERi0=')],
      [],
    );
    const result = mergeSentAttachments(arrived, sent);

    expect(result.map((f) => f.key)).toEqual(['attachment:upload-a', 'attachment:upload-b']);
    expect(result[0].src).toBeUndefined();
    expect(result[1].src).toBe('data:application/pdf;base64,JVBERi0=');
  });

  test('same-named attachments match their delivered parts by occurrence', () => {
    const three = ['upload-1', 'upload-2', 'upload-3'].map((id) => ({
      id,
      filename: 'image.png',
      mime: 'image/png',
    }));
    const arrived = normalizeAttachments(
      [],
      [
        upload('/workspace/uploads/.kortix-inbox/k/0-image.png', 'image/png', 'image.png'),
        upload('/workspace/uploads/.kortix-inbox/k/1-image.png', 'image/png', 'image.png'),
      ],
    );
    const result = mergeSentAttachments(arrived, three);

    expect(result.map((f) => f.key)).toEqual([
      'attachment:upload-1',
      'attachment:upload-2',
      'attachment:upload-3',
    ]);
    expect(result.map((f) => f.path)).toEqual([
      '/workspace/uploads/.kortix-inbox/k/0-image.png',
      '/workspace/uploads/.kortix-inbox/k/1-image.png',
      undefined,
    ]);
  });

  // The API stores `sanitizePromptUploadFilename(name)` at begin, and the delivered ref carries
  // that stored name. A renamed file must still claim its sent entry: one tile, one identity.
  const renamed: Array<[string, string]> = [
    ['a name longer than 215 bytes', `${'图'.repeat(80)}.png`],
    ['a name with surrounding whitespace', ' shot.png '],
  ];
  for (const [label, name] of renamed) {
    test(`a delivered file the API renamed still claims its sent entry: ${label}`, () => {
      const stored = sanitizePromptUploadFilename(name);
      expect(stored).not.toBe(name);
      const arrived = normalizeAttachments(
        [],
        [upload(`/workspace/uploads/.kortix-inbox/k/0-${stored}`, 'image/png', stored)],
      );
      const result = mergeSentAttachments(arrived, [
        { id: 'upload-1', filename: name, mime: 'image/png' },
      ]);

      expect(result).toHaveLength(1);
      expect(result[0].key).toBe('attachment:upload-1');
      expect(result[0].path).toBe(`/workspace/uploads/.kortix-inbox/k/0-${stored}`);
    });
  }

  test('a reload has no submitted list: the arrived tiles are drawn as they are', () => {
    const arrived = normalizeAttachments([], [upload('/workspace/a.png', 'image/png', 'a.png')]);
    expect(mergeSentAttachments(arrived, undefined)).toBe(arrived);
  });
});
