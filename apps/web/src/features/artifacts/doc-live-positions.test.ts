import type { ArtifactCommentThread, ArtifactLiveParticipant } from '@kortix/sdk';
import { getSchema } from '@tiptap/core';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import { DOMParser as PMParser, type Node as PMNode } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import { beforeAll, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { markdownToHtml } from '@kortix/ui/markdown/doc-editor/markdown';
import { docLiveDecorations, docLivePeers } from './doc-live-decorations';
import {
  cachedDocMarkdownPositions,
  docLiveCursor,
  docLiveRange,
  docPositionForSource,
  docSourceOffset,
  resolveDocLiveCursor,
  resolveDocLiveRange,
} from './doc-live-positions';

const window = new Window();
const schema = getSchema([StarterKit, TableKit, TaskList, TaskItem]);
beforeAll(() => {
  (globalThis as { DOMParser?: unknown }).DOMParser = window.DOMParser;
  (globalThis as { document?: unknown }).document = window.document;
});
const parse = (markdown: string) => {
  const element = window.document.createElement('div');
  element.innerHTML = markdownToHtml(markdown);
  return PMParser.fromSchema(schema).parse(element as unknown as HTMLElement);
};
/** The editor position just before `quote` in the doc's text. */
function at(doc: PMNode, quote: string): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (!node.isText || found !== -1) return;
    const index = node.text!.indexOf(quote);
    if (index !== -1) found = pos + index;
  });
  if (found === -1) throw new Error('Synthetic text missing');
  return found;
}

const MARKDOWN = [
  '# Quarterly review',
  '',
  'Churn fell to **3 percent** this quarter, and expansion revenue grew in every region.',
  '',
  '- Pricing moved to seats',
  '- Support answers in one hour',
].join('\n');

