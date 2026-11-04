import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Editor, getSchema, type JSONContent } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Transform } from '@tiptap/pm/transform';
import { Window } from 'happy-dom';
import { docExtensions } from '@kortix/ui/markdown/doc-editor/doc-extensions';
import { htmlToMarkdown, markdownToHtml } from '@kortix/ui/markdown/doc-editor/markdown';

import { mediaUrls } from './doc-media';
import {
  MAX_EDITS,
  applyOutsideEdit,
  diffSequences,
  mergeOutsideEdit,
  planOutsideEdit,
  type Hunk,
  type MergeStep,
} from './doc-outside-edit';

// TipTap parses and prints HTML with the browser DOM (as doc-round-trip.test.ts).
const DOM_GLOBALS = ['window', 'document', 'DOMParser', 'Node', 'HTMLElement', 'Element', 'navigator'] as const;
const saved: Record<string, unknown> = {};
const editors: Editor[] = [];
beforeAll(() => {
  const win = new Window();
  for (const key of DOM_GLOBALS) {
    saved[key] = (globalThis as Record<string, unknown>)[key];
    (globalThis as Record<string, unknown>)[key] = key === 'window' ? win : (win as unknown as Record<string, unknown>)[key];
  }
});
afterAll(() => {
  // Editors first: their views remove window listeners on destroy.
  editors.forEach((editor) => editor.destroy());
  for (const key of DOM_GLOBALS) (globalThis as Record<string, unknown>)[key] = saved[key];
});

const extensions = () => docExtensions({ editable: true, placeholder: () => '' });

/** A real editor with the doc schema, loaded the way the web editor loads a file. */
function open(markdown: string, toHtml: (markdown: string) => string = markdownToHtml): Editor {
  const editor = new Editor({ extensions: extensions(), content: toHtml(markdown) });
  editors.push(editor);
  return editor;
}

const markdownOf = (editor: Editor) => htmlToMarkdown(editor.getHTML());

/** The position just before `quote` in the doc's text. */
function at(doc: PMNode, quote: string): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found !== -1) return false;
    if (!node.isText) return true;
    const index = node.text!.indexOf(quote);
    if (index !== -1) found = pos + index;
    return false;
  });
  if (found === -1) throw new Error(`Synthetic text missing: ${quote}`);
  return found;
}

/** The person types `text` right after `quote`, as a keystroke does (in the undo history), and the caret ends after it. */
function typeAfter(editor: Editor, quote: string, text: string) {
  const pos = at(editor.state.doc, quote) + quote.length;
  editor.view.dispatch(editor.state.tr.insertText(text, pos));
  editor.commands.setTextSelection(pos + text.length);
}

/** The person selects `quote` and types `text` over it. */
function typeOver(editor: Editor, quote: string, text: string) {
  const from = at(editor.state.doc, quote);
  editor.view.dispatch(editor.state.tr.insertText(text, from, from + quote.length));
  editor.commands.setTextSelection(from + text.length);
}

/** The text around the caret: proves the caret stayed where the person left it. */
function caretContext(editor: Editor): string {
  const { from } = editor.state.selection;
  return editor.state.doc.textBetween(Math.max(1, from - 6), from, ' ');
}

