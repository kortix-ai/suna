import { beforeEach, describe, expect, test } from 'bun:test';

import { firstPromptAttachments } from '@/features/session/sent-attachment-previews';
import { sentAttachmentsOf } from '@/features/session/uploaded-file-refs';

import {
  captureHeldSend,
  heldSendFailureCode,
  heldSendResendInput,
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
      // The restart threw, so the files are the cause — whatever the first
      // failure was. The queue says "Not sent. A file didn't upload."
      code: 'upload_failed',
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

/**
 * A kept send has to be re-sendable EXACTLY as it went out. Retry used to
 * re-resolve the agent, model and variant from whatever the composer showed at
 * click time, re-stamp the queue order with the click's clock, and hand the
 * reply-context-wrapped text back in as if the user had typed it.
 */
describe('captureHeldSend', () => {
  const attachments = {
    submittedIds: [],
    readyAtSend: true,
    whenReady: async () => [],
    retry: () => {},
    resubmit: () => {},
    release: () => {},
  };
  const captured = () =>
    captureHeldSend({
      rawText: 'fix the parser',
      text: '<reply_context>earlier answer</reply_context>\n\nfix the parser',
      files: [],
      mentions: [],
      attachments,
      clientMessageId: 'q_1',
      sentAtMs: 1_700_000_000_000,
      agent: 'build',
      model: { providerID: 'anthropic', modelID: 'claude' },
      variant: 'thinking',
      placement: 'composer',
    });

  test('the picks the send RESOLVED are kept, so Retry cannot use a later one', () => {
    expect(captured().overrides).toEqual({
      agent: 'build',
      model: { providerID: 'anthropic', modelID: 'claude' },
      variant: 'thinking',
      clientMessageId: 'q_1',
      sentAtMs: 1_700_000_000_000,
      // A Queue List send retried as a transcript send would paint a bubble
      // the user never asked for.
      placement: 'composer',
    });
  });

  test('a send that picked nothing keeps that, rather than inheriting the composer', () => {
    const send = captureHeldSend({
      rawText: 'hi',
      text: 'hi',
      attachments,
      clientMessageId: 'q_2',
      sentAtMs: 5,
      agent: null,
      model: null,
      variant: null,
      placement: 'transcript',
    });
    expect(send.overrides).toEqual({
      agent: null,
      model: null,
      variant: null,
      clientMessageId: 'q_2',
      sentAtMs: 5,
      placement: 'transcript',
    });
  });

  test('both texts are kept: the words typed, and the ones the wire carried', () => {
    expect(captured().rawText).toBe('fix the parser');
    expect(captured().text).toBe('<reply_context>earlier answer</reply_context>\n\nfix the parser');
  });
});

describe('heldSendResendInput', () => {
  const send: HeldSend = {
    rawText: 'fix the parser',
    text: '<reply_context>earlier answer</reply_context>\n\nfix the parser',
    files: [],
    mentions: [],
    attachments: {
      submittedIds: [],
      readyAtSend: true,
      whenReady: async () => [],
      retry: () => {},
      resubmit: () => {},
      release: () => {},
    },
    overrides: {
      agent: 'build',
      model: { providerID: 'anthropic', modelID: 'claude' },
      variant: 'thinking',
      clientMessageId: 'q_1',
      sentAtMs: 42,
      placement: 'composer',
    },
  };

  test('the resend sends the typed words, and the wire text is passed through untouched', () => {
    // `rawText` is what the queued row shows and what the composer would have
    // returned. `sentText` is what actually went out, so a reply context is
    // not wrapped a second time and one picked since is not stolen.
    const input = heldSendResendInput(send);
    expect(input.text).toBe('fix the parser');
    expect(input.overrides.sentText).toBe(send.text);
    expect(input.attachments).toBe(send.attachments);
    expect(input.files).toBe(send.files);
    expect(input.mentions).toBe(send.mentions);
  });

  test('the send-time picks, key and Enter time are what the resend carries', () => {
    expect(heldSendResendInput(send).overrides).toMatchObject({
      agent: 'build',
      model: { providerID: 'anthropic', modelID: 'claude' },
      variant: 'thinking',
      clientMessageId: 'q_1',
      sentAtMs: 42,
      placement: 'composer',
    });
  });

  test('a send kept before both texts existed still re-sends what it has', () => {
    const legacy = { ...send, rawText: undefined } as unknown as HeldSend;
    expect(heldSendResendInput(legacy).text).toBe(send.text);
  });
});

describe('heldSendFailureCode', () => {
  test('a file that never became a part', () => {
    expect(heldSendFailureCode('upload', new Error('a.png did not upload'))).toBe('upload_failed');
  });

  test('a POST that never reached a server has no status', () => {
    expect(heldSendFailureCode('post', new TypeError('Failed to fetch'))).toBe('network');
    expect(heldSendFailureCode('post', null)).toBe('network');
  });

  test('a refusal that DID reach the server is named by the server, not guessed here', () => {
    expect(heldSendFailureCode('post', { status: 402 })).toBe('unknown');
    expect(heldSendFailureCode('post', { status: 500 })).toBe('unknown');
  });
});
