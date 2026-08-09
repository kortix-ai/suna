/**
 * Pure logic extracted out of `composer.tsx` — same discipline Tasks 6, 7,
 * 10 and 11 already applied to their own files. Both functions here are
 * small, but `shouldApplyPrefill` is where a real bug lived (fix round 1):
 * a prefill delivered before the lazy-loaded editor chunk resolves was
 * silently discarded, because the effect that applies it never re-ran once
 * the editor became ready. Pinning the guard as a pure function with tests
 * is what makes that regression provable instead of re-introducible.
 */

import type { JSONContent } from '@tiptap/core';

import { mergeFailedSubmissionDocument, mergeFailedSubmissionFiles } from '../composer-draft-recovery';
import type { AttachedFile } from './types';

export interface FailedSendRecoveryInput {
  /** `SessionChatInputProps.clearOnSend`. `false` means the composer never
   *  clears on send at all (project-home → new-session navigation), so
   *  there is nothing to restore — the user's draft was never touched. */
  clearOnSend: boolean;
  /** `editorRef.current?.getDocument()`, snapshotted BEFORE the pre-send
   *  clear — `null` only in the defensive case where the handle didn't
   *  exist yet at submit time (e.g. the lazy chunk hadn't resolved). */
  submittedDoc: JSONContent | null;
  /** `editorRef.current?.isEmpty()` at the same snapshot moment as `submittedDoc`. */
  submittedIsEmpty: boolean;
  /** `editorRef.current?.getDocument()`, read again inside the `catch` —
   *  whatever the user typed (if anything) while the request was in
   *  flight. `null` in the same defensive case as `submittedDoc`. */
  currentDoc: JSONContent | null;
  /** `editorRef.current?.isEmpty()` read at the same moment as `currentDoc`. */
  currentIsEmpty: boolean;
  /** The attached-files state as of the `catch` — NOT the pre-clear
   *  snapshot; `setAttachedFiles`'s functional-updater form already reads
   *  this fresh, so a caller passes whatever that updater receives. */
  currentAttachedFiles: AttachedFile[];
  /** The files that were part of the failed send (`filesToSend ?? []`). */
  sentFiles: AttachedFile[];
}

export interface FailedSendRecoveryPlan {
  /**
   * `null` means "don't call `setDocument` at all" — either nothing was
   * ever snapshotted (the defensive `submittedDoc`/`currentDoc` null case),
   * or `mergeFailedSubmissionDocument` decided the current document already
   * IS the right one (`merged === currentDoc`, e.g. a files-only submitted
   * doc with nothing to restore) and calling `setDocument` anyway would
   * only reset the cursor to no purpose.
   */
  restoreDoc: JSONContent | null;
  /**
   * The files to restore into `setAttachedFiles`. Computed unconditionally
   * whenever `clearOnSend` is true — see the file-level comment on why this
   * must NOT be nested inside whatever gates `restoreDoc`.
   */
  attachedFiles: AttachedFile[];
}

/**
 * What a failed send should restore — the decision logic behind
 * `composer.tsx`'s `handleSubmit` catch block, extracted so it is provable
 * without a DOM (Task 13, fix round 1, Important 1). `handleSubmit` itself
 * cannot be unit-tested in this repo (`bun test` has no DOM — see
 * `composer-editor.test.ts`'s own header note — and `composer.tsx` is a
 * client component behind a `React.lazy` boundary), so this pulls every
 * branch of "what happens on a failed send" into one pure function the
 * component calls with almost no logic of its own left at the call site:
 * read `plan.restoreDoc`, call `setDocument` if it's non-null, call
 * `setAttachedFiles(plan.attachedFiles)` unconditionally. A reviewer who
 * deletes or mis-wires that call site changes three trivial lines instead
 * of silently losing a branch inside a much larger `catch` block.
 *
 * Returns `null` when there is nothing to do at all (`clearOnSend` false —
 * the draft was never cleared, so nothing needs restoring).
 *
 * MINOR 1 fix (fix round 1): the pre-fix-round version of this logic gated
 * the ENTIRE recovery — including the files/mentions restore — behind
 * `submittedDoc` being non-null. That is wrong: `submittedDoc` can only be
 * `null` in the defensive case where `editorRef.current` was already gone
 * at submit time, and `handleSubmit` explicitly tolerates that same null
 * handle sixty lines earlier (the `stagedCommand`/`lockForQuestion`
 * branches both do `editorRef.current?.getContent()`). Nesting the files
 * restore inside the document-restore gate meant a failed send in that
 * edge case discarded the user's attachments outright instead of restoring
 * them — real data loss on a path the rest of the function already
 * anticipates. `attachedFiles` here is computed independently of
 * `restoreDoc`, so it always happens whenever `clearOnSend` is true.
 */
