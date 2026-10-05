import { beforeEach, describe, expect, test } from 'bun:test';

import { firstPromptAttachments } from '@/features/session/sent-attachment-previews';
import { sentAttachmentsOf } from '@/features/session/uploaded-file-refs';

import {
  retryHeldSend,
  useCarriedDraftStore,
  useFirstPromptPreviewStore,
  useHeldSendFailureStore,
  type HeldSend,
} from './session-composer-handoff-store';

describe('useFirstPromptPreviewStore', () => {
  test('a first prompt remembers its attachment identities past the preview clear', () => {
    const shot = {
      kind: 'local' as const,
      uploadId: 'attachment-first-store',
      file: new File(['x'], 'shot.png', { type: 'image/png' }),
      localUrl: 'blob:first-store',
      isImage: true,
    };
    const store = useFirstPromptPreviewStore.getState();
    store.setFirstPromptPreview('ses-store', 'look', [shot]);
    // SessionChat clears the preview the frame the transcript carries the files.
    store.clearFirstPromptPreview('ses-store');
    expect(firstPromptAttachments('ses-store')).toEqual(sentAttachmentsOf([shot]));
    expect(firstPromptAttachments('ses-store')?.[0]?.id).toBe('attachment-first-store');
  });
});

/**
 * A follow-up whose upload failed after its bubble was painted stays on screen,
 * marked failed. The failure lives here, not in `SessionChat` state, so a
 * remount still draws it with Retry.
 */
describe('useHeldSendFailureStore', () => {
  beforeEach(() => {
    useHeldSendFailureStore.setState({ failuresBySession: {} });
  });

  const heldSend = (retry: () => void): HeldSend => ({
    text: 'x',
    attachments: {
      submittedIds: ['attachment-1'],
      readyAtSend: false,
      whenReady: async () => [],
      retry,
      resubmit: () => {},
      release: () => {},
    },
    overrides: { clientMessageId: 'client-1' },
  });

  test('a Retry whose upload expired keeps the send failed with that reason and sends nothing', () => {
    const send = heldSend(() => {
      throw new Error('Attachment expired. Attach the file again.');
    });
    useHeldSendFailureStore
      .getState()
      .setHeldSendFailure('S1', 'msg_1', { message: 'did not upload', send });
    const resent: HeldSend[] = [];

    retryHeldSend(
      'S1',
      'msg_1',
      async (again) => {
        resent.push(again);
      },
      (error) => (error as Error).message,
    );

    expect(resent).toEqual([]);
    expect(useHeldSendFailureStore.getState().failuresBySession.S1?.msg_1).toEqual({
      message: 'Attachment expired. Attach the file again.',
      send,
    });
  });

  test('failures are kept per session, clearing the last one drops the session, and a Retry with no kept failure sends nothing', () => {
    const send = heldSend(() => {});
    const store = useHeldSendFailureStore.getState();
    store.setHeldSendFailure('S1', 'msg_1', { message: 'a', send });
    store.setHeldSendFailure('S2', 'msg_2', { message: 'b', send });
    const resent: HeldSend[] = [];

    retryHeldSend(
      'S3',
      'msg_1',
      async (again) => {
        resent.push(again);
      },
      String,
    );
    expect(resent).toEqual([]);
    useHeldSendFailureStore.getState().clearHeldSendFailure('S1', 'msg_1');

    expect(useHeldSendFailureStore.getState().failuresBySession).toEqual({
      S2: { msg_2: { message: 'b', send } },
    });
  });
});

/**
 * The boot shell refuses a second message while the first is still starting,
 * and the composer's own recovery puts the text back in the SHELL's editor —
 * which the crossfade into `SessionChat` unmounts. This store is what carries
 * the draft across that replacement, so the toast's promise ("kept in the
 * composer") is true for the whole 19-25 s boot rather than only until it ends.
 */
describe('useCarriedDraftStore', () => {
  beforeEach(() => {
    useCarriedDraftStore.setState({ draftBySession: {} });
  });

  test('a carried draft is handed to the session that was typed into', () => {
    useCarriedDraftStore.getState().carryDraft('S1', 'use Tailwind', []);

    expect(useCarriedDraftStore.getState().draftBySession.S2).toBeUndefined();
    expect(useCarriedDraftStore.getState().draftBySession.S1).toMatchObject({
      text: 'use Tailwind',
      files: [],
    });
  });

  test('clearing is what stops a later remount ghosting the text back', () => {
    // A tab switch or a panel toggle remounts `SessionChat`. A draft held for
    // ever would reappear in an editor the user had already emptied.
    useCarriedDraftStore.getState().carryDraft('S1', 'use Tailwind', []);
    useCarriedDraftStore.getState().clearCarriedDraft('S1');

    expect(useCarriedDraftStore.getState().draftBySession.S1).toBeUndefined();
    // Clearing a session that carries nothing is a no-op, not a throw.
    expect(() => useCarriedDraftStore.getState().clearCarriedDraft('S1')).not.toThrow();
  });

  test('a second refusal replaces the first and carries a new id', () => {
    // The user edits the refused text and presses Enter again — the newer text
    // is the one that must arrive, under an id the composer has not applied.
    useCarriedDraftStore.getState().carryDraft('S1', 'use Tailwind', []);
    const first = useCarriedDraftStore.getState().draftBySession.S1;
    useCarriedDraftStore.getState().carryDraft('S1', 'use Tailwind v4', []);
    const second = useCarriedDraftStore.getState().draftBySession.S1;

    expect(second.text).toBe('use Tailwind v4');
    expect(second.id).toBeGreaterThan(first.id);
  });

  test('attachments ride along with the text', () => {
    const file = { id: 'f1', name: 'a.png' } as never;
    useCarriedDraftStore.getState().carryDraft('S1', 'look at this', [file]);

    expect(useCarriedDraftStore.getState().draftBySession.S1.files).toEqual([file]);
  });
});
