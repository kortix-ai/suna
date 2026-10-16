import { describe, expect, test } from 'bun:test';
import type { PromptAttachment, PromptAttachmentItem } from '@kortix/sdk';

import type { AttachedFile } from '../types';
import {
  finishedDraftUploads,
  keepUnsentUploadFile,
  restoreDraftUploads,
  takeUnsentUploadFile,
} from './draft-uploads';

const attachment: PromptAttachment = {
  attachment_id: 'att-1',
  filename: 'shot.png',
  mime: 'image/png',
  size: 3,
  expires_at: '2099-01-01T00:00:00.000Z',
};
const file = new File(['abc'], 'shot.png', { type: 'image/png' });
const item = (id: string, status: PromptAttachmentItem['status'], done?: PromptAttachment): PromptAttachmentItem => ({
  id,
  file,
  filename: 'shot.png',
  mime: 'image/png',
  size: 3,
  status,
  receivedBytes: status === 'ready' ? 3 : 0,
  ...(done ? { attachment: done } : {}),
});

describe('finishedDraftUploads', () => {
  test('keeps only finished uploads, with their File for this tab', () => {
    const tray: AttachedFile[] = [
      { kind: 'local', uploadId: 'u-1', file, localUrl: 'blob:1', isImage: true },
      { kind: 'local', uploadId: 'u-2', file, localUrl: 'blob:2', isImage: true },
      { kind: 'remote', url: 'https://example.test/a.png', filename: 'a.png', mime: 'image/png', isImage: true },
    ];
    expect(
      finishedDraftUploads(tray, [item('u-1', 'ready', attachment), item('u-2', 'uploading')]),
    ).toEqual([{ uploadId: 'u-1', upload: { ...attachment, isImage: true }, file }]);
  });

  test('a restored upload with no File is kept too', () => {
    const tray: AttachedFile[] = [
      { kind: 'uploaded', uploadId: 'u-3', filename: 'shot.png', mime: 'image/png', isImage: false },
    ];
    expect(finishedDraftUploads(tray, [{ ...item('u-3', 'ready', attachment), file: undefined }])).toEqual([
      { uploadId: 'u-3', upload: { ...attachment, isImage: false } },
    ]);
  });
});

describe('restoreDraftUploads', () => {
  test('a File this tab kept brings the picture back; without one the tile has the name only', () => {
    const restored: { attachment: PromptAttachment; file?: File }[] = [];
    const second = { ...attachment, attachment_id: 'att-2', filename: 'notes.png' };
    keepUnsentUploadFile('att-1', file);
    const tray = restoreDraftUploads([
      { ...attachment, isImage: true },
      { ...second, isImage: true },
      { ...attachment, attachment_id: 'att-expired', isImage: true },
    ], {
      restore: (uploads) => {
        restored.push(...uploads);
        return ['u-1', 'u-2', undefined];
      },
      createObjectURL: () => 'blob:restored',
    });
    expect(restored.map((upload) => [upload.attachment.attachment_id, upload.file])).toEqual([
      ['att-1', file],
      ['att-2', undefined],
      ['att-expired', undefined],
    ]);
    expect(tray).toEqual([
      { kind: 'local', uploadId: 'u-1', file, localUrl: 'blob:restored', isImage: true },
      { kind: 'uploaded', uploadId: 'u-2', filename: 'notes.png', mime: 'image/png', isImage: false },
    ]);
    // A File is handed back once.
    expect(takeUnsentUploadFile('att-1')).toBeUndefined();
  });
});
