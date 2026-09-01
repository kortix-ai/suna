import { describe, expect, test } from 'bun:test';
import type { JSONContent } from '@tiptap/core';

import {
  planDraftSubmission,
  planFailedSendRecovery,
  planPrefillMerge,
  resolveEditorPlaceholder,
  shouldApplyPrefill,
  shouldFocusEditorFromPadding,
  textToDocument,
} from './composer-logic';
import type { AttachedFile } from './types';

/** A one-paragraph document holding exactly this text. */
const docOf = (text: string): JSONContent => textToDocument(text);

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
    lockForApproval: false,
    lockForQuestion: false,
    questionButtonLabel: null as string | null,
    placeholder: 'Ask anything...',
  };

  test('falls through to the caller placeholder when nothing is active', () => {
    expect(resolveEditorPlaceholder(base)).toBe('Ask anything...');
  });

  test('lockForApproval wins over lockForQuestion', () => {
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
    ).toBe('Type your answer…');
  });

  test('lockForQuestion with a questionButtonLabel offers the custom-answer hint instead', () => {
    expect(
      resolveEditorPlaceholder({
        ...base,
        lockForQuestion: true,
        questionButtonLabel: 'Next',
      }),
    ).toBe('Or type your own answer…');
  });

  test('an empty-string questionButtonLabel is falsy, same as null', () => {
    expect(
      resolveEditorPlaceholder({
        ...base,
        lockForQuestion: true,
        questionButtonLabel: '',
      }),
    ).toBe('Type your answer…');
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
    const firstSent = localFile('offer.pdf', 'blob:offer');
    const secondSent = localFile('terms.pdf', 'blob:terms');
    const addedWhileSending = localFile('notes.txt', 'blob:notes');

    const plan = planFailedSendRecovery({
      clearOnSend: true,
      submittedDoc: textDoc('original prompt'),
      submittedIsEmpty: false,
      currentDoc: EMPTY_DOC,
      currentIsEmpty: true,
      currentAttachedFiles: [addedWhileSending],
      sentFiles: [firstSent, secondSent],
    });

    expect(plan?.attachedFiles).toEqual([firstSent, secondSent, addedWhileSending]);
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

/**
 * Task 14, matrix row 1. These pin the three behaviours the rewrite lost when
 * merge-mode prefill moved to `setContent(text, 'merge')`. Each one is stated
 * against the OLD `mergeFailedSubmissionText(current, prefillText)` contract
 * (`session-chat-input.tsx:356-358`), which is the behaviour being restored —
 * not against whatever the new code happens to do.
 */
describe('planPrefillMerge — merge-mode prefill restores the live semantics', () => {
  test('puts the PREFILL FIRST and the in-flight draft after it', () => {
    // Old: `${submitted}\n\n${current}` — the recovered content leads.
    const merged = planPrefillMerge({
      prefillDoc: docOf('recovered'),
      prefillIsEmpty: false,
      currentDoc: docOf('my draft'),
      currentIsEmpty: false,
    });

    expect(merged).toEqual({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'recovered' }] },
        { type: 'paragraph' },
        { type: 'paragraph', content: [{ type: 'text', text: 'my draft' }] },
      ],
    });
  });

  test('DEDUPES an identical prefill — a retry cannot double the message', () => {
    // Old: `if (current === submitted) return current`. Regressed to
    // "same" -> "same\n\nsame", i.e. the user watches their text duplicate.
    expect(
      planPrefillMerge({
        prefillDoc: docOf('same'),
        prefillIsEmpty: false,
        currentDoc: docOf('same'),
        currentIsEmpty: false,
      }),
    ).toBeNull();
  });

  test('leaves the draft completely alone for a files-only (empty-text) prefill', () => {
    // Old: `if (!submitted) return current`. Regressed to injecting two blank
    // paragraphs into whatever the user had typed.
    expect(
      planPrefillMerge({
        prefillDoc: docOf(''),
        prefillIsEmpty: true,
        currentDoc: docOf('my draft'),
        currentIsEmpty: false,
      }),
    ).toBeNull();
  });

  test('uses the prefill verbatim when the composer is empty', () => {
    // Old: `if (!current) return submitted`.
    expect(
      planPrefillMerge({
        prefillDoc: docOf('recovered'),
        prefillIsEmpty: false,
        currentDoc: docOf(''),
        currentIsEmpty: true,
      }),
    ).toEqual(docOf('recovered'));
  });

  test('carries mention atom nodes through from BOTH sides', () => {
    // The reason this operates on documents rather than strings: a mention
    // flattened to plain "@label" text produces no <file_ref> on the next
    // send. The string-based helper could not have preserved these.
    const mention = (label: string): JSONContent => ({
      type: 'mention',
      attrs: { kind: 'file', label, value: label },
    });
    const merged = planPrefillMerge({
      prefillDoc: { type: 'doc', content: [{ type: 'paragraph', content: [mention('a.ts')] }] },
      prefillIsEmpty: false,
      currentDoc: { type: 'doc', content: [{ type: 'paragraph', content: [mention('b.ts')] }] },
      currentIsEmpty: false,
    });

    const labels = JSON.stringify(merged).match(/"label":"[^"]+"/g);
    expect(labels).toEqual(['"label":"a.ts"', '"label":"b.ts"']);
  });
});

