import { describe, expect, test } from 'bun:test';

import type { SessionPromptPart } from '@kortix/sdk';

import { parseFileReferences } from '@/features/session/message-parsing';
import type { AttachedFile } from '@/features/session/session-chat-input';
import {
  buildOptimisticPromptTextWithUploads,
  MAX_UPLOAD_FILENAME_BYTES,
  optimisticUploadedFileRef,
  promptFileParts,
  sanitizeUploadFilename,
  sentAttachmentsOf,
  uploadedFileRefXml,
} from './uploaded-file-refs';

const UPLOADS = '/workspace/uploads';

function localFile(
  name: string,
  type = 'text/plain',
  uploadId?: string,
): Extract<AttachedFile, { kind: 'local' }> {
  return {
    kind: 'local',
    ...(uploadId ? { uploadId } : {}),
    file: new File(['hello'], name, { type }),
    localUrl: 'blob:test',
    isImage: type.startsWith('image/'),
  };
}

function remoteFile(filename = 'remote.pdf'): Extract<AttachedFile, { kind: 'remote' }> {
  return {
    kind: 'remote',
    url: 'https://files.example/remote.pdf',
    filename,
    mime: 'application/pdf',
    isImage: false,
  };
}

const byteLength = (value: string) => new TextEncoder().encode(value).length;

describe('uploaded file references', () => {
  test('sanitizes only what the daemon cannot take', () => {
    // Path separators are the one thing a filename may never carry — the daemon
    // basenames it away, and a client that sends one has already lost the name.
    expect(sanitizeUploadFilename('nested/report.pdf')).toBe('nested_report.pdf');
    expect(sanitizeUploadFilename('back\\slash.pdf')).toBe('back_slash.pdf');
    expect(sanitizeUploadFilename('')).toBe('upload');
    // `.` and `..` basename to themselves, so the daemon rejects them outright.
    expect(sanitizeUploadFilename('..')).toBe('upload');
  });

  test('a spaced or punctuated name survives intact', () => {
    // This used to become `Project_Veyris__1.zip`. Nothing in the pipeline
    // needed that: the name is XML-escaped in the prompt and basenamed by the
    // daemon.
    expect(sanitizeUploadFilename('Project Veyris #1.zip')).toBe('Project Veyris #1.zip');
  });

  test('a non-Latin name stays readable and stays distinct', () => {
    // The old sanitizer mapped every non-ASCII character to `_`, so `报告.pdf`
    // and `财报.pdf` both landed as `__.pdf` — indistinguishable on disk and in
    // the prompt the model reads.
    expect(sanitizeUploadFilename('报告.pdf')).toBe('报告.pdf');
    expect(sanitizeUploadFilename('Отчёт.pdf')).toBe('Отчёт.pdf');
    expect(sanitizeUploadFilename('报告.pdf')).not.toBe(sanitizeUploadFilename('财报.pdf'));
  });

  test('a too-long name is truncated by BYTES, keeping its extension', () => {
    // 255 is a byte limit, not a character one. Past it the daemon's
    // `fs.writeFile` threw `ENAMETOOLONG` and the user saw the raw errno.
    const ascii = sanitizeUploadFilename(`${'a'.repeat(400)}.pdf`);
    expect(byteLength(ascii)).toBeLessThanOrEqual(MAX_UPLOAD_FILENAME_BYTES);
    expect(ascii.endsWith('.pdf')).toBe(true);

    // A CJK name hits the same wall at ~85 characters, so character-wise
    // truncation would still have produced an ENAMETOOLONG.
    const cjk = sanitizeUploadFilename(`${'报'.repeat(200)}.pdf`);
    expect(byteLength(cjk)).toBeLessThanOrEqual(MAX_UPLOAD_FILENAME_BYTES);
    expect(cjk.endsWith('.pdf')).toBe(true);
    // Truncation never splits a character in half.
    expect(cjk.slice(0, -4)).toBe('报'.repeat((cjk.length - 4) as number));
    // And it leaves room for the daemon's collision suffix.
    expect(byteLength(cjk) + 37).toBeLessThanOrEqual(255);
  });

  test('escapes XML attributes in generated refs', () => {
    expect(
      uploadedFileRefXml({
        path: '/workspace/uploads/a"b.txt',
        mime: 'text/plain',
        filename: 'bad"name<file>.txt',
      }),
    ).toContain('filename="bad&quot;name&lt;file&gt;.txt"');
  });

  test('an escaped attribute round-trips back to the original string', () => {
    // `R&D report.pdf` used to reach the transcript — and the model — as the
    // literal `R&amp;D report.pdf`, because the parser pushed the raw attribute
    // straight back out.
    for (const filename of [
      'R&D report.pdf',
      'a"b.txt',
      '<script>.md',
      '10 > 9 & 8 < 7.csv',
      'already &amp; escaped.txt',
      '报告 & 财报.pdf',
    ]) {
      const path = `${UPLOADS}/${filename}`;
      const xml = uploadedFileRefXml({ path, mime: 'text/plain', filename });
      const { files, cleanText } = parseFileReferences(`look\n\n${xml}`);

      expect(files).toHaveLength(1);
      expect(files[0].filename).toBe(filename);
      expect(files[0].path).toBe(path);
      expect(files[0].mime).toBe('text/plain');
      expect(cleanText).toBe('look');
    }
  });

  test('a handle-backed optimistic ref carries its attachment identity, no path and no pending id', () => {
    expect(optimisticUploadedFileRef(localFile('a b.png', 'image/png', 'upload-2'))).toEqual({
      path: '',
      mime: 'image/png',
      filename: 'a b.png',
      attachment: 'upload-2',
    });
  });

  test('the submitted list names each file by identity, name and type', () => {
    expect(
      sentAttachmentsOf([localFile('shot.png', '', 'upload-0'), remoteFile('remote.pdf')]),
    ).toEqual([
      { id: 'upload-0', filename: 'shot.png', mime: 'image/png' },
      { filename: 'remote.pdf', mime: 'application/pdf' },
    ]);
  });

  test('a remote attachment needs no upload, so it keeps its path', () => {
    expect(optimisticUploadedFileRef(remoteFile('remote.pdf'))).toEqual({
      path: 'remote.pdf',
      mime: 'application/pdf',
      filename: 'remote.pdf',
    });
  });

  test('builds optimistic refs before upload completes', () => {
    const text = buildOptimisticPromptTextWithUploads('look at these', [
      localFile('Screenshot 2026.png', 'image/png', 'upload-0'),
    ]);

    expect(text).toContain('look at these');
    expect(text).toContain('filename="Screenshot 2026.png"');
    expect(text).toContain('attachment="upload-0"');
    expect(text).not.toContain('pending=');
    // No guessed path. The daemon assigns it, and it is frequently not this.
    expect(text).toContain('path=""');
    expect(text).not.toContain(`path="${UPLOADS}`);
  });

  test('three same-named attachments keep three identities', () => {
    // Three pasted screenshots are all named `image.png` (clipboard-files.ts).
    // The transcript keys a sent tile by its identity, never by its name.
    const text = buildOptimisticPromptTextWithUploads('three shots', [
      localFile('image.png', 'image/png', 'upload-a'),
      localFile('image.png', 'image/png', 'upload-b'),
      localFile('image.png', 'image/png', 'upload-c'),
    ]);

    const { files } = parseFileReferences(text);
    expect(files.map((f) => f.attachment)).toEqual(['upload-a', 'upload-b', 'upload-c']);
  });

  test('an empty browser mime falls back to the extension, not octet-stream', () => {
    // `.md`, `.csv` and some platforms' `.png` arrive with `type === ''`. The
    // transcript gates the picture on `mime.startsWith('image/')`, so the same
    // PNG was a thumbnail in the composer and a generic icon in the transcript.
    expect(optimisticUploadedFileRef(localFile('shot.png', '')).mime).toBe('image/png');
    expect(optimisticUploadedFileRef(localFile('notes.md', '')).mime).toBe('text/markdown');
    expect(optimisticUploadedFileRef(localFile('rows.csv', '')).mime).toBe('text/csv');
    // An unknown extension still has an honest answer.
    expect(optimisticUploadedFileRef(localFile('blob.qqq', '')).mime).toBe(
      'application/octet-stream',
    );
  });
});

