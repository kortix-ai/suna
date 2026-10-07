/**
 * The changes-view layout toggle, end to end, through a real click.
 *
 * The regression this pins (KRTX-1691): a workspace report said the
 * side-by-side toggle in the changes view "does nothing". The wiring —
 * `DiffLayoutToggle` → controlled `layout` state → `ChangeList` → `DiffView` →
 * Pierre's `diffStyle` — was correct, which is why the first pin here used a
 * two-sided patch and saw the toggle work. The defect was in the DATA shape:
 * Pierre renders a one-sided diff (a new file: only `+` lines; a deleted one:
 * only `−` lines) as the same single column in BOTH layouts, so a change set
 * of new files made the toggle look dead. `DiffView` now normalizes those
 * patches (`splitablePatch`), and the second test below clicks the toggle
 * against exactly that one-sided fixture — it fails without the fix.
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
import { createRoot } from 'react-dom/client';
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
  if (/^[A-Z]/.test(key) && !(key in globals))
    globals[key] = (win as unknown as Record<string, unknown>)[key];
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

/** A new file: the patch is one-sided, the shape the report hit. */
const NEW_FILE_PATCH = [
  'diff --git a/src/new-file.ts b/src/new-file.ts',
  'new file mode 100644',
  'index 0000000..2222222',
  '--- /dev/null',
  '+++ b/src/new-file.ts',
  '@@ -0,0 +1,3 @@',
  '+const a = 1;',
  '+const b = 2;',
  '+const c = 3;',
].join('\n');

const ENTRIES: ChangeEntry[] = [
  { path: 'src/app.ts', kind: 'modified', additions: 1, deletions: 0, patch: PATCH },
];

const NEW_FILE_ENTRIES: ChangeEntry[] = [
  { path: 'src/new-file.ts', kind: 'added', additions: 3, deletions: 0, patch: NEW_FILE_PATCH },
];

/** One controlled mount, exactly like the session panel and the proposal dialog. */
function Harness({ entries = ENTRIES }: { entries?: ChangeEntry[] }) {
  const [layout, setLayout] = useState<DiffLayout>('unified');
  const { expanded, setRow } = useChangeExpansion(entries);
  return (
    <div>
      <DiffLayoutToggle layout={layout} onChange={setLayout} />
      <ChangeList entries={entries} layout={layout} expanded={expanded} onRowOpenChange={setRow} />
    </div>
  );
}

/**
 * The mount, exactly like the session panel and the proposal dialog create
 * theirs: the happy-dom node crosses into the lib.dom world once, at the
 * cast, and every helper downstream takes the lib.dom handle (navbar.test.tsx's
 * `lib.element` rule). The root is created outside `act`, so `root.unmount()`
 * typechecks as a real `Root`, never the `null` initializer a callback
 * assignment would narrow to.
 */
function mountHarness() {
  const raw = win.document.createElement('div');
  win.document.body.appendChild(raw);
  const host = raw as unknown as HTMLElement;
  return { host, root: createRoot(host) };
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
      const { host, root } = mountHarness();
      await act(async () => {
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

    root.unmount();
    },
    30_000,
  );

  test(
    'a new file (a one-sided patch) also switches to side by side, and back',
    async () => {
      const { host, root } = mountHarness();
      await act(async () => {
        root.render(<Harness entries={NEW_FILE_ENTRIES} />);
      });

      const sideBySide = toggleButton(host, 'Side by side');
      // Pierre paints the new file asynchronously; the stacked layout always
      // renders one unified column, whatever the patch's shape.
      await waitFor(host, () => columns(host)[0] === 'data-unified', 'the initial new-file column');

      // The reported regression: Pierre used to keep the same single column
      // here, so the click visibly did nothing. Split must show both columns —
      // the deletions side stays empty, which is the GitHub layout.
      await act(async () => {
        click(sideBySide);
        await new Promise((r) => setTimeout(r, 100));
      });
      expect(sideBySide.getAttribute('aria-pressed')).toBe('true');
      await waitFor(
        host,
        () => columns(host)[0] === 'data-deletions|data-additions',
        'the new-file split columns',
      );

      // And back to the single stacked column.
      const stacked = toggleButton(host, 'Stacked');
      await act(async () => {
        click(stacked);
        await new Promise((r) => setTimeout(r, 100));
      });
      expect(stacked.getAttribute('aria-pressed')).toBe('true');
      await waitFor(
        host,
        () => columns(host)[0] === 'data-unified',
        'the new-file unified column again',
      );

      root.unmount();
    },
    30_000,
  );
});
