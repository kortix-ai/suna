import { describe, expect, test } from 'bun:test';

import { ATTACHMENT_PART_REF_PREFIX, fetchAttachmentPart, isAttachmentPartRef } from './attachment-part';
import { configureKortix, platformConfig } from '../http/config';

/**
 * A part reference is a DAEMON path. It starts with `/` like a workspace path
 * does, so every resolver has to recognise it BEFORE a workspace-path branch
 * claims it and asks the file API for a file that does not exist.
 */
describe('isAttachmentPartRef', () => {
  const direct = `/projects/11111111-1111-4111-8111-111111111111/sessions/22222222-2222-4222-8222-222222222222/attachments/${'a'.repeat(64)}`;
  test('recognises only canonical session attachment paths', () => {
    expect(isAttachmentPartRef(direct)).toBe(true);
    for (const value of [`https://evil.test${direct}`, `//evil.test${direct}`, `${direct}?url=https://evil.test`, `${direct}/..`, direct.replace('/sessions/', '/%2e%2e/'), direct.replace('a'.repeat(64), 'A'.repeat(64))]) {
      expect(isAttachmentPartRef(value)).toBe(false);
    }
  });

  test('reads durable bytes through the configured API without a bound runtime', async () => {
    const requests: Request[] = [];
    const previous = platformConfig();
    configureKortix({
      backendUrl: 'https://api.test/v1/', getToken: async () => 'fixture-token',
      fetch: async (url, options) => {
        requests.push(new Request(url, options));
        return new Response(new Uint8Array([0, 255, 9]), { headers: { 'content-type': 'image/png' } });
      },
    });
    try {
      const blob = await fetchAttachmentPart(direct);
      expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([0, 255, 9]));
      expect(blob.type).toBe('image/png');
      expect(requests).toHaveLength(1);
      expect(requests[0]!.url).toBe(`https://api.test/v1${direct}`);
      expect(requests[0]!.headers.get('authorization')).toBe('Bearer fixture-token');
    } finally { configureKortix(previous); }
  });
  test('recognises the daemon part path', () => {
    expect(isAttachmentPartRef(`${ATTACHMENT_PART_REF_PREFIX}ses_1/msg_1/prt_1`)).toBe(true);
  });

  test('a workspace path, a data url, a remote url and non-strings are not refs', () => {
    expect(isAttachmentPartRef('/workspace/uploads/a.png')).toBe(false);
    expect(isAttachmentPartRef('data:image/png;base64,AAAA')).toBe(false);
    expect(isAttachmentPartRef('https://files.example.test/a.png')).toBe(false);
    expect(isAttachmentPartRef('')).toBe(false);
    expect(isAttachmentPartRef(null)).toBe(false);
    expect(isAttachmentPartRef(42)).toBe(false);
  });
});
