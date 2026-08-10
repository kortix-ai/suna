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
    expect(isUploadedWorkspacePath('uploads/report.pdf')).toBe(true);
    expect(isUploadedWorkspacePath('/workspace/src/report.pdf')).toBe(false);
    expect(isUploadedWorkspacePath(null)).toBe(false);
  });

  test('keeps uploaded file reads retrying through the startup grace window', () => {
    const err = new Error('File not found');

    expect(UPLOADED_FILE_READ_MAX_RETRIES).toBe(30);
    expect(shouldRetryFileRead('/workspace/uploads/report.pdf', 0, err)).toBe(true);
    expect(
      shouldRetryFileRead('/workspace/uploads/report.pdf', UPLOADED_FILE_READ_MAX_RETRIES - 1, err),
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

  test('does not retry a directory read (400 "Path is a directory") — the .opencode loop', () => {
    // Reading a directory like `.opencode` as a file returns 400; it must fail
    // fast, not retry on a loop.
    expect(shouldRetryFileRead('.opencode', 0, new Error('Path is a directory'))).toBe(false);
    expect(shouldRetryFileRead('.opencode', 0, new Error('HTTP 400: Bad Request'))).toBe(false);
    const eisdir = new Error('EISDIR: illegal operation on a directory');
    expect(shouldRetryFileRead('.opencode', 0, eisdir)).toBe(false);
  });

  test('does not retry when the error carries a 4xx HTTP status', () => {
    const err = Object.assign(new Error('nope'), { status: 400 });
    expect(shouldRetryFileRead('/workspace/src/x.ts', 0, err)).toBe(false);
    const forbidden = Object.assign(new Error('nope'), { status: 403 });
    expect(shouldRetryFileRead('/workspace/src/x.ts', 0, forbidden)).toBe(false);
  });

  test('only retries missing-file 4xx errors for uploaded paths', () => {
    const missing = Object.assign(new Error('not found'), { status: 404 });
    expect(shouldRetryFileRead('/workspace/uploads/report.pdf', 0, missing)).toBe(true);
    const forbidden = Object.assign(new Error('forbidden'), { status: 403 });
    expect(shouldRetryFileRead('/workspace/uploads/report.pdf', 0, forbidden)).toBe(false);
    const badRequest = Object.assign(new Error('bad request'), { status: 400 });
    expect(shouldRetryFileRead('/workspace/uploads/report.pdf', 0, badRequest)).toBe(false);
    const conflicting = Object.assign(new Error('File not found'), { status: 403 });
    expect(shouldRetryFileRead('/workspace/uploads/report.pdf', 0, conflicting)).toBe(false);
    expect(shouldRetryFileRead('/workspace/uploads/report.pdf', 0, new Error('Forbidden'))).toBe(
      false,
    );
  });

  test('still retries a transient 5xx / 408 / 429', () => {
    const server = Object.assign(new Error('boom'), { status: 500 });
    expect(shouldRetryFileRead('/workspace/src/x.ts', 0, server)).toBe(true);
    const timeout = Object.assign(new Error('timeout'), { status: 408 });
    expect(shouldRetryFileRead('/workspace/src/x.ts', 0, timeout)).toBe(true);
    const rateLimited = Object.assign(new Error('slow down'), { status: 429 });
    expect(shouldRetryFileRead('/workspace/src/x.ts', 0, rateLimited)).toBe(true);
  });

  test('uses a fixed uploaded-file retry delay without changing normal backoff', () => {
    expect(fileReadRetryDelayMs(4, '/workspace/uploads/report.pdf')).toBe(
      UPLOADED_FILE_READ_RETRY_DELAY_MS,
    );
    expect(fileReadRetryDelayMs(0, '/workspace/src/report.pdf')).toBe(1000);
    expect(fileReadRetryDelayMs(4, '/workspace/src/report.pdf')).toBe(5000);
  });
});