describe('applyOutsideEdit: an outside edit of the file merges into the live doc', () => {
  test('an agent appends while a person types elsewhere: both land, the caret stays, undo reverts only the person', () => {
    const base = '# Plan\n\nThe first paragraph.\n\nThe second paragraph.\n';
    const editor = open(base);
    typeAfter(editor, 'The first paragraph.', ' Mine.');
    const caret = editor.state.selection.from;

    const result = applyOutsideEdit(editor, base, `${base}\nAn appended paragraph.\n`);

    expect(result).toEqual({ changed: true, conflicts: 0 });
    expect(markdownOf(editor)).toBe('# Plan\n\nThe first paragraph. Mine.\n\nThe second paragraph.\n\nAn appended paragraph.\n');
    expect(editor.state.selection.from).toBe(caret);
    expect(caretContext(editor)).toBe(' Mine.');
    // addToHistory: false — the person's undo reverts the person's typing, never the agent's text.
    editor.commands.undo();
    expect(markdownOf(editor)).toBe('# Plan\n\nThe first paragraph.\n\nThe second paragraph.\n\nAn appended paragraph.\n');
  });

  test('edits in different blocks both land', () => {
    const base = '# Notes\n\nAlpha is first.\n\nBeta is second.\n\nGamma is third.\n';
    const editor = open(base);
    typeAfter(editor, 'Alpha is first.', ' Person.');

    const theirs = '# Meeting notes\n\nAlpha is first.\n\nBeta is second.\n\nGamma comes third, says the agent.\n';
    const result = applyOutsideEdit(editor, base, theirs);

    expect(result).toEqual({ changed: true, conflicts: 0 });
    expect(markdownOf(editor)).toBe('# Meeting notes\n\nAlpha is first. Person.\n\nBeta is second.\n\nGamma comes third, says the agent.\n');
    expect(caretContext(editor)).toBe('erson.');
  });

  test('the same paragraph changed at different places keeps both changes, marks included', () => {
    const base = 'The quick brown fox jumps over the lazy dog.\n';
    const editor = open(base);
    typeAfter(editor, 'The ', 'very ');

    const result = applyOutsideEdit(editor, base, 'The quick brown fox jumps over the **sleepy** dog.\n');

    expect(result).toEqual({ changed: true, conflicts: 0 });
    expect(markdownOf(editor)).toBe('The very quick brown fox jumps over the **sleepy** dog.\n');
    expect(caretContext(editor)).toBe(' very ');
  });

  test('the same words changed on both sides: the person keeps theirs, the agent text lands right after, one conflict', () => {
    const base = 'Ship the release on Monday.\n\nNext paragraph.\n';
    const editor = open(base);
    typeOver(editor, 'Monday', 'Tuesday');

    const result = applyOutsideEdit(editor, base, 'Ship the release on Friday.\n\nNext paragraph.\n');

    expect(result).toEqual({ changed: true, conflicts: 1 });
    expect(markdownOf(editor)).toBe('Ship the release on Tuesday.\n\nShip the release on Friday.\n\nNext paragraph.\n');
  });

  test('different lines of one code block (a multi-line textblock, as a raw Markdown block is) both land', () => {
    const base = '```ts\nconst a = 1;\nconst b = 2;\nconst c = 3;\n```\n';
    const editor = open(base);
    typeOver(editor, 'a = 1', 'a = 10');

    const result = applyOutsideEdit(editor, base, '```ts\nconst a = 1;\nconst b = 2;\nconst c = 30;\n```\n');

    expect(result).toEqual({ changed: true, conflicts: 0 });
    expect(markdownOf(editor)).toBe('```ts\nconst a = 10;\nconst b = 2;\nconst c = 30;\n```\n');
  });

  test('an agent rewrites a paragraph the person typed in: no splice into the new text, one conflict', () => {
    const base = 'The launch moves to the second week of March.\n';
    const editor = open(base);
    typeAfter(editor, 'second week', ' (pending legal)');

    const result = applyOutsideEdit(editor, base, 'Marketing owns the launch date now.\n');

    expect(result).toEqual({ changed: true, conflicts: 1 });
    expect(markdownOf(editor)).toBe('The launch moves to the second week (pending legal) of March.\n\nMarketing owns the launch date now.\n');
  });

  test('a stale `md` source on a block the person edited before the last flush is not an edit: the agent deletes the list', () => {
    const file = 'Intro.\n\n* a\n* b\n';
    const editor = open(file);
    typeAfter(editor, 'b', 'c');
    // The leader flushes the person's edit natively; the live list keeps its stale `md.src`.
    const flushed = markdownOf(editor);
    expect(flushed).toBe('Intro.\n\n- a\n- bc\n');
    let listMd: unknown = null;
    editor.state.doc.forEach((block) => {
      if (block.type.name === 'bulletList') listMd = block.attrs.md;
    });
    expect(listMd).toMatchObject({ src: '* a\n* b' });

    const result = applyOutsideEdit(editor, flushed, 'Intro.\n');

    expect(result).toEqual({ changed: true, conflicts: 0 });
    expect(markdownOf(editor)).toBe('Intro.\n');
  });

  test('an agent changes a kept block type (a paragraph into a heading) while the person types elsewhere', () => {
    const base = 'Title\n\nBody text.\n';
    const editor = open(base);
    typeAfter(editor, 'Body text.', ' Typed.');

    const result = applyOutsideEdit(editor, base, '# Title\n\nBody text.\n');

    expect(result).toEqual({ changed: true, conflicts: 0 });
    expect(markdownOf(editor)).toBe('# Title\n\nBody text. Typed.\n');
  });

  test('the reset path: the person unsynced text merges once onto a doc freshly seeded from the file', () => {
    const file = '# Plan\n\nFirst paragraph.\n\nSecond paragraph.\n';
    const mine = '# Plan\n\nFirst paragraph. A sentence typed before the reset.\n\nSecond paragraph.\n';
    const fresh = open(file);

    expect(applyOutsideEdit(fresh, file, mine)).toEqual({ changed: true, conflicts: 0 });
    expect(markdownOf(fresh)).toBe(mine);

    // The winner's state already holds another tab's edit: both land, the sentence once.
    const winner = open(file);
    typeAfter(winner, 'Second paragraph.', ' From another tab.');
    expect(applyOutsideEdit(winner, file, mine)).toEqual({ changed: true, conflicts: 0 });
    expect(markdownOf(winner)).toBe(
      '# Plan\n\nFirst paragraph. A sentence typed before the reset.\n\nSecond paragraph. From another tab.\n',
    );
  });

  test('an agent deletes a block the person did not touch', () => {
    const base = 'Keep this.\n\nDelete this.\n\nAnd this stays.\n';
    const editor = open(base);
    typeAfter(editor, 'And this stays.', ' Typed.');

    const result = applyOutsideEdit(editor, base, 'Keep this.\n\nAnd this stays.\n');

    expect(result).toEqual({ changed: true, conflicts: 0 });
    expect(markdownOf(editor)).toBe('Keep this.\n\nAnd this stays. Typed.\n');
  });

  test('an agent deletes a block the person edited: the person block stays, one conflict', () => {
    const base = 'Keep this.\n\nDelete this.\n\nAnd this stays.\n';
    const editor = open(base);
    typeAfter(editor, 'Delete this.', ' But I typed here.');

    const result = applyOutsideEdit(editor, base, 'Keep this.\n\nAnd this stays.\n');

    expect(result).toEqual({ changed: false, conflicts: 1 });
    expect(markdownOf(editor)).toBe('Keep this.\n\nDelete this. But I typed here.\n\nAnd this stays.\n');
  });

  test('base == theirs is a no-op: no transaction, the same doc', () => {
    const base = '# Title\n\nBody text.\n';
    const editor = open(base);
    typeAfter(editor, 'Body text.', ' More.');
    const before = editor.state.doc;
    let transactions = 0;
    editor.on('transaction', () => {
      transactions += 1;
    });

    expect(applyOutsideEdit(editor, base, base)).toEqual({ changed: false, conflicts: 0 });
    expect(editor.state.doc).toBe(before);
    expect(transactions).toBe(0);
  });

  test('the same change on both sides lands once', () => {
    const base = 'One.\n\nTwo.\n';
    const editor = open(base);
    typeAfter(editor, 'Two.', ' Three.');

    expect(applyOutsideEdit(editor, base, 'One.\n\nTwo. Three.\n')).toEqual({ changed: false, conflicts: 0 });
    expect(markdownOf(editor)).toBe('One.\n\nTwo. Three.\n');
  });

  test('a list item changed and one appended by the agent while the person types in another item', () => {
    const base = '- Apples\n- Pears\n- Plums\n';
    const editor = open(base);
    typeAfter(editor, 'Apples', ' and figs');

    const result = applyOutsideEdit(editor, base, '- Apples\n- Pears\n- Cherries\n- Grapes\n');

    expect(result).toEqual({ changed: true, conflicts: 0 });
    expect(markdownOf(editor)).toBe('- Apples and figs\n- Pears\n- Cherries\n- Grapes\n');
    expect(caretContext(editor)).toBe('d figs');
  });

  test('the same list item changed on both sides: the agent item lands right after the person item, one conflict', () => {
    const base = '- Apples\n- Pears\n- Plums\n';
    const editor = open(base);
    typeOver(editor, 'Pears', 'Ripe pears');

    const result = applyOutsideEdit(editor, base, '- Apples\n- Green pears\n- Plums\n');

    expect(result).toEqual({ changed: true, conflicts: 1 });
    expect(markdownOf(editor)).toBe('- Apples\n- Ripe pears\n- Green pears\n- Plums\n');
  });

  test('a task checked by the agent while the person types in it', () => {
    const base = '- [ ] Write the brief\n- [ ] Ship it\n';
    const editor = open(base);
    typeAfter(editor, 'Write the brief', ' today');

    const result = applyOutsideEdit(editor, base, '- [x] Write the brief\n- [ ] Ship it\n');

    expect(result).toEqual({ changed: true, conflicts: 0 });
    expect(markdownOf(editor)).toBe('- [x] Write the brief today\n- [ ] Ship it\n');
  });

  test('a table cell changed by the agent while the person types in another cell', () => {
    const base = '| Area | Owner |\n| --- | --- |\n| API | Ana |\n| Web | Ben |\n\nAfter the table.\n';
    const editor = open(base);
    // The editor's own table Markdown is the base the leader last flushed.
    const flushed = markdownOf(editor);
    typeAfter(editor, 'API', ' gateway');

    const theirs = flushed.replace('| Ben |', '| Cleo |');
    expect(theirs).not.toBe(flushed);
    const result = applyOutsideEdit(editor, flushed, theirs);

    expect(result).toEqual({ changed: true, conflicts: 0 });
    expect(markdownOf(editor)).toBe(flushed.replace('| API |', '| API gateway |').replace('| Ben |', '| Cleo |'));
  });

  test('the same table cell changed on both sides keeps the person table and adds theirs right after, one conflict', () => {
    const base = '| Area | Owner |\n| --- | --- |\n| API | Ana |\n\nAfter the table.\n';
    const editor = open(base);
    const flushed = markdownOf(editor);
    typeOver(editor, 'Ana', 'Ana K');

    const theirs = flushed.replace('| Ana |', '| Dee |');
    const result = applyOutsideEdit(editor, flushed, theirs);

    expect(result).toEqual({ changed: true, conflicts: 1 });
    const [table, after] = flushed.split('\n\nAfter');
    expect(markdownOf(editor)).toBe(
      `${table.replace('| Ana |', '| Ana K |')}\n\n${table.replace('| Ana |', '| Dee |')}\n\nAfter${after}`,
    );
  });

  test('media load through the same resolver: an untouched image takes the agent change, no conflict', () => {
    const media = mediaUrls('https://files.example.test/p/doc/v1/index.html');
    const toHtml = (markdown: string) => media.resolveHtml(markdownToHtml(markdown));
    const base = '![chart](media/chart.png)\n\nText.\n';
    const editor = open(base, toHtml);
    typeAfter(editor, 'Text.', ' Typed.');

    const result = applyOutsideEdit(editor, base, '![revenue chart](media/chart.png)\n\nText.\n', { toHtml });

    expect(result).toEqual({ changed: true, conflicts: 0 });
    expect(htmlToMarkdown(media.restore(editor.getHTML()))).toBe('![revenue chart](media/chart.png)\n\nText. Typed.\n');
  });

});

