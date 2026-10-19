import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

import { SESSION_TRANSCRIPT_CLASS, SessionBodyRow } from './session-body';

/**
 * The instant boot shell and `SessionChat` paint the same body and crossfade
 * into each other over 300ms, so for that fade both are on screen at once. Any
 * geometry they do not share is a double image sliding sideways, not a style
 * nit — which is exactly what shipped: the chat rendered a 40px in-flow action
 * panel column the shell did not, and their transcript gutters had drifted to
 * `px-7 pt-6 md:pr-4` against `px-3 py-6 sm:px-6`.
 *
 * These tests pin the two halves of the fix: the row's own shape (rendered),
 * and the fact that both callers still get their geometry from here rather than
 * from a fresh literal (source).
 */

const read = (rel: string) => {
  const source = readFileSync(resolve(import.meta.dir, rel), 'utf8');
  // Guard against the silent-pass failure mode: a moved or renamed file makes
  // every `not.toContain` below trivially true.
  if (source.length < 1000) throw new Error(`${rel} did not load`);
  return source;
};

const chatSource = read('session-chat.tsx');
const shellSource = read('instant-session-shell.tsx');

describe('SessionBodyRow', () => {
  test('the chat column can shrink and the row clips, so a docked composer stays in view', () => {
    const markup = renderToStaticMarkup(
      <SessionBodyRow actionPanel={false}>
        <span>thread</span>
      </SessionBodyRow>,
    );
    expect(markup).toContain('class="flex min-h-0 flex-1 overflow-hidden"');
    expect(markup).toContain('class="relative flex min-w-0 flex-1 flex-col"');
    expect(markup).toContain('<span>thread</span>');
  });

  test('the transient boot shell yields the hotkey instead of doubling it', () => {
    // Both rows are mounted for the 300ms crossfade. Two ⌘I listeners call
    // `toggleRight()` twice in one tick and the key reads as dead.
    const source = read('session-body.tsx');
    expect(source).toContain('hotkey={!transient}');
    expect(read('instant-session-shell.tsx')).toContain('transient');
    expect(read('session-action-panel-column.tsx')).toContain(
      'const shouldHandleHotkey = hotkey &&',
    );
  });

  test('the action panel column is a render gate, not state', () => {
    // `actionPanel={false}` is the surface that has no panel to offer (read-only
    // sub-session modal, the shell's pre-submit welcome hero). It must produce
    // the row and nothing beside it.
    const withoutPanel = renderToStaticMarkup(
      <SessionBodyRow actionPanel={false}>
        <span>thread</span>
      </SessionBodyRow>,
    );
    expect(withoutPanel).not.toContain('data-testid="session-action-panel"');
  });
});

describe('the transcript column has ONE definition', () => {
  test('it keeps the gutters the composer is measured against', () => {
    // `COMPOSER_SHELL_CLASS` is `px-4`; the conversation sits 12px further in
    // on both sides so a right-aligned bubble never reaches the input card's
    // edge. Equal gutters on both sides keep it on the row's exact center.
    expect(SESSION_TRANSCRIPT_CLASS).toBe('mx-auto w-full max-w-3xl min-w-0 px-7 pt-6');
  });

  test('neither surface hand-writes a transcript column', () => {
    for (const [name, source] of [
      ['session-chat.tsx', chatSource],
      ['instant-session-shell.tsx', shellSource],
    ] as const) {
      expect(`${name}:${/className="[^"]*max-w-3xl/.test(source)}`).toBe(`${name}:false`);
      expect(source).toContain('SESSION_TRANSCRIPT_CLASS');
    }
  });

  test('both surfaces render the shared row, and neither reaches past it', () => {
    for (const source of [chatSource, shellSource]) {
      expect(source).toContain('<SessionBodyRow');
      // The column belongs to the row. Rendering it directly is how the two
      // surfaces disagreed about their width in the first place.
      expect(source).not.toContain('<SessionActionPanelColumn');
    }
  });
});


describe('the first prompt is drawn by one component on both sides of the fade', () => {
  test('SessionChat stands in for the missing bubble with OptimisticTurn', () => {
    // Not `QueuedPromptBubbles`: that row reserves a `w-6` action column to the
    // right of the bubble and carries no waiting row, so the bubble landed 28px
    // left of the shell's and the "Thinking" line blinked out mid-crossfade.
    expect(chatSource).toContain('{showFirstPromptPreview &&');
    expect(chatSource).toMatch(/showFirstPromptPreview &&[\s\S]{0,200}<OptimisticTurn/);
    expect(chatSource).not.toMatch(/showFirstPromptPreview &&[\s\S]{0,200}<QueuedPromptBubbles/);
  });

  test('the shell draws the same component', () => {
    expect(shellSource).toContain('<OptimisticTurn');
  });
});


describe('the composer behind the overlay does not steal focus from the shell', () => {
  test('SessionChat defers composer autofocus while the shell is on top', () => {
    // `useComposerFocus` reads visibility from `offsetParent`, which does not
    // notice an opaque layer on top, so the host passes `deferComposerFocus`.
    expect(chatSource).toContain('autoFocus={deferComposerFocus ? false : undefined}');
  });
});
