import { describe, expect, test } from 'bun:test';

import { resolveComposerResetOnSend } from './composer-reset';
import type { AttachedFile } from './session-chat-input';

const localFile = (localUrl: string): AttachedFile => ({
  kind: 'local',
  file: new File([''], 'x.png', { type: 'image/png' }),
  localUrl,
  isImage: true,
});

const remoteFile = (): AttachedFile => ({
  kind: 'remote',
  url: 'https://example.com/x.png',
  filename: 'x.png',
  mime: 'image/png',
  isImage: true,
});

describe('resolveComposerResetOnSend', () => {
  test('clearOnSend=false → clears nothing and revokes no URLs (message survives navigation)', () => {
    // The project-home composer navigates away on send; nothing must be cleared
    // or revoked, or the message + attachments would be lost mid-navigation.
    const files = [localFile('blob:local-1'), remoteFile()];
    expect(resolveComposerResetOnSend(false, files)).toEqual({ clear: false, urlsToRevoke: [] });
  });

  test('clearOnSend=true → resets and revokes ONLY the local object URLs', () => {
    const files = [localFile('blob:local-1'), remoteFile(), localFile('blob:local-2')];
    expect(resolveComposerResetOnSend(true, files)).toEqual({
      clear: true,
      urlsToRevoke: ['blob:local-1', 'blob:local-2'],
    });
  });

  test('clearOnSend=true with no attachments → resets with nothing to revoke', () => {
    expect(resolveComposerResetOnSend(true, [])).toEqual({ clear: true, urlsToRevoke: [] });
  });
});
