import type { JSONContent } from '@tiptap/core';

import type { AttachedFile, TrackedMention } from './session-chat-input';

export function mergeFailedSubmissionText(current: string, submitted: string): string {
  if (!current) return submitted;
  if (!submitted || current === submitted) return current;
  return `${submitted}\n\n${current}`;
}

/**
 * `mergeFailedSubmissionText`'s counterpart for the ProseMirror document
 * itself — Task 13. `mergeFailedSubmissionText`/`mergeFailedSubmissionMentions`
 * both worked on the OLD composer's two parallel pieces of state (a plain
 * `text` string plus a separately-tracked `mentions: TrackedMention[]`
 * array, kept in sync by `session-chat-input.tsx`'s own label-matching
 * pruning). The new composer has no such second array — mentions live
 * exclusively as `mention` ATOM nodes inside the ProseMirror document
 * (`editor/serialize.ts`), so restoring "the submitted text, merged with
 * whatever was typed meanwhile" has to operate on the document itself, or
 * every mention involved silently flattens to plain, unlinked `"@label"`
 * text — which reads fine but produces no `<file_ref>`/`<agent_ref>`/
 * `<session_ref>` block on the next send (those blocks are built from the
 * STRUCTURED mentions array, not the text — `editor/serialize.ts`'s own doc
 * comment).
 *
 * Mirrors `mergeFailedSubmissionText`'s exact three-branch contract, same
 * argument order (`current` first, `submitted` second) and same semantics,
 * just on `JSONContent` instead of `string`:
 *  - nothing left in the doc after the retry attempt → the submitted
 *    document restores verbatim, mentions and all.
 *  - the submitted doc was itself empty (a files-only send with no text/
 *    mentions) or is byte-identical to current → leave `current` untouched,
 *    exactly like the text version's dedupe.
 *  - both non-empty and different → concatenate as a ProseMirror fragment
 *    (submitted's paragraphs first, current's after, one blank paragraph
 *    between — the doc-level equivalent of `${submitted}\n\n${current}`),
 *    preserving every mention atom node from both sides.
 *
 * `currentIsEmpty`/`submittedIsEmpty` are passed in rather than re-derived
 * from `JSONContent` here on purpose: the canonical definition of "empty"
 * for a TipTap document is `editor.isEmpty`, and the caller (`composer.tsx`)
 * already has a live `ComposerEditorHandle.isEmpty()` to read at the exact
 * moments these snapshots are taken. Re-implementing that definition from
 * raw JSON here would risk drifting from it.
 */
export function mergeFailedSubmissionDocument(
  current: JSONContent,
  currentIsEmpty: boolean,
  submitted: JSONContent,
  submittedIsEmpty: boolean,
): JSONContent {
  if (currentIsEmpty) return submitted;
  if (submittedIsEmpty) return current;
  if (JSON.stringify(current) === JSON.stringify(submitted)) return current;
  return {
    type: 'doc',
    content: [...(submitted.content ?? []), { type: 'paragraph' }, ...(current.content ?? [])],
  };
}

function attachedFileKey(file: AttachedFile): string {
  return file.kind === 'local'
    ? `local:${file.localUrl}`
    : `remote:${file.url}:${file.filename}`;
}

export function mergeFailedSubmissionFiles(
  current: AttachedFile[],
  submitted: AttachedFile[],
): AttachedFile[] {
  const seen = new Set<string>();
  return [...submitted, ...current].filter((file) => {
    const key = attachedFileKey(file);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mentionKey(mention: TrackedMention): string {
  return `${mention.kind}:${mention.value ?? ''}:${mention.label}`;
}

export function mergeFailedSubmissionMentions(
  current: TrackedMention[],
  submitted: TrackedMention[],
): TrackedMention[] {
  const seen = new Set<string>();
  return [...submitted, ...current].filter((mention) => {
    const key = mentionKey(mention);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
