import { describe, expect, test } from 'bun:test';

import {
  UPLOADED_FILE_READ_MAX_RETRIES,
  UPLOADED_FILE_READ_RETRY_DELAY_MS,
  fileReadRetryDelayMs,
  isUploadedWorkspacePath,
  shouldRetryFileRead,
} from './file-read-retry';

describe('file read retry policy', () => {
  test('detects uploaded workspace paths', () => {
    expect(isUploadedWorkspacePath('/workspace/uploads/report.pdf')).toBe(true);
    expect(isUploadedWorkspacePath('workspace/uploads/report.pdf')).toBe(true);
    expect(isUploadedWorkspacePath('/workspace/src/report.pdf')).toBe(false);
    expect(isUploadedWorkspacePath(null)).toBe(false);
  });

  test('keeps uploaded file reads retrying through the startup grace window', () => {
    const err = new Error('File not found');

    expect(UPLOADED_FILE_READ_MAX_RETRIES).toBe(30);
    expect(shouldRetryFileRead('/workspace/uploads/report.pdf', 0, err)).toBe(true);
    expect(
      shouldRetryFileRead(
        '/workspace/uploads/report.pdf',
        UPLOADED_FILE_READ_MAX_RETRIES - 1,
        err,
      ),
    ).toBe(true);
    expect(
      shouldRetryFileRead('/workspace/uploads/report.pdf', UPLOADED_FILE_READ_MAX_RETRIES, err),
    ).toBe(false);
  });

  test('does not retry ordinary permanent missing-file reads', () => {
    expect(shouldRetryFileRead('/workspace/src/missing.ts', 0, new Error('File not found'))).toBe(
      false,
    );
  });

  test('uses a fixed uploaded-file retry delay without changing normal backoff', () => {
    expect(fileReadRetryDelayMs(4, '/workspace/uploads/report.pdf')).toBe(
      UPLOADED_FILE_READ_RETRY_DELAY_MS,
    );
    expect(fileReadRetryDelayMs(0, '/workspace/src/report.pdf')).toBe(1000);
    expect(fileReadRetryDelayMs(4, '/workspace/src/report.pdf')).toBe(5000);
  });
});