/**
 * Large docs are built from schema JSON, not Markdown: under bun (JavaScriptCore)
 * `marked` parses 2,400 paragraphs in ~4.9 s, quadratically; V8 (the browser)
 * parses them in ~7 ms. The time bound is on the merge, which this file owns.
 */
const paragraph = (text: string): JSONContent => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const largeBlocks = (count: number): JSONContent[] =>
  Array.from({ length: count }, (_, i) =>
    i % 100 === 0
      ? { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: `Section ${i / 100}` }] }
      : paragraph(`Paragraph ${i} holds synthetic text for the large merge.`),
  );
const textsOf = (doc: PMNode) => {
  const texts: string[] = [];
  doc.forEach((block) => texts.push(block.textContent));
  return texts;
};

/** The steps applied last to first, as `mergeOutsideEdit` does, on a plain transform. */
function applySteps(doc: PMNode, steps: MergeStep[]): PMNode {
  const tr = new Transform(doc);
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i];
    if ('attrs' in step) tr.setNodeMarkup(step.pos, undefined, step.attrs);
    else tr.replaceWith(step.from, step.to, step.content);
  }
  return tr.doc;
}

describe('the merge stays bounded on large docs (real clock)', () => {
  test('2,400 blocks in a live editor: four agent edits and two person edits, one transaction under 500 ms', () => {
    const blocks = largeBlocks(2400);
    const editor = new Editor({ extensions: extensions(), content: { type: 'doc', content: blocks } });
    editors.push(editor);
    const base = editor.state.doc;
    typeAfter(editor, 'Paragraph 10 holds', ' (person)');
    typeAfter(editor, 'Paragraph 2390 holds', ' (person)');
    const theirsBlocks = blocks
      .map((block, i) => (i === 1500 ? paragraph('Paragraph 1500 was rewritten by the agent.') : i === 700 ? paragraph('Section 7, renamed') : block))
      .filter((_, i) => i !== 500);
    theirsBlocks.push(paragraph('An appended paragraph.'));
    const theirs = editor.schema.nodeFromJSON({ type: 'doc', content: theirsBlocks });

    const started = performance.now();
    const result = mergeOutsideEdit(editor, base, theirs);
    const elapsed = performance.now() - started;

    expect(result).toEqual({ changed: true, conflicts: 0 });
    const expected = textsOf(theirs).map((text) =>
      text.startsWith('Paragraph 10 ') || text.startsWith('Paragraph 2390 ') ? text.replace(' holds', ' holds (person)') : text,
    );
    expect(textsOf(editor.state.doc)).toEqual(expected);
    expect(caretContext(editor)).toBe('erson)');
    expect(elapsed).toBeLessThan(500);
  });

  test('an agent rewrites all 2,400 blocks while the person types in one: their block stays, one conflict, under 500 ms', () => {
    const blocks = largeBlocks(2400);
    const editor = new Editor({ extensions: extensions(), content: { type: 'doc', content: blocks } });
    editors.push(editor);
    const base = editor.state.doc;
    typeAfter(editor, 'Paragraph 1201 holds', ' (person)');
    const theirs = editor.schema.nodeFromJSON({ type: 'doc', content: blocks.map((_, i) => paragraph(`Block ${i}, rewritten by the agent.`)) });

    const started = performance.now();
    const result = mergeOutsideEdit(editor, base, theirs);
    const elapsed = performance.now() - started;

    expect(result).toEqual({ changed: true, conflicts: 1 });
    const expected = textsOf(theirs);
    expected.splice(1201, 0, 'Paragraph 1201 holds (person) synthetic text for the large merge.');
    expect(textsOf(editor.state.doc)).toEqual(expected);
    expect(caretContext(editor)).toBe('erson)');
    expect(elapsed).toBeLessThan(500);
  });

  test(`10,000 blocks, every third rewritten (past ${MAX_EDITS} edits): the person's edits survive, planned under 500 ms`, () => {
    const schema = getSchema(extensions());
    const blocks = largeBlocks(10_000);
    const base = schema.nodeFromJSON({ type: 'doc', content: blocks });
    const mineBlocks = blocks.map((block, i) => (i === 4 || i === 9_998 ? paragraph(`Paragraph ${i} holds synthetic text, typed by the person.`) : block));
    const theirsBlocks = blocks.map((block, i) => (i % 3 === 0 ? paragraph(`Block ${i}, rewritten by the agent.`) : block));
    const mine = schema.nodeFromJSON({ type: 'doc', content: mineBlocks });
    const theirs = schema.nodeFromJSON({ type: 'doc', content: theirsBlocks });

    const started = performance.now();
    const { steps, conflicts } = planOutsideEdit(base, mine, theirs);
    const elapsed = performance.now() - started;

    expect(conflicts).toBe(0);
    const expected = textsOf(theirs).map((text, i) => (i === 4 || i === 9_998 ? textsOf(mine)[i] : text));
    expect(textsOf(applySteps(mine, steps))).toEqual(expected);
    expect(elapsed).toBeLessThan(500);
  });
});

