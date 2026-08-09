/**
 * Pure logic extracted out of `composer.tsx` — same discipline Tasks 6, 7,
 * 10 and 11 already applied to their own files. Both functions here are
 * small, but `shouldApplyPrefill` is where a real bug lived (fix round 1):
 * a prefill delivered before the lazy-loaded editor chunk resolves was
 * silently discarded, because the effect that applies it never re-ran once
 * the editor became ready. Pinning the guard as a pure function with tests
 * is what makes that regression provable instead of re-introducible.
 */

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
