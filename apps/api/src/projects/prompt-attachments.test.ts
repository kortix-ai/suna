import { describe, expect, test } from 'bun:test';
import { readPromptAttachmentChunk, validatePromptAttachmentRows } from './prompt-attachments';

const scope = { accountId: 'account', projectId: 'project', userId: 'user' };
const now = new Date('2026-09-08T00:00:00Z');
const row = {
  attachmentId: '123e4567-e89b-42d3-a456-426614174000',
  ...scope,
  filename: 'canonical.txt',
  mime: 'text/plain',
  sizeBytes: 12,
  status: 'ready',
  expiresAt: new Date(now.getTime() + 1000),
  sha256: 'a'.repeat(64),
};

describe('prompt attachment binding', () => {
  test('uses canonical metadata for a ready attachment owned by the caller', () => {
    expect(validatePromptAttachmentRows([row], [row.attachmentId], scope, now)).toEqual([row]);
  });
  test.each(['accountId', 'projectId', 'userId'] as const)(
    'rejects foreign %s without revealing metadata',
    (key) => {
      expect(() =>
        validatePromptAttachmentRows(
          [{ ...row, [key]: 'foreign' }],
          [row.attachmentId],
          scope,
          now,
        ),
      ).toThrow('Attachment not found');
    },
  );
  test('rejects missing, expired, incomplete and duplicate handles', () => {
    expect(() => validatePromptAttachmentRows([], [row.attachmentId], scope, now)).toThrow(
      'Attachment not found',
    );
    expect(() =>
      validatePromptAttachmentRows([{ ...row, expiresAt: now }], [row.attachmentId], scope, now),
    ).toThrow('expired');
    expect(() =>
      validatePromptAttachmentRows(
        [{ ...row, status: 'uploading' }],
        [row.attachmentId],
        scope,
        now,
      ),
    ).toThrow('incomplete');
    expect(() =>
      validatePromptAttachmentRows([row], [row.attachmentId, row.attachmentId], scope, now),
    ).toThrow('Duplicate');
  });
  test('rejects file, count and aggregate limits using stored sizes', () => {
    expect(() =>
      validatePromptAttachmentRows(
        [{ ...row, sizeBytes: 50 * 1024 * 1024 + 1 }],
        [row.attachmentId],
        scope,
        now,
      ),
    ).toThrow('50 MiB');
    const rows = Array.from({ length: 21 }, (_, i) => ({
      ...row,
      attachmentId: String(i),
      sizeBytes: 50 * 1024 * 1024,
    }));
    expect(() =>
      validatePromptAttachmentRows(
        rows,
        rows.map((r) => r.attachmentId),
        scope,
        now,
      ),
    ).toThrow('20 files');
    expect(() =>
      validatePromptAttachmentRows(rows.slice(0, 3), ['0', '1', '2'], scope, now),
    ).toThrow('100 MiB');
    expect(validatePromptAttachmentRows(rows.slice(0, 2), ['0', '1'], scope, now)).toHaveLength(2);
  });
});

describe('bounded attachment ingress', () => {
  test('reads actual bytes and rejects an oversized chunk even without Content-Length', async () => {
    const request = (size: number) =>
      new Request('http://localhost/upload', { method: 'PUT', body: new Uint8Array(size) });
    expect((await readPromptAttachmentChunk(request(65536))).byteLength).toBe(65536);
    await expect(readPromptAttachmentChunk(request(65537))).rejects.toThrow('64 KiB');
    await expect(readPromptAttachmentChunk(request(0))).rejects.toThrow('empty');
  });
  test('rejects cancellation after a partial body instead of accepting the partial chunk', async () => {
    const controller = new AbortController();
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(stream) {
        if (pulls++ === 0) stream.enqueue(new Uint8Array([1]));
        else {
          controller.abort();
          stream.close();
        }
      },
    });
    const request = new Request('http://localhost/upload', {
      method: 'PUT',
      body,
      signal: controller.signal,
    });
    await expect(readPromptAttachmentChunk(request)).rejects.toThrow('cancelled');
  });
});