/** The LCS length by dynamic programming: the reference for the diff's minimality. */
function lcsLength(a: number[], b: number[]): number {
  const row = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const above = row[j];
      row[j] = a[i - 1] === b[j - 1] ? diagonal + 1 : Math.max(row[j], row[j - 1]);
      diagonal = above;
    }
  }
  return row[b.length];
}

/** A seeded generator: the random cases are the same on every run. */
function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

/** Applies the hunks to `a` and expects `b`; returns how many elements of `a` stayed. */
function expectRebuilds(a: number[], b: number[], hunks: Hunk[]): number {
  const out: number[] = [];
  let ai = 0;
  let bi = 0;
  for (const h of hunks) {
    // Ordered, disjoint, never empty, and equal between hunks.
    expect(h.aStart).toBeGreaterThanOrEqual(ai);
    expect(h.aStart - ai).toBe(h.bStart - bi);
    expect(h.aEnd - h.aStart + h.bEnd - h.bStart).toBeGreaterThan(0);
    out.push(...a.slice(ai, h.aStart), ...b.slice(h.bStart, h.bEnd));
    ai = h.aEnd;
    bi = h.bEnd;
  }
  out.push(...a.slice(ai));
  expect(out).toEqual(b);
  return a.length - hunks.reduce((sum, h) => sum + h.aEnd - h.aStart, 0);
}

