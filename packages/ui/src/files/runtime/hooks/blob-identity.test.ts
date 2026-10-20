import { describe, expect, test } from 'bun:test';

import { keepBlobIfUnchanged } from './blob-identity';

// The agent's turn end refetches every open file. A refetch that returns the
// same bytes must not reload the viewer: a playing video would restart and a
// deck would jump back to slide one for a file the agent never touched.
describe('keepBlobIfUnchanged', () => {
  const blob = (text: string, type = 'application/octet-stream') => new Blob([text], { type });

  test('returns the cached Blob when the refetched bytes are identical', async () => {
    const cached = blob('same bytes');
    expect(await keepBlobIfUnchanged(cached, blob('same bytes'))).toBe(cached);
  });

  test('returns the new Blob when the bytes changed', async () => {
    const next = blob('agent wrote this');
    expect(await keepBlobIfUnchanged(blob('before the turn'), next)).toBe(next);
  });

  test('returns the new Blob when only one byte of equal-length content changed', async () => {
    const next = blob('abcdef');
    expect(await keepBlobIfUnchanged(blob('abcdeX'), next)).toBe(next);
  });

  test('returns the new Blob when the mime type changed', async () => {
    const next = blob('x', 'image/png');
    expect(await keepBlobIfUnchanged(blob('x', 'image/jpeg'), next)).toBe(next);
  });

  test('returns the new Blob on the first load', async () => {
    const next = blob('first');
    expect(await keepBlobIfUnchanged(undefined, next)).toBe(next);
  });
});