export function planFailedSendRecovery(
  input: FailedSendRecoveryInput,
): FailedSendRecoveryPlan | null {
  if (!input.clearOnSend) return null;

  const attachedFiles = mergeFailedSubmissionFiles(input.currentAttachedFiles, input.sentFiles);

  let restoreDoc: JSONContent | null = null;
  if (input.submittedDoc && input.currentDoc) {
    const merged = mergeFailedSubmissionDocument(
      input.currentDoc,
      input.currentIsEmpty,
      input.submittedDoc,
      input.submittedIsEmpty,
    );
    if (merged !== input.currentDoc) restoreDoc = merged;
  }

  return { restoreDoc, attachedFiles };
}

export interface ShouldApplyPrefillInput {
  /** `prefill?.id` — `undefined` means "no prefill at all". */
  prefillId: number | undefined;
  /** `prefill?.text ?? ''`. */
  prefillText: string;
  /** `prefill?.files`. */
  prefillFiles?: readonly unknown[];
  /** `prefill?.mode`. */
  prefillMode?: 'replace' | 'merge';
  /**
   * Whether `ComposerEditorHandle` is the real, working handle yet —
   * `editorRef.current?.getElement() != null` in `composer.tsx`. `false`
   * for the entire window between first mount and the lazy-loaded
   * `ComposerEditor` chunk resolving AND its own internal TipTap `Editor`
   * finishing construction (`immediatelyRender: false` defers that past
   * the chunk's own first render — see `composer.tsx`'s comment on
   * `editorElement`). Calling `setContent` before then is a silent no-op,
   * not a queued write.
   */
  editorReady: boolean;
}

/**
 * Whether a `prefill` prop should be applied right now.
 *
 * Mirrors `session-chat-input.tsx:349-355`'s guard exactly, with one
 * addition: `editorReady`. Without it, a prefill that arrives (or is
 * already present on mount — a cold-loaded failed-first-turn recovery,
 * `session-chat.tsx:3953-3958`) before the lazy editor chunk has resolved
 * is lost forever, because `prefillId`/`prefillText`/`prefillFiles`/
 * `prefillMode` never change again on their own — nothing re-triggers the
 * effect once the editor becomes ready, unless readiness is itself part of
 * what the effect watches. The caller is expected to include `editorReady`
 * (via `editorElement`) in its own effect's dependency array for exactly
 * this reason — this function only encodes the boolean logic, not the
 * re-run trigger.
 */
export function shouldApplyPrefill({
  prefillId,
  prefillText,
  prefillFiles,
  prefillMode,
  editorReady,
}: ShouldApplyPrefillInput): boolean {
  if (!editorReady) return false;
  if (prefillId === undefined) return false;
  if (!prefillText && !prefillFiles?.length && prefillMode !== 'replace') return false;
  return true;
}

export interface ResolveEditorPlaceholderInput {
  /** `!!stagedCommand`. */
  stagedCommand: boolean;
  lockForApproval: boolean;
  lockForQuestion: boolean;
  questionButtonLabel?: string | null;
  /** The caller-supplied default placeholder (`SessionChatInputProps.placeholder`). */
  placeholder: string;
}

/**
 * Which placeholder string `ComposerEditor` should show right now.
 *
 * Precedence matches the old custom-overlay conditionals exactly
 * (session-chat-input.tsx:1227-1272): a staged command's args prompt beats
 * the approval lock, which beats the question lock, which beats the
 * caller's own placeholder. Only one of these is ever true in practice —
 * `stagedCommand` and `lockForQuestion`/`lockForApproval` are mutually
 * exclusive interaction modes — but the precedence order still matters for
 * the (rare, transitional) render where two flags are momentarily both set.
 */
export function resolveEditorPlaceholder({
  stagedCommand,
  lockForApproval,
  lockForQuestion,
  questionButtonLabel,
  placeholder,
}: ResolveEditorPlaceholderInput): string {
  if (stagedCommand) return 'Enter details and press Enter, or press Esc to cancel';
  if (lockForApproval) return 'Approve or deny the action above to continue…';
  if (lockForQuestion) {
    return questionButtonLabel ? 'Or type your own answer...' : 'Type your answer...';
  }
  return placeholder;
}
