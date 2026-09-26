import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { configureKortix, createPromptAttachmentController } from '@kortix/sdk';

import type { AttachedFile } from './composer/types';
import {
  adoptSentAttachmentPreviews,
  disownSentAttachmentPreviews,
  firstPromptAttachments,
  holdConvertedPreview,
  rememberFirstPromptAttachments,
  releaseSentAttachmentPreview,
  retainSentAttachmentPreviews,
  revokeUnsentPreview,
  sentAttachmentPreview,
  sentAttachmentsForTurn,
} from './sent-attachment-previews';

const revoked: string[] = [];
const realRevoke = URL.revokeObjectURL;

function local(
  uploadId: string,
  name: string,
  localUrl: string,
  type = 'image/png',
): Extract<AttachedFile, { kind: 'local' }> {
  return {
    kind: 'local',
    uploadId,
    file: new File(['x'], name, { type }),
    localUrl,
    isImage: type.startsWith('image/'),
  };
}

const microtask = () => Promise.resolve();

beforeEach(() => {
  revoked.length = 0;
  URL.revokeObjectURL = (url: string) => {
    revoked.push(url);
  };
});

afterEach(async () => {
  // Empty the per-tab cache: the last holder leaving revokes everything.
  retainSentAttachmentPreviews()();
  await microtask();
  URL.revokeObjectURL = realRevoke;
});

describe('sent attachment previews', () => {
  test('a Send takes the composer picture under its upload id', () => {
    adoptSentAttachmentPreviews([local('upload-1', 'a.png', 'blob:a')]);

    expect(sentAttachmentPreview('upload-1')).toBe('blob:a');
    expect(sentAttachmentPreview(undefined)).toBeUndefined();
  });

  test('sends from two composers in one tab keep their own pictures', () => {
    configureKortix({
      backendUrl: 'https://api.test',
      getToken: async () => 'token',
      fetch: async () => new Promise<Response>(() => {}),
    });
    // Project home and the session composer each own a controller.
    const home = createPromptAttachmentController('project-1');
    const chat = createPromptAttachmentController('project-1');
    const [homeId] = home.addMany([new File(['a'], 'a.png', { type: 'image/png' })]);
    const [chatId] = chat.addMany([new File(['b'], 'b.png', { type: 'image/png' })]);
    try {
      adoptSentAttachmentPreviews([local(homeId!, 'a.png', 'blob:A')]);
      adoptSentAttachmentPreviews([local(chatId!, 'b.png', 'blob:B')]);

      // Message A's tile mounts after B was sent.
      expect(sentAttachmentPreview(homeId)).toBe('blob:A');
      expect(sentAttachmentPreview(chatId)).toBe('blob:B');

      // A's delivered image decodes: only A's picture is revoked.
      releaseSentAttachmentPreview(homeId!);
      expect(revoked).toEqual(['blob:A']);
      expect(sentAttachmentPreview(chatId)).toBe('blob:B');
    } finally {
      home.dispose();
      chat.dispose();
    }
  });

  test('the composer cannot revoke a picture a Send owns', () => {
    adoptSentAttachmentPreviews([local('upload-1', 'a.png', 'blob:a')]);

    revokeUnsentPreview('blob:a');
    revokeUnsentPreview('blob:unsent');

    expect(revoked).toEqual(['blob:unsent']);
  });

  test('a refused send disowns its pictures unrevoked, and the tray can revoke them later', () => {
    const file = local('upload-refused', 'a.png', 'blob:refused');
    adoptSentAttachmentPreviews([file]);

    disownSentAttachmentPreviews([file]);
    // The tray tile draws this URL again after reclaim.
    expect(revoked).toEqual([]);
    expect(sentAttachmentPreview('upload-refused')).toBeUndefined();

    revokeUnsentPreview('blob:refused');
    expect(revoked).toEqual(['blob:refused']);
  });

  test('a refused HEIC send revokes its JPEG only when no tile holds it', () => {
    // The tile that made the JPEG is still mounted: it keeps the JPEG and revokes it itself.
    const dropHeld = holdConvertedPreview('upload-held', 'blob:jpeg-held');
    adoptSentAttachmentPreviews([local('upload-held', 'held.heic', 'blob:heic-held', 'image/heic')]);
    disownSentAttachmentPreviews([local('upload-held', 'held.heic', 'blob:heic-held', 'image/heic')]);
    expect(revoked).toEqual([]);
    dropHeld();
    expect(revoked).toEqual(['blob:jpeg-held']);

    // The tile unmounted at Send and converts again on remount: nothing else frees the old JPEG.
    revoked.length = 0;
    const dropGone = holdConvertedPreview('upload-gone', 'blob:jpeg-gone');
    const heic = local('upload-gone', 'gone.heic', 'blob:heic-gone', 'image/heic');
    adoptSentAttachmentPreviews([heic]);
    dropGone();
    expect(revoked).toEqual([]);
    disownSentAttachmentPreviews([heic]);
    expect(revoked).toEqual(['blob:jpeg-gone']);
    expect(sentAttachmentPreview('upload-gone')).toBeUndefined();
  });

  test('a sent PDF retains its bytes for download', () => {
    adoptSentAttachmentPreviews([local('upload-2', 'brief.pdf', 'blob:pdf', 'application/pdf')]);
    expect(sentAttachmentPreview('upload-2')).toBe('blob:pdf');
  });

  test('HEIC hands over the JPEG the composer made, never the raw file', () => {
    adoptSentAttachmentPreviews([local('upload-raw', 'shot.heic', 'blob:heic', 'image/heic')]);
    expect(sentAttachmentPreview('upload-raw')).toBeUndefined();

    const dropConverted = holdConvertedPreview('upload-heic', 'blob:jpeg');
    adoptSentAttachmentPreviews([local('upload-heic', 'shot.heic', 'blob:heic-2', 'image/heic')]);
    expect(sentAttachmentPreview('upload-heic')).toBe('blob:jpeg');
    // The composer tile unmounts after Send: the JPEG is the Send's now.
    dropConverted();
    expect(revoked).toEqual([]);

    // A converted JPEG no Send took is revoked with its tile.
    holdConvertedPreview('upload-removed', 'blob:jpeg-removed')();
    expect(revoked).toEqual(['blob:jpeg-removed']);
  });

  test('the delivered source decoded: the preview is revoked once', () => {
    adoptSentAttachmentPreviews([local('upload-3', 'a.png', 'blob:c')]);

    releaseSentAttachmentPreview('upload-3');
    releaseSentAttachmentPreview('upload-3');

    expect(revoked).toEqual(['blob:c']);
    expect(sentAttachmentPreview('upload-3')).toBeUndefined();
  });

  test('the last session unmount revokes every preview; a StrictMode remount keeps them', async () => {
    adoptSentAttachmentPreviews([local('upload-4', 'a.png', 'blob:d')]);

    // StrictMode: mount, cleanup and mount again in one commit.
    const first = retainSentAttachmentPreviews();
    first();
    const second = retainSentAttachmentPreviews();
    await microtask();
    expect(sentAttachmentPreview('upload-4')).toBe('blob:d');
    expect(revoked).toEqual([]);

    second();
    await microtask();
    expect(revoked).toEqual(['blob:d']);
    expect(sentAttachmentPreview('upload-4')).toBeUndefined();
  });
});

