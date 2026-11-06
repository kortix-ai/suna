import type { ArtifactCommentThread, ArtifactLiveParticipant } from '@kortix/sdk';
import { getSchema } from '@tiptap/core';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import { DOMParser as PMParser, type Node as PMNode } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import { beforeAll, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { markdownToHtml } from '@kortix/ui/markdown/doc-editor/markdown';
import { docExtensions } from '@kortix/ui/markdown/doc-editor/doc-extensions';
import { ARTIFACT_REANCHOR_READ_UNITS, type ArtifactReanchorBudget } from '@kortix/shared/artifact-comments';
import { EditorState } from '@tiptap/pm/state';
import type { DecorationSet } from '@tiptap/pm/view';
import { createDocLivePlugin, docLiveDecorations, docLivePeers, docLivePluginKey } from './doc-live-decorations';
import {
  cachedDocMarkdownPositions,
  docLiveCursor,
  docLiveRange,
  docPositionForSource,
  docSourceOffset,
  resolveDocLiveCursor,
  resolveDocLivePlaces,
  resolveDocLiveRange,
  type DocLivePeerAnchors,
  type DocLiveReanchor,
  type DocLiveResolution,
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

  test('carets land on the same words in front matter (a raw block) and in a * list kept by `md`', () => {
    // The editor's own schema: a raw block is `rawMarkdown`, a kept block carries `md` (doc-fidelity.ts).
    const editorSchema = getSchema(docExtensions({ editable: false, placeholder: () => '' }));
    const markdown = '---\ntitle: Launch plan\n---\n\n* Ship the importer\n* Fix the parser\n\nDone today.\n';
    const element = window.document.createElement('div');
    element.innerHTML = markdownToHtml(markdown);
    const doc = PMParser.fromSchema(editorSchema).parse(element as unknown as HTMLElement);
    expect(doc.firstChild?.type.name).toBe('rawMarkdown');
    expect(doc.child(1).attrs.md?.src).toBe('* Ship the importer\n* Fix the parser');
    const map = cachedDocMarkdownPositions(markdown, doc);
    for (const word of ['Launch', 'parser', 'today']) {
      const pos = at(doc, word);
      const offset = docSourceOffset(map, pos)!;
      expect(markdown.slice(offset, offset + word.length)).toBe(word);
      // The caret another viewer receives comes back to the same editor position.
      expect(docPositionForSource(map, resolveDocLiveCursor(markdown, docLiveCursor(markdown, offset)!)!)).toBe(pos);
    }
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
    const { set } = docLiveDecorations({ markdown: MARKDOWN, peers }, doc);
    const found = set.find();
    expect(found).toHaveLength(1);
    expect(found[0]!.from).toBe(at(doc, 'expansion revenue'));
  });

  test('a person draws a caret and a tinted selection', () => {
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
    const found = docLiveDecorations({ markdown: MARKDOWN, peers }, doc).set.find();
    const selection = found.find((item) => item.from !== item.to)!;
    expect(doc.textBetween(selection.from, selection.to)).toBe('Pricing moved');
    expect(found.some((item) => item.from === item.to && item.from === at(doc, 'Pricing'))).toBe(true);
  });

  test('the plugin draws each frame, keeps its resolution for the next, and maps between frames', () => {
    const start = MARKDOWN.indexOf('Pricing');
    const peers = docLivePeers(
      [participant({ id: 'ana', cursor: docLiveCursor(MARKDOWN, start) })],
      [],
      () => '',
    );
    const plugin = createDocLivePlugin();
    let state = EditorState.create({ doc: parse(MARKDOWN), plugins: [plugin] });
    const carets = () => (plugin.props.decorations!.call(plugin, state) as DecorationSet).find();
    for (const pass of [1, 2]) {
      state = state.apply(state.tr.setMeta(docLivePluginKey, { markdown: MARKDOWN, peers }));
      expect(carets().map((item) => item.from)).toEqual([at(state.doc, 'Pricing')]);
      expect(docLivePluginKey.getState(state)!.resolution!.pass).toBe(pass);
    }
    // A local edit before the caret moves it with the text.
    state = state.apply(state.tr.insertText('Q3 ', 1));
    expect(carets().map((item) => item.from)).toEqual([at(state.doc, 'Pricing')]);
  });
});

