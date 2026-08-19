import { describe, expect, test } from 'bun:test';

import { parseFileReferences } from '@/features/session/message-parsing';
import type { AttachedFile } from '@/features/session/session-chat-input';
import {
  buildOptimisticPromptTextWithUploads,
  buildPromptPartsWithUploads,
  MAX_UPLOAD_FILENAME_BYTES,
  optimisticUploadedFileRef,
  sanitizeUploadFilename,
  UploadBatchError,
  uploadedFileRefXml,
  UPLOADS_DIR,
  type UploadFileForPrompt,
  attachedFilesToDataUrlParts,
  DATA_URL_ATTACHMENTS_MAX_BYTES,
} from './uploaded-file-refs';

function localFile(name: string, type = 'text/plain'): Extract<AttachedFile, { kind: 'local' }> {
  return {
    kind: 'local',
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

  test('builds text refs from actual returned upload paths', async () => {
    const uploadCalls: Array<{ originalName: string; targetPath?: string; filename?: string }> = [];
    const upload: UploadFileForPrompt = async (file, targetPath, filename) => {
      uploadCalls.push({ originalName: (file as File).name, targetPath, filename });
      return [{ path: `${targetPath}/actual.zip`, size: 5 }];
    };

    const result = await buildPromptPartsWithUploads(
      'analyze this',
      [localFile('Project Veyris #1.zip', 'application/zip')],
      upload,
    );

    expect(uploadCalls).toEqual([
      {
        originalName: 'Project Veyris #1.zip',
        targetPath: UPLOADS_DIR,
        filename: 'Project Veyris #1.zip',
      },
    ]);
    expect(result.remoteParts).toEqual([]);
    expect(result.text).toContain('analyze this');
    expect(result.text).toContain(`path="${UPLOADS_DIR}/actual.zip"`);
    expect(result.text).toContain('filename="Project Veyris #1.zip"');
  });

  test('the SERVER path wins, even when it is nothing like the name we sent', async () => {
    // The daemon writes with `wx` and never overwrites: a name already present
    // in the session lands as `report-<suffix>.pdf`. Any client prediction is
    // wrong for every re-upload, so only the returned path may reach the prompt.
    const result = await buildPromptPartsWithUploads(
      'read it',
      [localFile('report.pdf')],
      async () => [{ path: `${UPLOADS_DIR}/report-mgk2x1-a3f9b201.pdf`, size: 5 }],
    );

    expect(result.text).toContain(`path="${UPLOADS_DIR}/report-mgk2x1-a3f9b201.pdf"`);
    expect(result.text).not.toContain(`path="${UPLOADS_DIR}/report.pdf"`);
  });

  test('keeps remote files as file parts without uploading them', async () => {
    const result = await buildPromptPartsWithUploads('read remote', [remoteFile()], async () => {
      throw new Error('should not upload remote files');
    });

    expect(result.text).toBe('read remote');
    expect(result.remoteParts).toEqual([
      {
        type: 'file',
        mime: 'application/pdf',
        url: 'https://files.example/remote.pdf',
        filename: 'remote.pdf',
      },
    ]);
  });

  test('fails before producing optimistic file references when upload has no path', async () => {
    await expect(
      buildPromptPartsWithUploads('send', [localFile('missing.txt')], async () => [
        { path: '', size: 5 },
      ]),
    ).rejects.toThrow('did not return a file path');
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
      const path = `${UPLOADS_DIR}/${filename}`;
      const xml = uploadedFileRefXml({ path, mime: 'text/plain', filename });
      const { files, cleanText } = parseFileReferences(`look\n\n${xml}`);

      expect(files).toHaveLength(1);
      expect(files[0].filename).toBe(filename);
      expect(files[0].path).toBe(path);
      expect(files[0].mime).toBe('text/plain');
      expect(cleanText).toBe('look');
    }
  });

  test('an optimistic ref carries no path — only a per-attachment id', () => {
    const ref = optimisticUploadedFileRef(localFile('a b.txt'), 2);
    expect(ref.path).toBe('');
    expect(ref.pendingId).toBe('upl_2');
    expect(ref.filename).toBe('a b.txt');
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
      localFile('Screenshot 2026.png', 'image/png'),
    ]);

    expect(text).toContain('look at these');
    expect(text).toContain('filename="Screenshot 2026.png"');
    expect(text).toContain('pending="upl_0"');
    // No guessed path. The daemon assigns it, and it is frequently not this.
    expect(text).toContain('path=""');
    expect(text).not.toContain(`path="${UPLOADS_DIR}`);
  });

  test('two attachments whose names sanitize alike get DIFFERENT ids', () => {
    // Three pasted screenshots are all named `image.png` (clipboard-files.ts),
    // and `my report.pdf` / `my/report.pdf` both used to predict
    // `/workspace/uploads/my_report.pdf`. The transcript keys uploads by that
    // value, so identical predictions became duplicate React keys.
    const text = buildOptimisticPromptTextWithUploads('three shots', [
      localFile('image.png', 'image/png'),
      localFile('image.png', 'image/png'),
      localFile('image.png', 'image/png'),
    ]);

    const { files } = parseFileReferences(text);
    expect(files.map((f) => f.pending)).toEqual(['upl_0', 'upl_1', 'upl_2']);
    expect(new Set(files.map((f) => f.pending)).size).toBe(3);
  });

  test('optimistic and real refs disagree about the path, and the real one is used', async () => {
    const file = localFile('image.png', 'image/png');
    const optimistic = parseFileReferences(buildOptimisticPromptTextWithUploads('shot', [file]));
    const settled = await buildPromptPartsWithUploads('shot', [file], async () => [
      { path: `${UPLOADS_DIR}/image-mgk2x1-a3f9b201.png`, size: 5 },
    ]);

    expect(optimistic.files[0].path).toBe('');
    expect(parseFileReferences(settled.text).files[0].path).toBe(
      `${UPLOADS_DIR}/image-mgk2x1-a3f9b201.png`,
    );
  });

  test('an empty browser mime falls back to the extension, not octet-stream', async () => {
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

    const settled = await buildPromptPartsWithUploads(
      'look',
      [localFile('shot.png', '')],
      async () => [{ path: `${UPLOADS_DIR}/shot.png`, size: 5 }],
    );
    expect(settled.text).toContain('mime="image/png"');
  });

  test('one failed upload does not discard the ones that succeeded', async () => {
    const uploaded: string[] = [];
    const upload: UploadFileForPrompt = async (file) => {
      const name = (file as File).name;
      if (name === 'bad.pdf') throw new Error('Upload failed (413): Payload Too Large');
      uploaded.push(name);
      return [{ path: `${UPLOADS_DIR}/${name}`, size: 5 }];
    };

    const files = [localFile('a.txt'), localFile('bad.pdf'), localFile('c.txt')];
    const error = (await buildPromptPartsWithUploads('send', files, upload).catch(
      (e) => e,
    )) as UploadBatchError;

    // `Promise.all` short-circuited, so the siblings' bytes were already on disk
    // with nothing tracking them. Every attempt is accounted for now.
    expect(uploaded).toEqual(['a.txt', 'c.txt']);
    expect(error).toBeInstanceOf(UploadBatchError);
    expect(error.failures).toEqual([
      { filename: 'bad.pdf', reason: 'Upload failed (413): Payload Too Large' },
    ]);
    // The message NAMES the file and the reason — "Upload failed" alone leaves
    // the user guessing which of three attachments to remove.
    expect(error.message).toContain('bad.pdf');
    expect(error.message).toContain('413');
    expect(error.uploaded.map((f) => f.filename)).toEqual(['a.txt', 'c.txt']);

    // The retry re-uploads ONLY the file that failed. The daemon never
    // overwrites, so re-sending the survivors would have orphaned a suffixed
    // duplicate of each, per attempt.
    const retry = await buildPromptPartsWithUploads('send', files, async (file) => [
      { path: `${UPLOADS_DIR}/${(file as File).name}`, size: 5 },
    ]);
    expect(uploaded).toEqual(['a.txt', 'c.txt']);
    expect(retry.text).toContain(`path="${UPLOADS_DIR}/a.txt"`);
    expect(retry.text).toContain(`path="${UPLOADS_DIR}/bad.pdf"`);
    expect(retry.text).toContain(`path="${UPLOADS_DIR}/c.txt"`);
  });

  test('every failure in a batch is named, not just the first', async () => {
    const files = [localFile('one.txt'), localFile('two.txt')];
    const error = (await buildPromptPartsWithUploads('send', files, async (file) => {
      throw new Error(`no route to ${(file as File).name}`);
    }).catch((e) => e)) as UploadBatchError;

    expect(error).toBeInstanceOf(UploadBatchError);
    expect(error.failures.map((f) => f.filename)).toEqual(['one.txt', 'two.txt']);
    expect(error.message).toContain('one.txt — no route to one.txt');
    expect(error.message).toContain('two.txt — no route to two.txt');
  });
});

