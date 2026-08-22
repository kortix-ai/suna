/**
 * Pure logic extracted out of `composer.tsx` — same discipline Tasks 6, 7,
 * 10 and 11 already applied to their own files. Both functions here are
 * small, but `shouldApplyPrefill` is where a real bug lived (fix round 1):
 * a prefill delivered before the lazy-loaded editor chunk resolves was
 * silently discarded, because the effect that applies it never re-ran once
 * the editor became ready. Pinning the guard as a pure function with tests
 * is what makes that regression provable instead of re-introducible.
 */

import type { Command } from '@kortix/sdk/react';
import type { JSONContent } from '@tiptap/core';

import { mergeFailedSubmissionDocument, mergeFailedSubmissionFiles } from '../composer-draft-recovery';
import type { AttachedFile } from './types';

/**
 * Turn plain text into ProseMirror JSON paragraph nodes, one per `\n`-
 * separated line.
 *
 * Lives HERE, not in `editor/composer-editor.tsx`, even though that file is
 * its heaviest consumer. `composer.tsx` needs it too (merge-mode prefill has
 * to build a document to merge against), and `composer-editor.tsx` is behind
 * the `React.lazy` boundary — importing a VALUE from it would pull TipTap and
 * ProseMirror into the first-paint bundle and undo the code-splitting. This
 * module imports `JSONContent` as a type only, so it stays runtime-free of
 * TipTap. One definition, imported by both, rather than the copy-paste that
 * Task 11 had to undo.
 *
 * Passed as JSON — never as a bare string — because `setContent()` /
 * `insertContent()` parse a bare string as HTML (`elementFromString` ->
 * `DOMParser`), which would corrupt literal `<`, `>`, `&` in plain text.
 */
export function textToParagraphs(text: string): JSONContent[] {
  return text.split('\n').map((line) => ({
    type: 'paragraph',
    ...(line ? { content: [{ type: 'text', text: line }] } : {}),
  }));
}

