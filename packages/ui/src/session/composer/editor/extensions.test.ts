import { getSchema } from '@tiptap/core';
import { describe, expect, test } from 'bun:test';

import { baseExtensions } from './extensions';
import { MentionNode } from './mention-node';

/**
 * The composer schema is plain text plus chips — nothing else.
 *
 * These tests exist because the rich-text extensions have already been removed
 * once and restored once (`0100711f00`). A third restore would be a one-line
 * edit to `extensions.ts` that no other test in this directory would notice:
 * every existing test builds its own document from JSON it wrote itself, so
 * adding `Bold` back changes none of them. Asserting on the SCHEMA is what
 * makes the removal enforceable rather than a comment someone can disagree
 * with silently.
 *
 * `getSchema` is the real `@tiptap/core` schema builder — the exact call
 * `Editor` makes internally — so this is the schema the live composer runs,
 * not a description of it.
 */
const schema = getSchema([...baseExtensions(() => ''), MentionNode]);

describe('composer schema — nodes', () => {
  test('holds exactly doc, paragraph, text, hardBreak and the chip atom', () => {
    // Sorted, so the assertion reads as a set rather than an ordering.
    expect(Object.keys(schema.nodes).sort()).toEqual([
      'doc',
      'hardBreak',
      'mention',
      'paragraph',
      'text',
    ]);
  });

  // A plain loop, not `test.each`: this repo's `@types/bun` does not type
  // `each` on the test callable (CLAUDE.md records the same 15 `tsc` errors in
  // three other files for exactly this), and a new test file should not add to
  // that baseline. One `test()` per name, generated in a loop, is equivalent
  // and type-clean.
  for (const name of ['bulletList', 'orderedList', 'listItem', 'blockquote', 'codeBlock']) {
    test(`has no ${name} node`, () => {
      expect(schema.nodes[name]).toBeUndefined();
    });
  }
});

describe('composer schema — marks', () => {
  test('defines NO marks at all', () => {
    // Not "no bold" — no mark type whatsoever. A message is plain text, so
    // there is no formatting for the document to carry and then lose on send.
    expect(Object.keys(schema.marks)).toEqual([]);
  });

  for (const name of ['bold', 'italic', 'strike', 'code', 'link']) {
    test(`has no ${name} mark`, () => {
      expect(schema.marks[name]).toBeUndefined();
    });
  }
});

describe('composer schema — what typing markdown actually does', () => {
  test('`**bold**` is six literal characters, not a mark', () => {
    // The behaviour the removal is FOR: markdown syntax stays as typed. It
    // used to be swallowed by an input rule into a bold mark that
    // `serialize.ts` then dropped, so the asterisks vanished and the emphasis
    // never reached the agent — the text silently lost information.
    const doc = schema.nodeFromJSON({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '**bold**' }] }],
    });

    expect(doc.textBetween(0, doc.content.size)).toBe('**bold**');
    expect(doc.firstChild?.firstChild?.marks).toHaveLength(0);
  });

  test('a document carrying a bold mark cannot be built at all', () => {
    // `nodeFromJSON` throws on an unknown mark type, which is the guarantee
    // that matters: no code path — prefill, draft restore, paste — can put
    // formatting into this editor, whatever JSON it hands over.
    expect(() =>
      schema.nodeFromJSON({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'bold', marks: [{ type: 'bold' }] }],
          },
        ],
      }),
    ).toThrow();
  });
});
