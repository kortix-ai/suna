import { describe, expect, test } from 'bun:test';

import type { SessionPromptPart } from '@kortix/sdk';
import {
  captureAttachmentSubmission,
  planAttachmentReplacement,
  retainAttachmentPreviews,
  stageComposerFiles,
} from './attachment-submission';
import type { AttachedFile } from './types';

const readyPart = (id: string, filename: string): SessionPromptPart => ({
  type: 'file',
  attachment_id: id,
  filename,
  mime: 'text/plain',
});

const selectedFile = (
  uploadId: string,
  filename: string,
): Extract<AttachedFile, { kind: 'local' }> => ({
  kind: 'local',
  uploadId,
  file: new File(['ready'], filename, { type: 'text/plain' }),
  localUrl: `blob:${uploadId}`,
  isImage: false,
});

describe('captureAttachmentSubmission', () => {
  test('calls the synchronous readiness gate and preserves selected file order', () => {
    const calls: string[] = [];
    const files = [selectedFile('local-b', 'b.txt'), selectedFile('local-a', 'a.txt')];
    const result = captureAttachmentSubmission(files, {
      getReadyParts: () => {
        calls.push('ready');
        return [readyPart('att-a', 'a.txt'), readyPart('att-b', 'b.txt')];
      },
      getSnapshot: () => ({
        canSend: true,
        attachments: [
          {
            id: 'local-a',
            filename: 'a.txt',
            mime: 'text/plain',
            size: 5,
            status: 'ready',
            receivedBytes: 5,
            attachment: {
              attachment_id: 'att-a',
              filename: 'a.txt',
              mime: 'text/plain',
              size: 5,
              expires_at: '2099-01-01T00:00:00.000Z',
            },
          },
          {
            id: 'local-b',
            filename: 'b.txt',
            mime: 'text/plain',
            size: 5,
            status: 'ready',
            receivedBytes: 5,
            attachment: {
              attachment_id: 'att-b',
              filename: 'b.txt',
              mime: 'text/plain',
              size: 5,
              expires_at: '2099-01-01T00:00:00.000Z',
            },
          },
        ],
      }),
    });

    expect(calls).toEqual(['ready']);
    expect(result.submittedIds).toEqual(['local-b', 'local-a']);
    expect(result.parts.map((part) => part.attachment_id)).toEqual(['att-b', 'att-a']);
  });

  test('propagates a pending readiness refusal before producing parts', () => {
    expect(() =>
      captureAttachmentSubmission([selectedFile('local-a', 'a.txt')], {
        getReadyParts: () => {
          throw new Error('Wait for attachments to finish uploading');
        },
        getSnapshot: () => ({ canSend: false, attachments: [] }),
      }),
    ).toThrow('Wait for attachments to finish uploading');
  });

  test('captures only selected ids so a later upload survives successful handoff', () => {
    const files = [selectedFile('submitted', 'submitted.txt')];
    const result = captureAttachmentSubmission(files, {
      getReadyParts: () => [readyPart('att-submitted', 'submitted.txt')],
      getSnapshot: () => ({
        canSend: true,
        attachments: [
          {
            id: 'submitted',
            filename: 'submitted.txt',
            mime: 'text/plain',
            size: 5,
            status: 'ready',
            receivedBytes: 5,
            attachment: {
              attachment_id: 'att-submitted',
              filename: 'submitted.txt',
              mime: 'text/plain',
              size: 5,
              expires_at: '2099-01-01T00:00:00.000Z',
            },
          },
          {
            id: 'later',
            filename: 'later.txt',
            mime: 'text/plain',
            size: 5,
            status: 'ready',
            receivedBytes: 5,
            attachment: {
              attachment_id: 'att-later',
              filename: 'later.txt',
              mime: 'text/plain',
              size: 5,
              expires_at: '2099-01-01T00:00:00.000Z',
            },
          },
        ],
      }),
    });

    expect(result.submittedIds).toEqual(['submitted']);
    expect(result.parts.map((part) => part.attachment_id)).toEqual(['att-submitted']);
  });
});

describe('stageComposerFiles', () => {
  test('validates the whole batch before creating any object URL', () => {
    const events: string[] = [];
    const files = [
      new File(['a'], 'a.txt', { type: 'text/plain' }),
      new File(['b'], 'b.txt', { type: 'text/plain' }),
    ];

    const attached = stageComposerFiles(files, {
      addMany: (selected) => {
        events.push(`add:${selected.map((file) => file.name).join(',')}`);
        return ['upload-a', 'upload-b'];
      },
      createObjectURL: (file) => {
        events.push(`url:${file.name}`);
        return `blob:${file.name}`;
      },
      isImage: () => false,
    });

    expect(events).toEqual(['add:a.txt,b.txt', 'url:a.txt', 'url:b.txt']);
    expect(attached.map((file) => file.kind === 'local' && file.uploadId)).toEqual([
      'upload-a',
      'upload-b',
    ]);
  });

  test('creates no object URLs when synchronous batch validation fails', () => {
    let objectUrls = 0;
    expect(() =>
      stageComposerFiles([new File(['x'], 'too-many.txt')], {
        addMany: () => {
          throw new Error('A message can contain up to 20 attachments');
        },
        createObjectURL: () => {
          objectUrls += 1;
          return 'blob:leaked';
        },
        isImage: () => false,
      }),
    ).toThrow('up to 20 attachments');
    expect(objectUrls).toBe(0);
  });
});

describe('retainAttachmentPreviews', () => {
  test('gives an accepted optimistic image its own blob URL while preserving File identity', () => {
    const file = selectedFile('upload-image', 'image.png');
    const retained = retainAttachmentPreviews(
      [file],
      (selected) => `blob:retained-${selected.name}`,
    );

    expect(retained).toEqual([{ ...file, localUrl: 'blob:retained-image.png' }]);
    const retainedFile = retained[0];
    expect(retainedFile?.kind).toBe('local');
    if (retainedFile?.kind !== 'local') throw new Error('expected a local preview');
    expect(retainedFile.file).toBe(file.file);
  });
});

describe('planAttachmentReplacement', () => {
  test('removes superseded SDK entries and URLs but preserves active submissions', () => {
    const removed = selectedFile('removed', 'removed.txt');
    const active = selectedFile('active', 'active.txt');
    const kept = selectedFile('kept', 'kept.txt');
    expect(planAttachmentReplacement([removed, active, kept], [kept], new Set(['active']))).toEqual(
      {
        idsToRemove: ['removed'],
        urlsToRevoke: ['blob:removed'],
      },
    );
  });
});
