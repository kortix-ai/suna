import { describe, expect, test } from 'bun:test';

import { previewFailure } from './preview-failure';

describe('previewFailure', () => {
  test('a 404 means the file is gone: no retry', () => {
    const failure = previewFailure(new Error('Failed to read file: 404'), true);
    expect(failure.kind).toBe('missing');
    expect(failure.canRetry).toBe(false);
    expect(failure.message).toBe('This file is no longer in the sandbox. It was moved or deleted.');
  });

  test('no sandbox URL means the session is not connected', () => {
    const failure = previewFailure(null, false);
    expect(failure.kind).toBe('unreachable');
    expect(failure.canRetry).toBe(true);
    expect(failure.message).toBe('The sandbox is not connected. It may be asleep or starting up.');
  });

  test('a gateway or server status means the sandbox did not answer', () => {
    for (const status of [500, 502, 503, 504]) {
      const failure = previewFailure(new Error(`Failed to load file: ${status}`), true);
      expect(failure.kind).toBe('unreachable');
      expect(failure.canRetry).toBe(true);
      expect(failure.status).toBe(status);
    }
  });

  test('a network error has no status and can be retried', () => {
    const failure = previewFailure(new TypeError('Network request failed'), true);
    expect(failure.kind).toBe('unreachable');
    expect(failure.status).toBeNull();
    expect(failure.canRetry).toBe(true);
  });

  test('a refused request names access, with no retry', () => {
    for (const status of [401, 403]) {
      const failure = previewFailure(new Error(`Failed to read file: ${status}`), true);
      expect(failure.kind).toBe('denied');
      expect(failure.canRetry).toBe(false);
    }
  });
});
