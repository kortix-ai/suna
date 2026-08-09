import { describe, expect, test } from 'bun:test';
import type { JSONContent } from '@tiptap/core';

import { planFailedSendRecovery, resolveEditorPlaceholder, shouldApplyPrefill } from './composer-logic';
import type { AttachedFile } from './types';

describe('shouldApplyPrefill', () => {
  // Fix round 1, Critical: this is where the "prefill delivered before the
  // lazy chunk resolves is silently discarded" bug lived. `editorReady`
  // must gate everything else.
  test('false while the editor is not ready yet, even with a full prefill', () => {
    expect(
      shouldApplyPrefill({
        prefillId: 1,
        prefillText: 'recovered draft',
        prefillFiles: undefined,
        prefillMode: 'merge',
        editorReady: false,
      }),
    ).toBe(false);
  });

  test('true once the editor becomes ready, same prefill values as the false case above', () => {
    expect(
      shouldApplyPrefill({
        prefillId: 1,
        prefillText: 'recovered draft',
        prefillFiles: undefined,
        prefillMode: 'merge',
        editorReady: true,
      }),
    ).toBe(true);
  });

  test('false when there is no prefill at all (prefillId undefined)', () => {
    expect(
      shouldApplyPrefill({
        prefillId: undefined,
        prefillText: '',
        editorReady: true,
      }),
    ).toBe(false);
  });

  test('false for empty text, no files, and a non-replace mode', () => {
    expect(
      shouldApplyPrefill({
        prefillId: 2,
        prefillText: '',
        prefillFiles: [],
        prefillMode: 'merge',
        editorReady: true,
      }),
    ).toBe(false);
  });

  test('true for empty text and no files when mode is explicitly "replace" (forces a clear)', () => {
    expect(
      shouldApplyPrefill({
        prefillId: 2,
        prefillText: '',
        prefillFiles: [],
        prefillMode: 'replace',
        editorReady: true,
      }),
    ).toBe(true);
  });

  test('true when text is present, regardless of mode', () => {
    expect(
      shouldApplyPrefill({
        prefillId: 3,
        prefillText: 'starter prompt',
        editorReady: true,
      }),
    ).toBe(true);
  });

  test('true when files are present even with empty text', () => {
    expect(
      shouldApplyPrefill({
        prefillId: 4,
        prefillText: '',
        prefillFiles: [{}],
        prefillMode: 'merge',
        editorReady: true,
      }),
    ).toBe(true);
  });

  test('undefined mode behaves like a non-replace mode', () => {
    expect(
      shouldApplyPrefill({
        prefillId: 5,
        prefillText: '',
        prefillFiles: undefined,
        prefillMode: undefined,
        editorReady: true,
      }),
    ).toBe(false);
  });
});

describe('resolveEditorPlaceholder', () => {
  const base = {
    stagedCommand: false,
    lockForApproval: false,
    lockForQuestion: false,
    questionButtonLabel: null as string | null,
    placeholder: 'Ask anything...',
  };

  test('falls through to the caller placeholder when nothing is active', () => {
    expect(resolveEditorPlaceholder(base)).toBe('Ask anything...');
  });

  test('staged command wins over everything else', () => {
    expect(
      resolveEditorPlaceholder({
        ...base,
        stagedCommand: true,
        lockForApproval: true,
        lockForQuestion: true,
      }),
    ).toBe('Enter details and press Enter, or press Esc to cancel');
  });

  test('lockForApproval wins over lockForQuestion when staged command is not active', () => {
    expect(
      resolveEditorPlaceholder({
        ...base,
        lockForApproval: true,
        lockForQuestion: true,
      }),
    ).toBe('Approve or deny the action above to continue…');
  });

  test('lockForQuestion with no questionButtonLabel', () => {
    expect(
      resolveEditorPlaceholder({
        ...base,
        lockForQuestion: true,
        questionButtonLabel: null,
      }),
    ).toBe('Type your answer...');
  });

  test('lockForQuestion with a questionButtonLabel offers the custom-answer hint instead', () => {
    expect(
      resolveEditorPlaceholder({
        ...base,
        lockForQuestion: true,
        questionButtonLabel: 'Next',
      }),
    ).toBe('Or type your own answer...');
  });

  test('an empty-string questionButtonLabel is falsy, same as null', () => {
    expect(
      resolveEditorPlaceholder({
        ...base,
        lockForQuestion: true,
        questionButtonLabel: '',
      }),
    ).toBe('Type your answer...');
  });
});

/**
 * `planFailedSendRecovery` — Task 13, fix round 1, Important 1. This is the
 * ENTIRE decision behind `composer.tsx`'s failed-send `catch` block, pulled
 * out specifically because `handleSubmit` itself cannot be unit-tested here
 * (no DOM, a `React.lazy`-boundary client component) — the fix-round review
 * proved that gap concretely: deleting the whole recovery block in
 * `composer.tsx` left `bun test src/features/session` at 1340/1340 pass,
 * unchanged. Every branch below is now bound to a dedicated assertion, so
 * that specific blind spot is closed.
 */
