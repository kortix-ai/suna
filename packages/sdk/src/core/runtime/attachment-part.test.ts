import { describe, expect, test } from 'bun:test';

import { ATTACHMENT_PART_REF_PREFIX, isAttachmentPartRef } from './attachment-part';

/**
 * A part reference is a DAEMON path. It starts with `/` like a workspace path
 * does, so every resolver has to recognise it BEFORE a workspace-path branch
 * claims it and asks the file API for a file that does not exist.
 */
describe('isAttachmentPartRef', () => {
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
