import { describe, expect, test } from 'bun:test';

import { resolveEditorPlaceholder, shouldApplyPrefill } from './composer-logic';

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