describe('doc live resolution: the cost of one presence pass', () => {
  // A large doc: one read budget (ARTIFACT_REANCHOR_READ_UNITS) would buy 16 whole-document scans of it.
  const LARGE = 'x'.repeat(1 << 20);
  /** A presence pass may spend 4 × the Markdown length: 4 whole-document scans. */
  const PASS_UNITS = 4 * LARGE.length;
  const HONEST = 'expansion revenue grew in every region';
  const MOVED = 'Pricing moved to seats';
  /** The honest caret's words on frame `frame`: it moves every frame. */
  const honestAt = (frame: number) => `${HONEST} (${frame})`;

  /**
   * A fake re-anchor: one whole-document scan per call the budget lets through, tested
   * before it is charged (as `reanchorArtifactText` does). Only `found` quotes match. A found
   * quote costs `foundShare` of a scan: a real exact match is two native scans, about a quarter.
   */
  function countingReanchor(found: ReadonlyMap<string, number>, foundShare = 1) {
    const spent = { scans: 0, units: 0 };
    const scan = (markdown: string, quote: string, budget: ArtifactReanchorBudget) => {
      if (budget.remaining <= 0) return null;
      const units = found.has(quote) ? markdown.length * foundShare : markdown.length;
      budget.remaining -= units;
      spent.scans++;
      spent.units += units;
      return found.get(quote) ?? null;
    };
    const reanchor: DocLiveReanchor = {
      cursor: (markdown, at, budget) => scan(markdown, at.quote, budget),
      range: (markdown, range, budget) => {
        const start = scan(markdown, range.quote, budget);
        return start === null ? null : { start, end: start + range.quote.length };
      },
    };
    return { reanchor, spent };
  }

  /** A participant whose caret and selection are 64 code units that occur nowhere, new each frame. */
  const crafted = (n: number, frame: number): DocLivePeerAnchors => ({
    id: `crafted-${n}`,
    cursor: { quote: `${n}:${frame}:caret:`.padEnd(64, 'q'), prefix: '', offset: 0 },
    selection: { quote: `${n}:${frame}:selection:`.padEnd(64, 'q'), prefix: '', suffix: '' },
  });
  const craftedRoom = (frame: number) => Array.from({ length: 8 }, (_, n) => crafted(n, frame));
  const honest: DocLivePeerAnchors = {
    id: 'honest',
    cursor: { quote: HONEST, prefix: '', offset: 0 },
    selection: null,
  };

  test('one pass spends at most 4 × the Markdown length, however many participants send unmatched quotes', () => {
    expect(ARTIFACT_REANCHOR_READ_UNITS / LARGE.length).toBe(16);
    const { reanchor, spent } = countingReanchor(new Map());
    const { places } = resolveDocLivePlaces(LARGE, craftedRoom(1), null, reanchor);
    // 8 participants × (selection + caret) is 16 scans: the pass buys 4.
    expect(spent.units).toBeLessThanOrEqual(PASS_UNITS);
    expect(spent.scans).toBe(4);
    // Quotes that match nothing never draw anything.
    for (const place of places.values()) expect(place).toEqual({ selection: null, cursor: null });
  });

  test('an unchanged participant costs no scan on the next pass; an edit re-anchors everyone', () => {
    const { reanchor, spent } = countingReanchor(new Map([[HONEST, 1000]]));
    const peers = [honest, crafted(0, 1)];
    const first = resolveDocLivePlaces(LARGE, peers, null, reanchor);
    expect(spent.scans).toBe(3);
    expect(first.places.get('honest')).toEqual({ selection: null, cursor: 1000 });
    const second = resolveDocLivePlaces(LARGE, peers, first.resolution, reanchor);
    expect(spent.scans).toBe(3);
    expect(second.places).toEqual(first.places);
    // The same positions in edited Markdown: the cache no longer holds.
    resolveDocLivePlaces(`${LARGE}y`, peers, second.resolution, reanchor);
    expect(spent.scans).toBe(6);
  });

  test('8 participants with a new unmatched quote every frame: an honest moving caret is drawn every ≤ 3 passes', () => {
    const FRAMES = 12;
    const found = new Map(Array.from({ length: FRAMES }, (_, i) => [honestAt(i + 1), 1000 + i + 1] as const));
    const { reanchor, spent } = countingReanchor(found);
    let resolution: DocLiveResolution | null = null;
    const drawnOn: number[] = [];
    for (let frame = 1; frame <= FRAMES; frame++) {
      const before = spent.units;
      // Listed last, behind 8 participants whose work is new every frame; its own caret moves too.
      const moving = { ...honest, cursor: { quote: honestAt(frame), prefix: '', offset: 0 } };
      const result = resolveDocLivePlaces(LARGE, [...craftedRoom(frame), moving], resolution, reanchor);
      expect(spent.units - before).toBeLessThanOrEqual(PASS_UNITS);
      resolution = result.resolution;
      const place = result.places.get('honest');
      // Drawn means drawn at this frame's place, never an older one.
      if (place) expect(place.cursor).toBe(1000 + frame);
      if (place) drawnOn.push(frame);
    }
    // Every 3 consecutive passes draw the honest caret at least once.
    for (let frame = 1; frame + 2 <= FRAMES; frame++)
      expect(drawnOn.some((drawn) => drawn >= frame && drawn <= frame + 2)).toBe(true);
  });

  test('a moved participant the pass cannot afford draws nothing, never its old place', () => {
    const { reanchor } = countingReanchor(new Map([[HONEST, 1000], [MOVED, 2000]]));
    const first = resolveDocLivePlaces(LARGE, [honest, ...craftedRoom(1)], null, reanchor);
    expect(first.places.get('honest')).toEqual({ selection: null, cursor: 1000 });
    const moved = { ...honest, cursor: { quote: MOVED, prefix: '', offset: 0 } };
    // Five crafted participants have cost less: they spend this pass before the moved caret.
    const second = resolveDocLivePlaces(LARGE, [moved, ...craftedRoom(2)], first.resolution, reanchor);
    expect(second.places.has('honest')).toBe(false);
  });

  test('a caret present before 8 participants join with a new unmatched quote every frame is drawn on every pass', () => {
    const FRAMES = 12;
    const found = new Map(Array.from({ length: FRAMES + 1 }, (_, frame) => [honestAt(frame), 1000 + frame] as const));
    const { reanchor, spent } = countingReanchor(found, 1 / 4);
    const movingAt = (frame: number) => ({ ...honest, cursor: { quote: honestAt(frame), prefix: '', offset: 0 } });
    let resolution = resolveDocLivePlaces(LARGE, [movingAt(0)], null, reanchor).resolution;
    for (let frame = 1; frame <= FRAMES; frame++) {
      const before = spent.units;
      const result = resolveDocLivePlaces(LARGE, [...craftedRoom(frame), movingAt(frame)], resolution, reanchor);
      // The budget, plus the one scan that crosses it.
      expect(spent.units - before).toBeLessThanOrEqual(PASS_UNITS + LARGE.length);
      resolution = result.resolution;
      expect(result.places.get('honest')).toEqual({ selection: null, cursor: 1000 + frame });
    }
  });

  test('participants that join go behind those present: a present caret is drawn on the pass they arrive', () => {
    const { reanchor } = countingReanchor(new Map([[HONEST, 1000], [MOVED, 2000]]));
    const first = resolveDocLivePlaces(LARGE, [honest], null, reanchor);
    const moved = { ...honest, cursor: { quote: MOVED, prefix: '', offset: 0 } };
    // Eight participants arrive, listed first, and the present caret moves in the same frame.
    const second = resolveDocLivePlaces(LARGE, [...craftedRoom(2), moved], first.resolution, reanchor);
    expect(second.places.get('honest')).toEqual({ selection: null, cursor: 2000 });
  });
});
