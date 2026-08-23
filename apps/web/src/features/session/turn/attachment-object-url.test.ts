import { afterEach, describe, expect, test } from 'bun:test';

import {
  __testing,
  attachmentDisplaySrc,
  releaseAttachmentObjectUrls,
  retainAttachmentObjectUrls,
} from './attachment-object-url';

// A 1×1 PNG — small, but a REAL base64 payload, so the decode path is the
// one a composer screenshot takes.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const DATA_URL = `data:image/png;base64,${PNG_B64}`;
/** The same PNG with one byte flipped — valid base64, different bytes. */
const PNG_B64_OTHER = PNG_B64.replace('AAAAEAAAAB', 'AAAAEAAAAC');

const filePart = (id: string, url: string, sessionID = 'ses_a') => ({
  id,
  sessionID,
  messageID: 'msg_1',
  type: 'file' as const,
  mime: 'image/png',
  filename: 'shot.png',
  url,
});

afterEach(() => {
  __testing.reset();
});

describe('attachmentDisplaySrc — a data URL is decoded ONCE into an object URL', () => {
  test('a data: URL becomes a blob: URL', () => {
    const src = attachmentDisplaySrc(filePart('prt_1', DATA_URL));
    expect(src.startsWith('blob:')).toBe(true);
  });

  test('the same part id gets the same object URL back — created once, reused', () => {
    const created: string[] = [];
    __testing.spyCreate((url) => created.push(url));
    const a = attachmentDisplaySrc(filePart('prt_1', DATA_URL));
    const b = attachmentDisplaySrc(filePart('prt_1', DATA_URL));
    expect(a).toBe(b);
    expect(created).toEqual([a]);
  });

  test('a different part id with the same bytes is its own entry', () => {
    const a = attachmentDisplaySrc(filePart('prt_1', DATA_URL));
    const b = attachmentDisplaySrc(filePart('prt_2', DATA_URL));
    expect(a).not.toBe(b);
  });

  test('a part whose data URL changed is re-decoded and the old URL revoked', () => {
    const revoked: string[] = [];
    __testing.spyRevoke((url) => revoked.push(url));
    const a = attachmentDisplaySrc(filePart('prt_1', DATA_URL));
    const b = attachmentDisplaySrc(filePart('prt_1', `data:image/png;base64,${PNG_B64_OTHER}`));
    expect(b).not.toBe(a);
    expect(revoked).toEqual([a]);
  });

  test('a non-data URL passes through untouched (https, blob, sandbox path, empty)', () => {
    expect(attachmentDisplaySrc(filePart('p', 'https://x/chart.png'))).toBe('https://x/chart.png');
    expect(attachmentDisplaySrc(filePart('p', 'blob:http://x/1'))).toBe('blob:http://x/1');
    expect(attachmentDisplaySrc(filePart('p', '/workspace/shot.png'))).toBe('/workspace/shot.png');
    expect(attachmentDisplaySrc(filePart('p', ''))).toBe('');
  });

  test('a data URL that is not base64 or does not decode stays a data URL', () => {
    expect(attachmentDisplaySrc(filePart('p', 'data:text/plain,hello'))).toBe(
      'data:text/plain,hello',
    );
    expect(attachmentDisplaySrc(filePart('p', 'data:image/png;base64,%%%not-base64'))).toBe(
      'data:image/png;base64,%%%not-base64',
    );
  });

  test('the decoded blob carries the data URL mime and the decoded byte length', () => {
    attachmentDisplaySrc(filePart('prt_1', DATA_URL));
    const blob = __testing.blobFor('prt_1');
    expect(blob?.type).toBe('image/png');
    expect(blob?.size).toBe(Buffer.from(PNG_B64, 'base64').byteLength);
  });
});

/** The last release revokes on the NEXT microtask (see the module header). */
const microtask = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe('session retain / release — URLs live while a chat holds the session', () => {
  test('release revokes every URL of that session once the last holder lets go', async () => {
    const revoked: string[] = [];
    __testing.spyRevoke((url) => revoked.push(url));
    retainAttachmentObjectUrls('ses_a');
    retainAttachmentObjectUrls('ses_a');
    const a = attachmentDisplaySrc(filePart('prt_1', DATA_URL, 'ses_a'));
    const b = attachmentDisplaySrc(filePart('prt_2', DATA_URL, 'ses_a'));
    const other = attachmentDisplaySrc(filePart('prt_3', DATA_URL, 'ses_b'));
    releaseAttachmentObjectUrls('ses_a');
    await microtask();
    expect(revoked).toEqual([]);
    releaseAttachmentObjectUrls('ses_a');
    // Deferred: nothing is revoked inside the releasing task …
    expect(revoked).toEqual([]);
    expect(__testing.size()).toBe(3);
    await microtask();
    // … and everything of that session is, one microtask later.
    expect(revoked.sort()).toEqual([a, b].sort());
    // The other session's entry is untouched, and a later read of a released
    // part simply decodes again.
    expect(attachmentDisplaySrc(filePart('prt_3', DATA_URL, 'ses_b'))).toBe(other);
    expect(attachmentDisplaySrc(filePart('prt_1', DATA_URL, 'ses_a')).startsWith('blob:')).toBe(
      true,
    );
  });

  test('release of a session nobody retained is a no-op', async () => {
    const revoked: string[] = [];
    __testing.spyRevoke((url) => revoked.push(url));
    attachmentDisplaySrc(filePart('prt_1', DATA_URL, 'ses_a'));
    releaseAttachmentObjectUrls('ses_a');
    await microtask();
    expect(revoked).toEqual([]);
    expect(__testing.size()).toBe(1);
  });

  test('retain → release → retain in one task (React StrictMode) keeps the URLs and the cache', async () => {
    const revoked: string[] = [];
    __testing.spyRevoke((url) => revoked.push(url));
    const a = attachmentDisplaySrc(filePart('prt_1', DATA_URL, 'ses_a'));
    retainAttachmentObjectUrls('ses_a');
    releaseAttachmentObjectUrls('ses_a');
    retainAttachmentObjectUrls('ses_a');
    await microtask();
    await microtask();
    expect(revoked).toEqual([]);
    expect(__testing.size()).toBe(1);
    // The same part reads the SAME object URL back — nothing was re-decoded.
    expect(attachmentDisplaySrc(filePart('prt_1', DATA_URL, 'ses_a'))).toBe(a);
    // The holder that survived still owns one reference: its release revokes.
    releaseAttachmentObjectUrls('ses_a');
    await microtask();
    expect(revoked).toEqual([a]);
    expect(__testing.size()).toBe(0);
  });

  test('two pending last-releases of one session collapse into one revoke pass', async () => {
    const revoked: string[] = [];
    __testing.spyRevoke((url) => revoked.push(url));
    const a = attachmentDisplaySrc(filePart('prt_1', DATA_URL, 'ses_a'));
    retainAttachmentObjectUrls('ses_a');
    releaseAttachmentObjectUrls('ses_a');
    retainAttachmentObjectUrls('ses_a');
    releaseAttachmentObjectUrls('ses_a');
    await microtask();
    expect(revoked).toEqual([a]);
    expect(__testing.size()).toBe(0);
  });
});