describe('diffSequences: the bounded diff under the merge', () => {
  test('its hunks turn a into b with a minimal edit (the LCS), on 500 random cases', () => {
    const next = random(42);
    for (let run = 0; run < 500; run += 1) {
      const a = Array.from({ length: Math.floor(next() * 30) }, () => Math.floor(next() * 5));
      const b = Array.from({ length: Math.floor(next() * 30) }, () => Math.floor(next() * 5));
      expect(expectRebuilds(a, b, diffSequences(a, b))).toBe(lcsLength(a, b));
    }
  });

  test('past the edit cap the anchored fallback still rebuilds b exactly, on 500 random cases', () => {
    const next = random(7);
    for (let run = 0; run < 500; run += 1) {
      const a = Array.from({ length: Math.floor(next() * 60) }, () => Math.floor(next() * 40));
      const b = Array.from({ length: Math.floor(next() * 60) }, () => Math.floor(next() * 40));
      expectRebuilds(a, b, diffSequences(a, b, 3));
    }
  });

  test(`10,000 blocks with every third rewritten (past ${MAX_EDITS} edits): anchored on unique blocks, under 300 ms`, () => {
    const a = Array.from({ length: 10_000 }, (_, i) => i);
    const b = Array.from({ length: 10_000 }, (_, i) => (i % 3 === 0 ? i + 100_000 : i));
    const started = performance.now();
    const hunks = diffSequences(a, b);
    const elapsed = performance.now() - started;
    expect(expectRebuilds(a, b, hunks)).toBe(6_666);
    expect(hunks).toHaveLength(3_334);
    expect(elapsed).toBeLessThan(300);
  });

  test('10,000 repeated values past the cap, nothing unique to anchor on: one hunk, under 300 ms', () => {
    const next = random(3);
    const a = Array.from({ length: 10_000 }, () => Math.floor(next() * 5));
    const b = Array.from({ length: 10_000 }, () => Math.floor(next() * 5));
    const started = performance.now();
    const hunks = diffSequences(a, b);
    const elapsed = performance.now() - started;
    expectRebuilds(a, b, hunks);
    expect(hunks).toHaveLength(1);
    expect(elapsed).toBeLessThan(300);
  });
});
