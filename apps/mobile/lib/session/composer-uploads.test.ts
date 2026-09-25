import { describe, expect, test } from 'bun:test';

import {
  SEND_UPLOAD_WAIT_MS,
  STILL_READING_MESSAGE,
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
