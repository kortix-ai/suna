import { describe, expect, test } from 'bun:test';

import { isAttachmentPartRef } from '@kortix/sdk';

/**
 * A part reference is a DAEMON path (`/kortix/part/…`), produced by
 * `stripInlineAttachmentBytes` in place of an inline `data:` url. It starts
 * with `/` like a workspace path does, so the resolver has to recognise it
 * before the workspace-path branch claims it and asks the file API for a file
 * that does not exist.
 */
describe('isAttachmentPartRef', () => {
  test('recognises the daemon part path', () => {
    expect(isAttachmentPartRef('/kortix/part/ses_1/msg_1/prt_1')).toBe(true);
  });

  test('a workspace path, a data url and a remote url are not part refs', () => {
    expect(isAttachmentPartRef('/workspace/uploads/a.png')).toBe(false);
    expect(isAttachmentPartRef('data:image/png;base64,AAAA')).toBe(false);
    expect(isAttachmentPartRef('https://files.example.test/a.png')).toBe(false);
    expect(isAttachmentPartRef('')).toBe(false);
  });
});