function localFile(name: string, localUrl: string): AttachedFile {
  return {
    kind: 'local',
    file: new File(['x'], name, { type: 'text/plain' }),
    localUrl,
    isImage: false,
  };
}

function textDoc(text: string): JSONContent {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

const EMPTY_DOC: JSONContent = { type: 'doc', content: [{ type: 'paragraph' }] };

describe('planFailedSendRecovery', () => {
  test('clearOnSend=false → null: nothing was ever cleared, so nothing needs restoring', () => {
    const plan = planFailedSendRecovery({
      clearOnSend: false,
      submittedDoc: textDoc('original prompt'),
      submittedIsEmpty: false,
      currentDoc: EMPTY_DOC,
      currentIsEmpty: true,
      currentAttachedFiles: [],
      sentFiles: [],
    });

    expect(plan).toBeNull();
  });

  test('nothing typed since the clear → restoreDoc is the submitted document, verbatim', () => {
    const submitted = textDoc('original prompt');

    const plan = planFailedSendRecovery({
      clearOnSend: true,
      submittedDoc: submitted,
      submittedIsEmpty: false,
      currentDoc: EMPTY_DOC,
      currentIsEmpty: true,
      currentAttachedFiles: [],
      sentFiles: [],
    });

    expect(plan?.restoreDoc).toBe(submitted);
  });

  test('something typed meanwhile → restoreDoc concatenates submitted-first, current-after', () => {
    const submitted = textDoc('original prompt');
    const current = textDoc('new follow-up');

    const plan = planFailedSendRecovery({
      clearOnSend: true,
      submittedDoc: submitted,
      submittedIsEmpty: false,
      currentDoc: current,
      currentIsEmpty: false,
      currentAttachedFiles: [],
      sentFiles: [],
    });

    expect(plan?.restoreDoc).toEqual({
      type: 'doc',
      content: [...submitted.content!, { type: 'paragraph' }, ...current.content!],
    });
  });

  test('merge produces no change (files-only submitted doc) → restoreDoc is null, no pointless setDocument call', () => {
    const current = textDoc('new follow-up');

    const plan = planFailedSendRecovery({
      clearOnSend: true,
      submittedDoc: EMPTY_DOC, // files-only send: nothing in the doc itself
      submittedIsEmpty: true,
      currentDoc: current,
      currentIsEmpty: false,
      currentAttachedFiles: [],
      sentFiles: [],
    });

    expect(plan?.restoreDoc).toBeNull();
  });

  // MINOR 1 — the real regression the fix-round review caught: files must
  // restore whenever clearOnSend is true, regardless of whether a document
  // was ever successfully snapshotted. Disable the `submittedDoc && ...`
  // check's effect on `attachedFiles` (e.g. nest the files line inside it,
  // as the pre-fix-round code did) and EVERY test in this block dies,
  // because `attachedFiles` is asserted independently of `restoreDoc` in
  // each one below.
  test('submittedDoc is null (defensive: no handle at submit time) → files STILL restore', () => {
    const sent = localFile('offer.pdf', 'blob:offer');

    const plan = planFailedSendRecovery({
      clearOnSend: true,
      submittedDoc: null,
      submittedIsEmpty: true,
      currentDoc: null,
      currentIsEmpty: true,
      currentAttachedFiles: [],
      sentFiles: [sent],
    });

    expect(plan?.restoreDoc).toBeNull(); // nothing to restore document-wise
    expect(plan?.attachedFiles).toEqual([sent]); // but the file is NOT discarded
  });

  test('currentDoc is null (defensive) → files still restore even though the doc half is skipped', () => {
    const sent = localFile('offer.pdf', 'blob:offer');

    const plan = planFailedSendRecovery({
      clearOnSend: true,
      submittedDoc: textDoc('original prompt'),
      submittedIsEmpty: false,
      currentDoc: null,
      currentIsEmpty: true,
      currentAttachedFiles: [],
      sentFiles: [sent],
    });

    expect(plan?.restoreDoc).toBeNull();
    expect(plan?.attachedFiles).toEqual([sent]);
  });

  test('files restore ahead of newly attached files without duplicates, matching mergeFailedSubmissionFiles', () => {
    const sent = localFile('offer.pdf', 'blob:offer');
    const addedWhileSending = localFile('notes.txt', 'blob:notes');

    const plan = planFailedSendRecovery({
      clearOnSend: true,
      submittedDoc: textDoc('original prompt'),
      submittedIsEmpty: false,
      currentDoc: EMPTY_DOC,
      currentIsEmpty: true,
      currentAttachedFiles: [addedWhileSending],
      sentFiles: [sent],
    });

    expect(plan?.attachedFiles).toEqual([sent, addedWhileSending]);
  });

  test('clearOnSend=true with everything empty and nothing sent → still returns a plan, empty files, null doc', () => {
    const plan = planFailedSendRecovery({
      clearOnSend: true,
      submittedDoc: null,
      submittedIsEmpty: true,
      currentDoc: null,
      currentIsEmpty: true,
      currentAttachedFiles: [],
      sentFiles: [],
    });

    expect(plan).toEqual({ restoreDoc: null, attachedFiles: [] });
  });
});