/**
 * `planDraftSubmission` is the whole of "does this draft run a command or send
 * a message". It exists as a pure function because `handleSubmit` cannot be
 * tested here — this repo's `bun test` has no DOM and `composer.tsx` sits
 * behind a `React.lazy` boundary — and because the miss case (a chip naming a
 * command that no longer exists) is the one place the answer is not obvious.
 */
describe('planDraftSubmission', () => {
  const commands = [
    { name: 'deep-research', description: 'Research deeply' },
    { name: 'compact', description: 'Compact the thread' },
  ] as never as Parameters<typeof planDraftSubmission>[0]['commands'];

  test('no command chip — an ordinary message, trimmed', () => {
    expect(
      planDraftSubmission({ commandName: undefined, text: '  hello world  ', commands }),
    ).toEqual({ kind: 'message', text: 'hello world' });
  });

  test('a resolvable chip runs the command, with the surrounding text as args', () => {
    const plan = planDraftSubmission({
      commandName: 'deep-research',
      text: 'the tiptap docs',
      commands,
    });

    expect(plan.kind).toBe('command');
    if (plan.kind !== 'command') throw new Error('unreachable');
    expect(plan.command.name).toBe('deep-research');
    expect(plan.args).toBe('the tiptap docs');
  });

  test('a chip with no arguments passes args as undefined, not an empty string', () => {
    // `onCommand(command, args)` treats `undefined` as "no arguments given".
    // An empty string is a supplied-but-blank argument, which is a different
    // thing to the command being run.
    const plan = planDraftSubmission({ commandName: 'compact', text: '   ', commands });

    expect(plan.kind).toBe('command');
    if (plan.kind !== 'command') throw new Error('unreachable');
    expect(plan.args).toBeUndefined();
  });

  test('an UNRESOLVABLE chip degrades to a message with /name re-inlined', () => {
    // The regression this guards: `text` excludes the chip, so returning it
    // unchanged would send "the tiptap docs" with no trace of what it was
    // arguments for. A deleted skill, or a draft recovered after the command
    // list changed, must not silently eat half the user's message.
    expect(
      planDraftSubmission({ commandName: 'deleted-skill', text: 'the tiptap docs', commands }),
    ).toEqual({ kind: 'message', text: '/deleted-skill the tiptap docs' });
  });

  test('an unresolvable chip with no arguments leaves no trailing space', () => {
    expect(planDraftSubmission({ commandName: 'gone', text: '', commands })).toEqual({
      kind: 'message',
      text: '/gone',
    });
  });

  test('an empty command list resolves nothing — every chip degrades', () => {
    expect(planDraftSubmission({ commandName: 'compact', text: 'x', commands: [] })).toEqual({
      kind: 'message',
      text: '/compact x',
    });
  });
});

// ── Clicking the composer's padding ────────────────────────────────────────
//
// The editor's wrapper carries `px-1 pb-9`, and padding belongs to the
// wrapper's box rather than to the contenteditable inside it. So a 24px band
// under the last line — exactly where you click to resume typing — and an 8px
// strip down each side swallowed the press and focused nothing. The input read
// as broken.
describe('shouldFocusEditorFromPadding', () => {
  test('a press on the padding itself focuses the editor', () => {
    expect(shouldFocusEditorFromPadding({ onWrapperItself: true, disabled: false })).toBe(true);
  });

  test('a press on a DESCENDANT is left alone — this is the load-bearing half', () => {
    // Presses inside the editor belong to ProseMirror: that is how the caret
    // lands where you clicked, how a drag selects a range, and how a mention
    // chip reaches its own handler. Hijacking them would collapse every
    // in-editor click to the document end and make text unselectable — a worse
    // bug than the one this fixes.
    expect(shouldFocusEditorFromPadding({ onWrapperItself: false, disabled: false })).toBe(false);
  });

  test('a disabled editor is never focused, padding or not', () => {
    // `editorDisabled` is `disabled || lockForApproval`. Stealing focus into a
    // dead editor would put the caret somewhere that cannot accept typing.
    expect(shouldFocusEditorFromPadding({ onWrapperItself: true, disabled: true })).toBe(false);
    expect(shouldFocusEditorFromPadding({ onWrapperItself: false, disabled: true })).toBe(false);
  });
});
