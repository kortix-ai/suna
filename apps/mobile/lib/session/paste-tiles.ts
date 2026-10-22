/**
 * paste-tiles — finds a long paste in a composer's text change. React Native's
 * `TextInput` has no paste event, so the change handler compares the text it
 * had with the text it got. An insertion `shouldTilePaste` accepts is a paste
 * that becomes a "Pasted text" tile; typing and dictation insert a few
 * characters at a time and never reach the threshold.
 *
 * With the field's selection from before the change (`onSelectionChange` fires
 * after `onChangeText` for an edit, so the last one seen is the pre-paste one),
 * the insertion is exact: the text before the selection, the paste, the text
 * after it. Without one, or with one that does not fit the change (stale, or a
 * platform that reported the new caret first), a common prefix + suffix diff
 * finds it. The diff misreads a paste that starts like the text after the
 * cursor or like the selection it replaces; the selection path does not.
 */
import { shouldTilePaste } from '@kortix/shared';

export type TextSelection = { start: number; end: number };
type Insertion = { text: string; paste: string };

function insertionAtSelection(prev: string, next: string, { start, end }: TextSelection): Insertion | null {
  if (start < 0 || start > end || end > prev.length) return null;
  const head = prev.slice(0, start);
  const tail = prev.slice(end);
  if (next.length < head.length + tail.length || !next.startsWith(head) || !next.endsWith(tail)) return null;
  return { text: head + tail, paste: next.slice(start, next.length - tail.length) };
}

function insertionByDiff(prev: string, next: string): Insertion {
  let start = 0;
  while (start < prev.length && prev[start] === next[start]) start++;
  let end = 0;
  // The suffix may not reach into the prefix: `prev.length - start` is what is left of prev.
  while (end < prev.length - start && prev[prev.length - 1 - end] === next[next.length - 1 - end]) end++;
  return { text: next.slice(0, start) + next.slice(next.length - end), paste: next.slice(start, next.length - end) };
}

/** `text`: the field without the paste (a replaced selection stays gone). `paste`: the inserted text. */
export function extractPastedInsertion(prev: string, next: string, selection?: TextSelection | null): Insertion | null {
  const hit = (selection && insertionAtSelection(prev, next, selection)) || insertionByDiff(prev, next);
  return shouldTilePaste(hit.paste) ? hit : null;
}
