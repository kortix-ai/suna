import { describe, expect, test } from 'bun:test';
import { isOfflineUploadError } from './avatar-upload-error';

// KRTX-2838: a failed request on a flaky connection surfaced as the raw
// browser text "Failed to fetch". These are the network-level failures each
// browser reports; a storage error the server sent stays as it is.
describe('isOfflineUploadError', () => {
  test("each browser's network failure, raw or wrapped by the storage client", () => {
    for (const message of ['Failed to fetch', 'Load failed', 'NetworkError when attempting to fetch resource.', 'Network request failed']) {
      expect(isOfflineUploadError(new TypeError(message))).toBe(true);
      // storage-js wraps a fetch failure in a StorageUnknownError with the same message.
      expect(isOfflineUploadError(Object.assign(new Error(message), { name: 'StorageUnknownError' }))).toBe(true);
    }
  });

  test('a storage or auth error the server answered is not a network failure', () => {
    expect(isOfflineUploadError(new Error('The object exceeded the maximum allowed size'))).toBe(false);
    expect(isOfflineUploadError(new Error('new row violates row-level security policy'))).toBe(false);
    expect(isOfflineUploadError(null)).toBe(false);
  });
});