describe('promptFileParts', () => {
  const ready = (id: string, filename: string): SessionPromptPart => ({
    type: 'file',
    attachment_id: id,
    filename,
    mime: 'text/plain',
  });

  test('composer files take their ready handles and remote files ride as URL parts, in attachment order', () => {
    const parts = promptFileParts(
      [
        localFile('first.txt', 'text/plain', 'local-first'),
        remoteFile('second.pdf'),
        localFile('third.txt', 'text/plain', 'local-third'),
      ],
      [ready('att-first', 'first.txt'), ready('att-third', 'third.txt')],
    );

    expect(parts.map((part) => part.filename)).toEqual(['first.txt', 'second.pdf', 'third.txt']);
    expect(parts.map((part) => part.attachment_id ?? part.url)).toEqual([
      'att-first',
      'https://files.example/remote.pdf',
      'att-third',
    ]);
    // Handle-only: no bytes and no data URL ride the prompt.
    expect(JSON.stringify(parts)).not.toContain('data:');
  });

  test('a local file with no ready handle is refused: Send never uploads bytes itself', () => {
    expect(() => promptFileParts([localFile('legacy.txt')], [])).toThrow(
      'A staged attachment is missing its completed upload handle',
    );
    expect(() => promptFileParts([localFile('a.txt', 'text/plain', 'local-a')], [])).toThrow(
      'A staged attachment is missing its completed upload handle',
    );
  });

  test('a ready handle that no file claims means the selection changed', () => {
    expect(() => promptFileParts([], [ready('att-a', 'a.txt')])).toThrow(
      'Attachment selection changed before Send. Try again.',
    );
  });

  test('no files → no parts', () => {
    expect(promptFileParts(undefined, [])).toEqual([]);
    expect(promptFileParts([], [])).toEqual([]);
  });
});
