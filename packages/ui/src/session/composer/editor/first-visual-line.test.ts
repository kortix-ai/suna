import { describe, expect, test } from 'bun:test';
import type { EditorView } from '@tiptap/pm/view';
import { isCursorOnFirstVisualLine } from './first-visual-line';

function view(opts: { empty?: boolean; block?: number; atTop?: boolean }) {
  return {
    state: {
      selection: { empty: opts.empty ?? true, $head: { index: () => opts.block ?? 0 } },
    },
    endOfTextblock: (dir: string) => dir === 'up' && (opts.atTop ?? true),
  } as unknown as Pick<EditorView, 'state' | 'endOfTextblock'>;
}

describe('isCursorOnFirstVisualLine', () => {
  test('a caret on the first row of the first block', () => {
    expect(isCursorOnFirstVisualLine(view({}))).toBe(true);
  });

  test('a wrapped first block with the caret on a lower row', () => {
    expect(isCursorOnFirstVisualLine(view({ atTop: false }))).toBe(false);
  });

  test('a caret in a later paragraph', () => {
    expect(isCursorOnFirstVisualLine(view({ block: 1 }))).toBe(false);
  });

  test('a range selection', () => {
    expect(isCursorOnFirstVisualLine(view({ empty: false }))).toBe(false);
  });
});