describe('doc caret as a text anchor', () => {
  test('a caret travels as ≤ 64 code units around it, ≤ 32 of context, and its offset', () => {
    const doc = parse(MARKDOWN);
    const map = cachedDocMarkdownPositions(MARKDOWN, doc);
    const caretPos = at(doc, 'percent');
    const offset = docSourceOffset(map, caretPos)!;
    expect(MARKDOWN.slice(offset, offset + 7)).toBe('percent');
    const cursor = docLiveCursor(MARKDOWN, offset)!;
    expect(cursor.quote.length).toBeLessThanOrEqual(64);
    expect(cursor.prefix.length).toBeLessThanOrEqual(32);
    expect(cursor.quote.slice(cursor.offset, cursor.offset + 7)).toBe('percent');
    // Back to the same editor position.
    expect(docPositionForSource(map, resolveDocLiveCursor(MARKDOWN, cursor)!)).toBe(caretPos);
  });

  test("another viewer's edited Markdown still places the caret on the same words", () => {
    const doc = parse(MARKDOWN);
    const offset = docSourceOffset(cachedDocMarkdownPositions(MARKDOWN, doc), at(doc, 'expansion'))!;
    const cursor = docLiveCursor(MARKDOWN, offset)!;
    // The other viewer added a paragraph above and changed a word near the caret.
    const theirs = MARKDOWN.replace('# Quarterly review', '# Quarterly review\n\nDraft for the board.').replace(
      'this quarter',
      'this period',
    );
    const theirDoc = parse(theirs);
    const resolved = resolveDocLiveCursor(theirs, cursor);
    expect(resolved).not.toBeNull();
    const pos = docPositionForSource(cachedDocMarkdownPositions(theirs, theirDoc), resolved!)!;
    expect(theirDoc.textBetween(pos, pos + 9)).toBe('expansion');
  });

  test('a caret whose words are gone is not drawn', () => {
    const cursor = docLiveCursor(MARKDOWN, MARKDOWN.indexOf('Support'))!;
    expect(resolveDocLiveCursor('# Something else entirely\n\nNo shared words here at all.', cursor)).toBeNull();
  });

  test('a caret at either end of the doc, and an empty doc', () => {
    const end = docLiveCursor(MARKDOWN, MARKDOWN.length)!;
    expect(end.offset).toBe(end.quote.length);
    expect(end.quote.length).toBe(64);
    const start = docLiveCursor(MARKDOWN, 0)!;
    expect(start).toMatchObject({ prefix: '', offset: 0 });
    expect(docLiveCursor('', 0)).toBeNull();
  });

  test('a caret never splits a surrogate pair', () => {
    const text = `${'a'.repeat(31)}🚀${'b'.repeat(70)}`;
    for (const caret of [0, 31, 33, 40, text.length]) {
      const cursor = docLiveCursor(text, caret)!;
      const first = cursor.quote.charCodeAt(0);
      const last = cursor.quote.charCodeAt(cursor.quote.length - 1);
      expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
  });

  test('a position in Markdown syntax snaps to the text', () => {
    const doc = parse(MARKDOWN);
    const map = cachedDocMarkdownPositions(MARKDOWN, doc);
    // Inside "**" before "3 percent": the end of the text before it.
    const stars = MARKDOWN.indexOf('**3') + 1;
    expect(docPositionForSource(map, stars)).toBe(at(doc, '3 percent'));
  });
});

describe('doc selection as a text anchor', () => {
  test('a selection travels with context and re-anchors to the same span', () => {
    const start = MARKDOWN.indexOf('expansion revenue');
    const range = docLiveRange(MARKDOWN, start, start + 'expansion revenue'.length)!;
    expect(range).toMatchObject({ kind: 'doc', quote: 'expansion revenue' });
    expect(range.prefix.length).toBeLessThanOrEqual(32);
    expect(range.suffix.length).toBeLessThanOrEqual(32);
    expect(resolveDocLiveRange(MARKDOWN, range)).toEqual({ start, end: start + 17 });
  });

  test('a selection longer than a quote holds sends its first 500 code units', () => {
    const long = 'x'.repeat(900);
    expect(docLiveRange(long, 0, 900)!.quote).toHaveLength(500);
    expect(docLiveRange(long, 10, 10)).toBeNull();
  });
});

const THREAD = '00000000-0000-4000-8000-0000000000f1';
const SESSION = '00000000-0000-4000-8000-0000000000aa';
const USER = '00000000-0000-4000-8000-00000000000a';

function participant(extra: Partial<ArtifactLiveParticipant>): ArtifactLiveParticipant {
  return {
    id: 'p',
    who: { kind: 'user', user_id: USER },
    name: 'Ana',
    avatar_url: null,
    color: 'green',
    status: 'viewing',
    view: 'doc',
    hidden: false,
    cursor: null,
    selection: null,
    typing: null,
    focus: null,
    ...extra,
  };
}

describe('doc live peers and decorations', () => {
  test("an agent without a cursor sits at its focused thread's passage, with its status", () => {
    const thread = {
      thread_id: THREAD,
      anchor: { type: 'text', version: 'v', quote: 'expansion revenue', prefix: 'quarter, and ', suffix: ' grew' },
    } as unknown as ArtifactCommentThread;
    const peers = docLivePeers(
      [
        participant({
          id: 'agent',
          who: { kind: 'session', session_id: SESSION, agent_name: 'kortix' },
          name: 'Kortix',
          status: 'editing',
          view: null,
          focus: THREAD,
        }),
        participant({ id: 'idle' }),
      ],
      [thread],
      (status) => `status:${status}`,
    );
    expect(peers).toEqual([
      {
        id: 'agent',
        name: 'Kortix',
        color: 'green',
        agent: true,
        status: 'status:editing',
        cursor: { quote: 'expansion revenue', prefix: 'quarter, and ', offset: 0 },
        selection: null,
      },
    ]);
    const doc = parse(MARKDOWN);
    const set = docLiveDecorations({ markdown: MARKDOWN, peers }, doc);
    const found = set.find();
    expect(found).toHaveLength(1);
    expect(found[0]!.from).toBe(at(doc, 'expansion revenue'));
  });

  test('a person draws a caret and a tinted selection; budgets are per participant', () => {
    const start = MARKDOWN.indexOf('Pricing');
    const peers = docLivePeers(
      [
        participant({
          id: 'ana',
          cursor: docLiveCursor(MARKDOWN, start),
          selection: docLiveRange(MARKDOWN, start, start + 'Pricing moved'.length),
        }),
      ],
      [],
      () => '',
    );
    const doc = parse(MARKDOWN);
    const found = docLiveDecorations({ markdown: MARKDOWN, peers }, doc).find();
    const selection = found.find((item) => item.from !== item.to)!;
    expect(doc.textBetween(selection.from, selection.to)).toBe('Pricing moved');
    expect(found.some((item) => item.from === item.to && item.from === at(doc, 'Pricing'))).toBe(true);
  });
});
