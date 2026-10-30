import { artifactCommentAnchorSchema } from '@kortix/shared/artifact-comments';
import { getSchema } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import { DOMParser as PMParser, type Node as PMNode } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import { beforeAll, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import {
  docMarkdownPositions,
  docRangesForSource,
  docSelectionAnchor,
} from './doc-comment-positions';
import { LinkEmbed } from '@kortix/ui/markdown/doc-editor/doc-embed';
import { markdownToHtml } from '@kortix/ui/markdown/doc-editor/markdown';

const window = new Window();
const schema = getSchema([StarterKit, TableKit, TaskList, TaskItem, Image, LinkEmbed]);
beforeAll(() => {
  (globalThis as { DOMParser?: unknown }).DOMParser = window.DOMParser;
});
const parse = (markdown: string) => {
  const element = window.document.createElement('div');
  element.innerHTML = markdownToHtml(markdown);
  return PMParser.fromSchema(schema).parse(element as unknown as HTMLElement);
};
function at(doc: PMNode, quote: string, occurrence = 0): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (!node.isText || found !== -1) return;
    const index = node.text!.indexOf(quote);
    if (index !== -1 && occurrence-- === 0) found = pos + index;
  });
  if (found === -1) throw new Error('Synthetic selection missing');
  return found;
}

describe('doc comment source positions', () => {
  test('a formatted selection uses raw Markdown context and maps highlights back into the editor', () => {
    const markdown = '# Forecast\n\nReview **final** forecast.\n';
    const doc = parse(markdown);
    const from = at(doc, 'final');
    const map = docMarkdownPositions(markdown, doc);
    const result = docSelectionAnchor(map, from, from + 5, 'commit-one');
    expect(result).toEqual({
      anchor: {
        type: 'text',
        version: 'commit-one',
        quote: 'final',
        prefix: '# Forecast\n\nReview **',
        suffix: '** forecast.\n',
      },
    });
    expect(
      docRangesForSource(map, markdown.indexOf('final'), markdown.indexOf('final') + 5),
    ).toEqual([{ from, to: from + 5 }]);
  });

  test('a selection across inline marks stores the exact contiguous Markdown span', () => {
    const markdown = 'Review **final** forecast.\n';
    const doc = parse(markdown);
    const result = docSelectionAnchor(
      docMarkdownPositions(markdown, doc),
      1,
      doc.content.size - 1,
      'commit-one',
    );
    expect(result).toMatchObject({ anchor: { quote: 'Review **final** forecast.' } });
  });

  test('entities, escapes and emoji preserve raw offsets without splitting UTF16 pairs', () => {
    const markdown = `${'a'.repeat(31)}😀 A &amp; B \\*C 😀\n`;
    const doc = parse(markdown);
    const from = at(doc, '&');
    const result = docSelectionAnchor(
      docMarkdownPositions(markdown, doc),
      from,
      from + 1,
      'commit-one',
    );
    expect(result).toMatchObject({ anchor: { quote: '&amp;' } });
    if ('anchor' in result)
      expect(artifactCommentAnchorSchema.safeParse(result.anchor).success).toBe(true);
    const emoji = at(doc, '😀');
    const anchor = docSelectionAnchor(
      docMarkdownPositions(markdown, doc),
      emoji,
      emoji + 2,
      'commit-one',
    );
    if ('anchor' in anchor)
      expect(artifactCommentAnchorSchema.safeParse(anchor.anchor).success).toBe(true);
    else throw new Error(anchor.error);
  });

  test.each([
    '- [x] Done\n- [ ] Review\n',
    '| Name | Value |\n| --- | --- |\n| Forecast | Ready |\n',
    '# Heading\n\n- First\n  - Nested\n\n> Quoted\n\n`inline  code`\n\n```ts\nconst ready = true;\n```\n',
    'First line\nnext line.\n\nLast.\n',
    'Before ![ignored](https://example.test/image.png) after.\n',
    'One &amp; two.\r\n\r\nA hard break.  \r\nNext.\r\n',
  ])('maps the editor representation of %s', (markdown) => {
    expect(docMarkdownPositions(markdown, parse(markdown))).not.toBeNull();
  });

  test('a long selection anchors its first bounded excerpt and does not split an emoji or entity', () => {
    const long = 'a'.repeat(33);
    expect(
      docSelectionAnchor(docMarkdownPositions(long, parse(long)), 1, 34, 'commit-one'),
    ).toMatchObject({ anchor: { quote: 'a'.repeat(32), suffix: 'a' } });
    const emoji = `${'a'.repeat(31)}😀 next passage.`;
    const doc = parse(emoji);
    const anchor = docSelectionAnchor(
      docMarkdownPositions(emoji, doc),
      1,
      doc.content.size - 1,
      'commit-one',
    );
    expect(anchor).toMatchObject({ anchor: { quote: 'a'.repeat(31) } });
    if ('anchor' in anchor)
      expect(artifactCommentAnchorSchema.safeParse(anchor.anchor).success).toBe(true);
    const entity = `${'a'.repeat(30)}&amp; next passage.`;
    expect(
      docSelectionAnchor(
        docMarkdownPositions(entity, parse(entity)),
        1,
        parse(entity).content.size - 1,
        'commit-one',
      ),
    ).toMatchObject({ anchor: { quote: 'a'.repeat(30) } });
  });

  test('a link card atom does not prevent comments on surrounding Markdown text', () => {
    const markdown =
      'Before.\n\n<div class="kx-embed"><a href="https://example.test/page"><span class="kx-embed-title">Synthetic page</span><span class="kx-embed-href">https://example.test/page</span></a></div>\n\nAfter.\n';
    const doc = parse(markdown);
    const from = at(doc, 'After');
    expect(
      docSelectionAnchor(docMarkdownPositions(markdown, doc), from, from + 5, 'commit-one'),
    ).toMatchObject({ anchor: { quote: 'After' } });
  });

  test('ambiguous and stale selections fail without manufacturing an anchor', () => {
    const block = `${'a'.repeat(40)}quote${'b'.repeat(40)}`;
    const duplicate = `${block}\n\n${block}\n`;
    const doc = parse(duplicate);
    const from = at(doc, 'quote', 1);
    expect(
      docSelectionAnchor(docMarkdownPositions(duplicate, doc), from, from + 5, 'commit-one'),
    ).toEqual({ error: 'ambiguous' });
    expect(docMarkdownPositions('Before.', parse('After.'))).toBeNull();
    expect(docSelectionAnchor(null, 1, 2, 'commit-one')).toEqual({ error: 'unmapped' });
  });
});