describe('sentAttachmentsForTurn', () => {
  const shot = { id: 'attachment-7', filename: 'shot.png', mime: 'image/png' };
  const brief = { id: 'attachment-8', filename: 'brief.pdf', mime: 'application/pdf' };
  const named = { filename: 'queued.txt', mime: 'text/plain' };

  test('a follow-up turn draws the list its own send remembered', () => {
    expect(
      sentAttachmentsForTurn({
        sentByMessage: { msg_2: [shot] },
        messageId: 'msg_2',
        isFirstTurn: false,
      }),
    ).toEqual([shot]);
  });

  test('an echo the server re-minted finds the list through the id its bubble was painted with', () => {
    expect(
      sentAttachmentsForTurn({
        sentByMessage: { msg_painted: [shot] },
        messageId: 'msg_reminted',
        originId: 'msg_painted',
        isFirstTurn: false,
      }),
    ).toEqual([shot]);
  });

  test('only the first turn falls back to the first-prompt handover', () => {
    const input = { sentByMessage: {}, messageId: 'msg_1', firstTurnHandover: [brief] };
    expect(sentAttachmentsForTurn({ ...input, isFirstTurn: true })).toEqual([brief]);
    expect(sentAttachmentsForTurn({ ...input, isFirstTurn: false })).toBeUndefined();
    expect(
      sentAttachmentsForTurn({ ...input, isFirstTurn: true, firstTurnHandover: [] }),
    ).toBeUndefined();
  });

  test('the first turn keeps the identities its first prompt was sent with after the handover stops', () => {
    // Browser timeline 2026-09-15: the handover stops the frame the transcript carries the
    // files, and the turn then drew a name tile for ~24 s until the sandbox copy loaded.
    rememberFirstPromptAttachments('ses-first', [shot]);
    const input = {
      sentByMessage: {},
      messageId: 'msg_first',
      firstTurnSent: firstPromptAttachments('ses-first'),
      queuedRowAttachments: [{ filename: 'shot.png', mime: 'image/png' }],
    };
    expect(sentAttachmentsForTurn({ ...input, isFirstTurn: true })).toEqual([shot]);
    // A later turn never borrows the first prompt's files.
    expect(sentAttachmentsForTurn({ ...input, isFirstTurn: false })).toEqual([
      { filename: 'shot.png', mime: 'image/png' },
    ]);
    // A live handover still wins, as before.
    expect(
      sentAttachmentsForTurn({ ...input, isFirstTurn: true, firstTurnHandover: [brief] }),
    ).toEqual([brief]);
  });

  test('first prompt identities are kept per session, need an identity, and go with the last session unmount', async () => {
    rememberFirstPromptAttachments('ses-a', [shot]);
    rememberFirstPromptAttachments('ses-b', [named]);
    expect(firstPromptAttachments('ses-a')).toEqual([shot]);
    expect(firstPromptAttachments('ses-b')).toBeUndefined();
    expect(firstPromptAttachments(undefined)).toBeUndefined();

    retainSentAttachmentPreviews()();
    await microtask();
    expect(firstPromptAttachments('ses-a')).toBeUndefined();
  });

  test('a turn this tab did not send keeps its queued row files while delivery streams in', () => {
    // A reload or another tab: no sent list, but the inbox row still names the files.
    expect(
      sentAttachmentsForTurn({
        sentByMessage: {},
        messageId: 'msg_other_tab',
        isFirstTurn: false,
        queuedRowAttachments: [named],
      }),
    ).toEqual([named]);
    // This tab's own list wins over the row's names.
    expect(
      sentAttachmentsForTurn({
        sentByMessage: { msg_3: [shot] },
        messageId: 'msg_3',
        isFirstTurn: false,
        queuedRowAttachments: [named],
      }),
    ).toEqual([shot]);
  });
});


test('a sent document retains its local bytes for download before runtime delivery', () => {
  adoptSentAttachmentPreviews([local('document-1', 'notes.txt', 'blob:notes', 'text/plain')]);
  expect(sentAttachmentPreview('document-1')).toBe('blob:notes');
  revokeUnsentPreview('blob:notes');
  expect(revoked).not.toContain('blob:notes');
});
