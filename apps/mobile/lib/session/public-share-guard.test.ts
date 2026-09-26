import { describe, expect, test } from 'bun:test';

import { NON_TRANSCRIPT_SHARE_MESSAGE, guardTranscriptShare } from './public-share-guard';

describe('guardTranscriptShare', () => {
  test('a transcript share is ok and needs no revoke', () => {
    expect(guardTranscriptShare({ resource_type: 'transcript' })).toEqual({
      ok: true,
      shouldRevoke: false,
      message: null,
    });
  });

  test('a preview share (old server ignoring `transcript: true`) is revoked, never shared', () => {
    expect(guardTranscriptShare({ resource_type: 'preview' })).toEqual({
      ok: false,
      shouldRevoke: true,
      message: NON_TRANSCRIPT_SHARE_MESSAGE,
    });
  });

  test('a file share is revoked, never shared', () => {
    expect(guardTranscriptShare({ resource_type: 'file' })).toEqual({
      ok: false,
      shouldRevoke: true,
      message: NON_TRANSCRIPT_SHARE_MESSAGE,
    });
  });

  test('an unknown resource_type is revoked, never shared', () => {
    expect(guardTranscriptShare({ resource_type: 'something-new' })).toEqual({
      ok: false,
      shouldRevoke: true,
      message: NON_TRANSCRIPT_SHARE_MESSAGE,
    });
  });
});
