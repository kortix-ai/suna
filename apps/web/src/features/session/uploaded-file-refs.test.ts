import { describe, expect, test } from 'bun:test';

import type { AttachedFile } from '@/features/session/session-chat-input';
import {
  buildOptimisticPromptTextWithUploads,
  buildPromptPartsWithUploads,
  optimisticUploadedFileRef,
  optimisticUploadPath,
  sanitizeUploadFilename,
  uploadedFileRefXml,
  UPLOADS_DIR,
  type UploadFileForPrompt,
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

describe('uploaded file references', () => {
  test('sanitizes upload filenames for the daemon multipart filename', () => {
    expect(sanitizeUploadFilename('Project Veyris #1.zip')).toBe('Project_Veyris__1.zip');
    expect(sanitizeUploadFilename('')).toBe('upload');
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
        filename: 'Project_Veyris__1.zip',
      },
    ]);
    expect(result.remoteParts).toEqual([]);
    expect(result.text).toContain('analyze this');
    expect(result.text).toContain(`path="${UPLOADS_DIR}/actual.zip"`);
    expect(result.text).toContain('filename="Project Veyris #1.zip"');
    expect(result.text).not.toContain('Project_Veyris__1.zip"');
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

  test('uses the same sanitized path for optimistic previews only', () => {
    expect(optimisticUploadPath(localFile('a b.txt'))).toBe('/workspace/uploads/a_b.txt');
  });

  test('builds optimistic file refs for shell rendering', () => {
    expect(optimisticUploadedFileRef(localFile('a b.txt'))).toEqual({
      path: '/workspace/uploads/a_b.txt',
      mime: localFile('a b.txt').file.type,
      filename: 'a b.txt',
    });
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
    expect(text).toContain('path="/workspace/uploads/Screenshot_2026.png"');
    expect(text).toContain('filename="Screenshot 2026.png"');
  });
});
