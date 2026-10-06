/**
 * The changes-view layout toggle, end to end, through a real click.
 *
 * The regression this pins (KRTX-1691): a workspace report said the
 * side-by-side toggle in the changes view "does nothing" on prod. The wiring —
 * `DiffLayoutToggle` → controlled `layout` state → `ChangeList` → `DiffView` →
 * Pierre's `diffStyle` — reads correct, so the defense is a test that executes
 * the whole chain the way a user does: it clicks the real button and asserts
 * the real diff re-renders in the other layout, and back.
 *
 * `apps/web` has no jsdom/testing-library (the doctrine in the sibling tests),
 * but it does run `createRoot` against `happy-dom` — see `navbar.test.tsx` and
 * `confetti.test.tsx`. This file extends that pattern to clicks: a real
 * `MouseEvent` on the real `<button>` reaches React's handler, the controlled
 * state flips, and Pierre's async shiki highlighter paints the new column set
 * in the `diffs-container` shadow root (`data-unified` vs
 * `data-deletions`+`data-additions`).
 */
import { describe, expect, test } from 'bun:test';
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const win = new Window({ width: 1440, height: 900 });
const globals = globalThis as Record<string, unknown>;
globals.window = win;
globals.document = win.document;
globals.navigator = win.navigator;
globals.location = win.location;
globals.history = win.history;
globals.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
globals.cancelAnimationFrame = (id: number) => clearTimeout(id);
// @pierre/diffs touches DOM classes by bare global name (SVGElement, …) and
// happy-dom keeps them on its Window, not on globalThis.
for (const key of Object.getOwnPropertyNames(win)) {
  if (/^[A-Z]/.test(key) && !(key in globals)) globals[key] = (win as Record<string, unknown>)[key];
}

import { ChangeList, DiffLayoutToggle, useChangeExpansion } from './change-list';
import type { ChangeEntry, DiffLayout } from './change-vocabulary';

const PATCH = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,2 +1,3 @@',
  ' const a = 1;',
  '+const b = 2;',
  ' const c = 3;',
].join('\n');

const ENTRIES: ChangeEntry[] = [
  { path: 'src/app.ts', kind: 'modified', additions: 1, deletions: 0, patch: PATCH },
];

/** One controlled mount, exactly like the session panel and the proposal dialog. */
function Harness() {
  const [layout, setLayout] = useState<DiffLayout>('unified');
  const { expanded, setRow } = useChangeExpansion(ENTRIES);
  return (
    <div>
      <DiffLayoutToggle layout={layout} onChange={setLayout} />
      <ChangeList entries={ENTRIES} layout={layout} expanded={expanded} onRowOpenChange={setRow} />
    </div>
  );
}

const click = (el: Element) =>
  el.dispatchEvent(
    new win.MouseEvent('click', { bubbles: true, cancelable: true }) as unknown as Event,
  );

/** Column markers in each `diffs-container` shadow root, in document order. */
function columns(host: HTMLElement): string[] {
  return [...host.querySelectorAll('diffs-container')].map((c) =>
    [
      ...(((c as unknown as { shadowRoot?: ShadowRoot }).shadowRoot?.querySelectorAll(
        'pre > code',
      ) ?? []) as Element[]),
    ]
      .map((code) =>
        code
          .getAttributeNames()
          .filter((name) => name.startsWith('data-') && name !== 'data-code' && name !== 'data-container-size')
          .join('+'),
      )
      .join('|'),
  );
}

/** The toggle button for a layout, by the label a reader (and a screen) gets. */
function toggleButton(host: HTMLElement, label: string): HTMLButtonElement {
  const button = [...host.querySelectorAll('button')].find(
    (b) => b.getAttribute('aria-label') === label,
  );
  if (!button) throw new Error(`no toggle button labelled "${label}"`);
  return button as HTMLButtonElement;
}

async function waitFor(host: HTMLElement, predicate: () => boolean, what: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
  }
  throw new Error(`the ${what} never appeared; columns: ${JSON.stringify(columns(host))}`);
}

describe('DiffLayoutToggle through a real click', () => {
  test(
    'stacked → side by side → stacked re-renders the diff each way',
    async () => {
    const host = win.document.createElement('div');
    win.document.body.appendChild(host);
    let root: Root | null = null;
    await act(async () => {
      root = createRoot(host);
      root.render(<Harness />);
    });

    // Both controls exist, labelled for the tooltip and for assistive tech.
    const stacked = toggleButton(host, 'Stacked');
    const sideBySide = toggleButton(host, 'Side by side');
    expect(stacked.getAttribute('aria-pressed')).toBe('true');
    expect(sideBySide.getAttribute('aria-pressed')).toBe('false');

    // Pierre highlights asynchronously; the first unified paint lands when the
    // shiki highlighter is ready. Wait for it rather than guessing a delay.
    await waitFor(host, () => columns(host)[0] === 'data-unified', 'initial unified column');
    expect(columns(host).join()).not.toContain('data-deletions');

    // Clicking the already-active control is a no-op, not a layout flip.
    await act(async () => {
      click(stacked);
      await new Promise((r) => setTimeout(r, 100));
    });
    expect(stacked.getAttribute('aria-pressed')).toBe('true');
    expect(columns(host).join()).not.toContain('data-deletions');

    // The reported regression: side by side must actually switch the rendering.
    await act(async () => {
      click(sideBySide);
      await new Promise((r) => setTimeout(r, 100));
    });
    expect(sideBySide.getAttribute('aria-pressed')).toBe('true');
    expect(stacked.getAttribute('aria-pressed')).toBe('false');
    await waitFor(
      host,
      () => columns(host)[0] === 'data-deletions|data-additions',
      'split columns',
    );

    // And back.
    await act(async () => {
      click(stacked);
      await new Promise((r) => setTimeout(r, 100));
    });
    expect(stacked.getAttribute('aria-pressed')).toBe('true');
    await waitFor(host, () => columns(host)[0] === 'data-unified', 'unified column again');

    root?.unmount();
    },
    30_000,
  );
});
