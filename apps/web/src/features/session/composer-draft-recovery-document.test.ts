import { describe, expect, test } from 'bun:test';
import type { JSONContent } from '@tiptap/core';

import { mergeFailedSubmissionDocument } from './composer-draft-recovery';

/**
 * `mergeFailedSubmissionDocument` — Task 13's document-aware counterpart to
 * `mergeFailedSubmissionText` (covered by `composer-draft-recovery.test.ts`,
 * left untouched). Kept in its own file rather than appended to that one:
 * the brief for this task requires `composer-draft-recovery.test.ts` to pass
 * UNTOUCHED, and a new file is the only way to add coverage for new,
 * additive logic in that module without editing it.
 *
 * These are plain `JSONContent` object literals — no ProseMirror runtime, no
 * DOM, no `Editor` construction needed. The mention nodes below have the
 * exact shape `editor/serialize.ts`'s `collectMentions` and
 * `editor/mention-node.ts` produce (`{ type: 'mention', attrs: { kind,
 * label, value } }`), so a reader can trust these fixtures reflect a real
 * document, not an invented shape.
 */

function paragraph(text: string): JSONContent {
  return { type: 'paragraph', content: [{ type: 'text', text }] };
}

function mentionParagraph(label: string): JSONContent {
  return {
    type: 'paragraph',
    content: [{ type: 'mention', attrs: { kind: 'file', label, value: '' } }],
  };
}

function doc(...paragraphs: JSONContent[]): JSONContent {
  return { type: 'doc', content: paragraphs };
}

const EMPTY_DOC = doc({ type: 'paragraph' });

describe('mergeFailedSubmissionDocument', () => {
  test('restores the submitted document verbatim when nothing was typed meanwhile', () => {
    const submitted = doc(mentionParagraph('README.md'), paragraph('twenty minutes of work'));

    const merged = mergeFailedSubmissionDocument(EMPTY_DOC, true, submitted, false);

    expect(merged).toBe(submitted);
  });

  test('a mention atom node in the submitted document survives the restore untouched', () => {
    const submitted = doc(mentionParagraph('README.md'));

    const merged = mergeFailedSubmissionDocument(EMPTY_DOC, true, submitted, false);

    expect(merged.content?.[0]?.content?.[0]).toEqual({
      type: 'mention',
      attrs: { kind: 'file', label: 'README.md', value: '' },
    });
  });

  test('leaves the current draft untouched when the submitted doc was files-only (no text/mentions)', () => {
    const current = doc(paragraph('new follow-up'));
    const submittedEmpty = EMPTY_DOC;

    const merged = mergeFailedSubmissionDocument(current, false, submittedEmpty, true);

    expect(merged).toBe(current);
  });

  test('leaves the current draft untouched when it is byte-identical to the submitted doc', () => {
    const current = doc(paragraph('same text'));
    const submitted = doc(paragraph('same text'));

    const merged = mergeFailedSubmissionDocument(current, false, submitted, false);

    expect(merged).toBe(current);
  });

  test('concatenates submitted-first, current-after, preserving mentions from BOTH sides', () => {
    const submitted = doc(mentionParagraph('README.md'), paragraph('original prompt'));
    const current = doc(mentionParagraph('src/app.tsx'), paragraph('new follow-up'));

    const merged = mergeFailedSubmissionDocument(current, false, submitted, false);

    expect(merged).toEqual({
      type: 'doc',
      content: [
        mentionParagraph('README.md'),
        paragraph('original prompt'),
        { type: 'paragraph' },
        mentionParagraph('src/app.tsx'),
        paragraph('new follow-up'),
      ],
    });
  });

  test('two mentions with the SAME label in submitted and current both survive, undropped', () => {
    // The exact bug the whole mention-atom-node redesign exists to kill: a
    // string-based merge (`text.indexOf('@README.md')`) cannot distinguish
    // two mentions sharing a label. Each is its own atom node here, so the
    // merge is a pure array concat — nothing can collapse them. The two
    // documents differ (different trailing text) so this exercises the
    // concat branch, not the identical-retry dedupe branch covered above.
    const submitted = doc(mentionParagraph('README.md'), paragraph('first look'));
    const current = doc(mentionParagraph('README.md'), paragraph('second look'));

    const merged = mergeFailedSubmissionDocument(current, false, submitted, false);

    const mentionNodes = merged.content?.filter(
      (node) => node.content?.[0]?.type === 'mention',
    );
    expect(mentionNodes).toHaveLength(2);
  });
});
