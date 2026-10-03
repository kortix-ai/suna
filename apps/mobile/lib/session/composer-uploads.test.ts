import { describe, expect, test } from 'bun:test';
import type { PromptAttachmentItem, PromptAttachmentSnapshot } from '@kortix/sdk';

import type { AttachedFile } from './attachments';
import {
  SEND_UPLOAD_WAIT_MS,
  STILL_READING_MESSAGE,
  buildComposerUploads,
  composerUploadState,
  stillReadingError,
  uploadErrorMessage,
} from './composer-uploads';

describe('composerUploadState', () => {
  test('no controller item yet shows a 0% ring', () => {
    expect(composerUploadState(undefined)).toEqual({ progress: 0 });
  });

  test('uploading reports floor percent capped at 99', () => {
    expect(composerUploadState({ status: 'uploading', receivedBytes: 50, size: 100 })).toEqual({
      progress: 50,
    });
    expect(composerUploadState({ status: 'uploading', receivedBytes: 100, size: 100 })).toEqual({
      progress: 99,
    });
  });

  test('pending reports floor percent capped at 99', () => {
    expect(composerUploadState({ status: 'pending', receivedBytes: 0, size: 100 })).toEqual({
      progress: 0,
    });
  });

  test('processing is pinned at 99', () => {
    expect(composerUploadState({ status: 'processing', receivedBytes: 100, size: 100 })).toEqual({
      progress: 99,
    });
  });

  test('ready shows no ring', () => {
    expect(composerUploadState({ status: 'ready', receivedBytes: 100, size: 100 })).toBeUndefined();
  });

  test('error and aborted show the failure scrim', () => {
    expect(composerUploadState({ status: 'error', receivedBytes: 0, size: 100 })).toEqual({
      failed: true,
    });
    expect(composerUploadState({ status: 'aborted', receivedBytes: 0, size: 100 })).toEqual({
      failed: true,
    });
  });
});

describe('uploadErrorMessage', () => {
  test('maps attachment_expired, TIMEOUT, and a generic error', () => {
    expect(uploadErrorMessage({ code: 'attachment_expired' })).toBe(
      'Attachment expired. Attach the file again.',
    );
    expect(uploadErrorMessage({ code: 'TIMEOUT' })).toBe('The upload is taking too long. Try again.');
    expect(uploadErrorMessage(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe(
      'The upload is taking too long. Try again.',
    );
    expect(uploadErrorMessage(new Error('boom'), 'photo_1.jpg')).toBe(
      "Couldn't attach photo_1.jpg. Try again.",
    );
    expect(uploadErrorMessage(new Error('boom'))).toBe("Couldn't attach the file. Try again.");
  });
});

test('a file still being read keeps its own message', () => {
  expect(uploadErrorMessage(stillReadingError())).toBe(STILL_READING_MESSAGE);
  expect(STILL_READING_MESSAGE).toBe('Still reading a file. Try again in a moment.');
});

test('SEND_UPLOAD_WAIT_MS is 120s', () => {
  expect(SEND_UPLOAD_WAIT_MS).toBe(120_000);
});

describe('buildComposerUploads', () => {
  const retried: string[] = [];
  const sources = {
    subscribe: (listener: () => void) => () => listener === undefined,
    retry: (id: string) => retried.push(id),
  };
  const file = (uploadId?: string): AttachedFile => ({
    uri: 'file:///a.png',
    name: 'a.png',
    mimeType: 'image/png',
    isImage: true,
    uploadId,
  });
  const item = (over: Partial<PromptAttachmentItem>): PromptAttachmentItem => ({
    id: 'u1',
    filename: 'a.png',
    mime: 'image/png',
    size: 100,
    status: 'uploading',
    receivedBytes: 0,
    ...over,
  });
  const snapshot = (attachments: PromptAttachmentItem[]): PromptAttachmentSnapshot => ({ attachments });

  test('a failed upload carries onRetry for its id; running carries the live source', () => {
    let snaps = snapshot([item({ status: 'error' })]);
    const failed = buildComposerUploads([file('u1')], () => snaps, sources);
    expect(failed[0]).toEqual({ failed: true, onRetry: expect.any(Function) });
    failed[0]?.onRetry?.();
    expect(retried).toEqual(['u1']);

    snaps = snapshot([item({ receivedBytes: 40 })]);
    const running = buildComposerUploads([file('u1')], () => snaps, sources);
    expect(running[0]).toMatchObject({ progress: 40 });
    expect(running[0]?.live?.subscribe).toBe(sources.subscribe);

    // The live source reads the CURRENT snapshot, not the one at build time.
    snaps = snapshot([item({ receivedBytes: 80 })]);
    expect(running[0]?.live?.getProgress()).toBe(80);
  });

  test('a ready upload is absent, and a file still being read shows 0% without a live source', () => {
    const ready = buildComposerUploads([file('u1')], () => snapshot([item({ status: 'ready', receivedBytes: 100 })]), sources);
    expect(ready).toEqual({});

    const unread = buildComposerUploads([file()], () => snapshot([]), sources);
    expect(unread).toEqual({ 0: { progress: 0 } });
    expect(unread[0]?.live).toBeUndefined();
  });
});