describe('attachedFilesToDataUrlParts', () => {
  const local = (name: string, bytes: Uint8Array, type = 'image/png'): AttachedFile => ({
    kind: 'local',
    file: new File([bytes as unknown as BlobPart], name, { type }),
    localUrl: 'blob:x',
    isImage: type.startsWith('image/'),
  });

  test('a local file becomes a data-URL file part; a remote one rides as-is', async () => {
    const parts = await attachedFilesToDataUrlParts([
      local('shot.png', new Uint8Array([1, 2, 3])),
      { kind: 'remote', url: 'https://files.test/a.pdf', filename: 'a.pdf', mime: 'application/pdf', isImage: false },
    ]);

    expect(parts).toEqual([
      {
        type: 'file',
        mime: 'image/png',
        url: `data:image/png;base64,${Buffer.from([1, 2, 3]).toString('base64')}`,
        filename: 'shot.png',
      },
      { type: 'file', mime: 'application/pdf', url: 'https://files.test/a.pdf', filename: 'a.pdf' },
    ]);
  });

  test('refuses a batch over the cap with copy that names the way out', async () => {
    const big = local('big.bin', new Uint8Array(DATA_URL_ATTACHMENTS_MAX_BYTES + 1), 'application/octet-stream');
    await expect(attachedFilesToDataUrlParts([big])).rejects.toThrow(/after the session starts/i);
  });

  test('no files → no parts', async () => {
    expect(await attachedFilesToDataUrlParts(undefined)).toEqual([]);
    expect(await attachedFilesToDataUrlParts([])).toEqual([]);
  });
});