/** `textToParagraphs` wrapped as a whole document. */
export function textToDocument(text: string): JSONContent {
  return { type: 'doc', content: textToParagraphs(text) };
}

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
 * handle sixty lines earlier (the command-chip and `lockForQuestion`
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

/**
 * What a `mode: 'merge'` prefill should put in the document — Task 14, matrix
 * row 1.
 *
 * The rewrite had replaced this with `setContent(prefillText, 'merge')`, whose
 * merge branch appends at the current selection with no dedupe. Measured
 * against the old `setText(current => mergeFailedSubmissionText(current,
 * prefillText))` (`session-chat-input.tsx:356-358`), that changed three
 * things, all regressions:
 *
 *  1. **Ordering inverted.** Old put the recovered text FIRST and whatever the
 *     user typed while the request was in flight after it
 *     (`` `${submitted}\n\n${current}` ``). New produced the reverse, burying
 *     the content the recovery exists to give back.
 *  2. **Dedupe lost.** Old returned `current` unchanged when the two were
 *     identical, so hitting retry could not double the message. New appended
 *     regardless: `"same"` became `"same\n\nsame"`.
 *  3. **Empty-text prefill.** A files-only failed start (`prefillText: ''`
 *     plus `prefillFiles`) used to leave the draft completely alone; new
 *     inserted two blank paragraphs into it.
 *
 * This restores all three by delegating to `mergeFailedSubmissionDocument`,
 * which already implements exactly `mergeFailedSubmissionText`'s three-branch
 * contract on documents instead of strings — so mention ATOM nodes on either
 * side survive, which the string version could not have done in this editor.
 *
 * Returns `null` for "leave the document alone", the same contract
 * `planFailedSendRecovery.restoreDoc` uses: that covers both the dedupe and
 * the empty-prefill branches, and skipping the write also preserves the
 * user's caret instead of resetting it for no reason.
 */
export function planPrefillMerge(input: {
  /** `textToDocument(prefillText)`. */
  prefillDoc: JSONContent;
  /** `prefillText.length === 0` — matches the old code's falsy-string guard
   *  (`if (!submitted) return current`), NOT a trimmed check: a prefill of
   *  only whitespace was appended by the old code too. */
  prefillIsEmpty: boolean;
  /** `editorRef.current.getDocument()`. */
  currentDoc: JSONContent;
  /** `editorRef.current.isEmpty()`. */
  currentIsEmpty: boolean;
}): JSONContent | null {
  const merged = mergeFailedSubmissionDocument(
    input.currentDoc,
    input.currentIsEmpty,
    input.prefillDoc,
    input.prefillIsEmpty,
  );
  return merged === input.currentDoc ? null : merged;
}

/**
 * Where a voice transcription goes — Task 14, matrix row 21.
 *
 * Old behaviour (`session-chat-input.tsx:1050-1052`) was
 * `setText(prev => (prev ? `${prev} ${text}` : text))`: append at the END of
 * the whole draft, joined by a single SPACE, without moving focus. The
 * rewrite had used `setContent(transcribedText, 'merge')`, which inserts at
 * the CURRENT SELECTION, separates with a block boundary, and ends with
 * `focus('end')`. Dictating with the caret parked mid-draft therefore dropped
 * the transcript into the middle of a sentence, and `"hello transcribed"`
 * went out as `"hello\n\ntranscribed"` — a different string reaching the
 * agent.
 *
 * Appending to the last block rather than concatenating a new one is what
 * makes the separator a space instead of a paragraph break.
 *
 * The `else` branch is a whitelist fallback, not dead code, even though
 * `paragraph` is now the only block type the composer schema defines
 * (`editor/extensions.ts` — lists, blockquotes and code blocks are gone).
 * This function takes a `JSONContent` from a CALLER, not from the live
 * editor: a prefill, a restored draft, or a failed-send snapshot can carry
 * any shape. Appending a text node into a block that holds child blocks would
 * build an invalid document, so anything that is not a paragraph gets a fresh
 * paragraph instead — where a leading space would be meaningless.
 */
export function appendTranscribedText(
  doc: JSONContent,
  isEmpty: boolean,
  transcribedText: string,
): JSONContent {
  if (!transcribedText) return doc;
  if (isEmpty) return textToDocument(transcribedText);

  const blocks = [...(doc.content ?? [])];
  const last = blocks[blocks.length - 1];

  if (last?.type === 'paragraph') {
    blocks[blocks.length - 1] = {
      ...last,
      content: [...(last.content ?? []), { type: 'text', text: ` ${transcribedText}` }],
    };
  } else {
    blocks.push({ type: 'paragraph', content: [{ type: 'text', text: transcribedText }] });
  }

  return { type: 'doc', content: blocks };
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
  lockForApproval: boolean;
  lockForQuestion: boolean;
  questionButtonLabel?: string | null;
  /** The caller-supplied default placeholder (`SessionChatInputProps.placeholder`). */
  placeholder: string;
}

/**
 * Which placeholder string `ComposerEditor` should show right now.
 *
 * Precedence matches the old custom-overlay conditionals
 * (session-chat-input.tsx:1227-1272): the approval lock beats the question
 * lock, which beats the caller's own placeholder.
 *
 * A staged command used to sit at the top of this list with its own prompt
 * ("Enter details and press Enter, or press Esc to cancel"). It is gone
 * because the state it described is gone: a picked command is now an inline
 * chip in the document (`editor/mention-node.ts`), which makes the document
 * NON-EMPTY — and a placeholder only ever renders on an empty document. The
 * branch was not removed as a simplification; it had become unreachable by
 * construction, and the chip itself is what tells the user what they picked.
 */
export function resolveEditorPlaceholder({
  lockForApproval,
  lockForQuestion,
  questionButtonLabel,
  placeholder,
}: ResolveEditorPlaceholderInput): string {
  if (lockForApproval) return 'Approve or deny the action above to continue…';
  if (lockForQuestion) {
    return questionButtonLabel ? 'Or type your own answer…' : 'Type your answer…';
  }
  return placeholder;
}

export interface PlanDraftSubmissionInput {
  /** `getContent().commandName` — the `/` chip leading the draft, if any. */
  commandName: string | undefined;
  /** `getContent().text` — already excludes the chip, so this IS the args. */
  text: string;
  /** The live command list the chip is resolved against. */
  commands: Command[];
}

export type DraftSubmissionPlan =
  | { kind: 'command'; command: Command; args?: string }
  | { kind: 'message'; text: string };

/**
 * Decide whether a draft runs a command or sends a message.
 *
 * The interesting case is the third branch. A command chip carries the
 * command's NAME, not the `Command` object — attributes have to survive the
 * JSON round trip that failed-send recovery and the question lock put the
 * document through, and an object graph does not. So the name is resolved
 * against the live list at submit time, and that lookup can miss: the command
 * list is refetched while a menu opens (`useMenuRevalidation`), a skill can be
 * deleted, and a recovered draft can outlive the command it names.
 *
 * A miss must not silently drop the user's text. `text` excludes the chip, so
 * returning it unchanged would send the arguments with no indication of what
 * they were arguments FOR. Re-inlining `/name` in front of them keeps the
 * message the user actually composed intact and legible, and lets the agent
 * see what was intended — the failure degrades to plain text instead of
 * discarding information.
 */
export function planDraftSubmission({
  commandName,
  text,
  commands,
}: PlanDraftSubmissionInput): DraftSubmissionPlan {
  const trimmed = text.trim();
  if (!commandName) return { kind: 'message', text: trimmed };

  const command = commands.find((candidate) => candidate.name === commandName);
  if (command) return { kind: 'command', command, args: trimmed || undefined };

  return { kind: 'message', text: `/${commandName} ${trimmed}`.trim() };
}

/**
 * Should a pointer press on the editor's padded wrapper put the caret in the
 * editor?
 *
 * The wrapper carries the composer's inner padding (`px-2 pb-6`), and padding
 * belongs to the wrapper's box, NOT to the contenteditable inside it. So the
 * bottom 24px and an 8px strip down each side looked like the input and were
 * dead: pressing there hit the `div`, the editor never took focus, and nothing
 * happened. The band is directly under the last line — exactly where someone
 * clicks to resume typing — so it reads as the input being broken.
 *
 * `onWrapperItself` is the whole guard, and it is load-bearing in the other
 * direction. A press on a DESCENDANT is ProseMirror's: that is how the caret
 * lands where you clicked, how a drag selects a range, and how a click on a
 * mention chip reaches its own handler. Forwarding those would collapse every
 * in-editor click to the document end and make text unselectable — trading one
 * broken interaction for a worse one. Only a press that terminates on the
 * wrapper is padding.
 *
 * Focus goes to the END rather than the nearest position, which is correct for
 * the case this exists to fix: the dead band sits below the last line, and
 * "click under the text to keep typing" means the end in every editor people
 * already use. The side strips are 8px and inherit the same rule.
 */
export function shouldFocusEditorFromPadding(input: {
  /** The press terminated on the padded wrapper, not on a descendant. */
  onWrapperItself: boolean;
  /** The editor cannot accept focus (disabled, or locked for approval). */
  disabled: boolean;
}): boolean {
  return input.onWrapperItself && !input.disabled;
}
