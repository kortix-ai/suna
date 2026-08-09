import { describe, expect, test } from 'bun:test';
import type { SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion';

import { createSlashSuggestion } from './slash-controller';
import type { SlashRow } from './slash-items';

/**
 * Fix round 2, Open 1 — binds the CRITICAL fix (a menu with zero rows must
 * decline Enter, one WITH rows must consume it) to the real, exported
 * `createSlashSuggestion` — not just to `MenuNavState` in isolation
 * (`menu-nav-state.test.ts` already proves `hasRows` itself; this proves
 * `onKeyDown` is actually wired to it, end to end, through `onStart`).
 *
 * `onKeyDown` only ever reads `{ event }` (verified against the installed
 * `@tiptap/suggestion`'s `plugin/props.ts` — the plugin calls
 * `renderer.onKeyDown({ view, event, range })`, and `slash-controller.ts`
 * destructures only `event`), so a bare `{ event: { key } }` cast is enough
 * there — no DOM needed for that half.
 *
 * `onStart`, though, unconditionally constructs a real `ReactRenderer`,
 * which calls `document.createElement` (see `mention-controller.test.ts`'s
 * file header for the same note). `withStubDocument` below installs the
 * minimal 4-method fake `ReactRenderer`'s constructor actually touches —
 * `classList.add`, `style`, `setAttribute`, `remove` — for the SYNCHRONOUS
 * span of one `onStart` call, then restores whatever `document` was
 * beforehand. `bun test` runs every file in one shared process (no
 * `--isolate`, verified empirically — a global set in one file is visible in
 * the next), so this is scoped as tightly as possible rather than installed
 * once for the whole file. Nothing else in `onStart` needs a DOM: `mount` is
 * supplied by the test (never a real Floating UI mount), and `editor` is a
 * minimal fake with `isEditorContentInitialized: false`, which routes
 * `ReactRenderer`'s constructor through `queueMicrotask` instead of
 * `flushSync` — its deferred `render()` only builds a `react/jsx-runtime`
 * element descriptor and no-ops on `editor?.contentComponent` being
 * undefined, neither of which touches `document` at all.
 */
function withStubDocument<T>(fn: () => T): T {
  const previous = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = {
    createElement: () => ({
      classList: { add: () => {} },
      style: {},
      setAttribute: () => {},
      remove: () => {},
    }),
  };
  try {
    return fn();
  } finally {
    (globalThis as { document?: unknown }).document = previous;
  }
}

function fakeKeyDown(key: string): SuggestionKeyDownProps {
  return { event: { key } as KeyboardEvent } as unknown as SuggestionKeyDownProps;
}

function fakeStartProps(
  query: string,
  command: (row: SlashRow) => void,
): SuggestionProps<never, SlashRow> {
  return {
    query,
    command,
    editor: { isEditorContentInitialized: false },
    mount: () => () => {},
  } as unknown as SuggestionProps<never, SlashRow>;
}

describe('createSlashSuggestion — Enter declines with zero rows, consumes with a row', () => {
  test('a freshly built controller declines Enter — no transaction has ever reached it', () => {
    const { onKeyDown } = createSlashSuggestion({ getCommands: () => [] }).render!();

    expect(onKeyDown!(fakeKeyDown('Enter'))).toBe(false);
  });

  test('after a real open() with a query matching neither a command nor an action, Enter is declined', () => {
    const { onStart, onKeyDown } = createSlashSuggestion({ getCommands: () => [] }).render!();

    withStubDocument(() => {
      onStart!(fakeStartProps('zzzzznomatch-nothing-here', () => {}));
    });

    expect(onKeyDown!(fakeKeyDown('Enter'))).toBe(false);
  });

  test('ArrowDown/ArrowUp are also declined with zero rows (not just Enter)', () => {
    const { onKeyDown } = createSlashSuggestion({ getCommands: () => [] }).render!();

    expect(onKeyDown!(fakeKeyDown('ArrowDown'))).toBe(false);
    expect(onKeyDown!(fakeKeyDown('ArrowUp'))).toBe(false);
  });

  test("consumes Enter and runs the selected row's captured command when rows exist", () => {
    const selected: SlashRow[] = [];
    const { onStart, onKeyDown } = createSlashSuggestion({ getCommands: () => [] }).render!();

    // Empty query with no commands still yields the default SLASH_ACTIONS —
    // non-empty rows (see slash-items.test.ts's coverage of buildSlashSections).
    withStubDocument(() => {
      onStart!(fakeStartProps('', (row) => selected.push(row)));
    });

    const handled = onKeyDown!(fakeKeyDown('Enter'));

    expect(handled).toBe(true);
    expect(selected).toHaveLength(1);
  });

  test('Tab also consumes the selected row, same as Enter', () => {
    const selected: SlashRow[] = [];
    const { onStart, onKeyDown } = createSlashSuggestion({ getCommands: () => [] }).render!();

    withStubDocument(() => {
      onStart!(fakeStartProps('', (row) => selected.push(row)));
    });

    expect(onKeyDown!(fakeKeyDown('Tab'))).toBe(true);
    expect(selected).toHaveLength(1);
  });

  test('ArrowDown moves the selection before Enter consumes the NEW row, not the first one', () => {
    const selected: SlashRow[] = [];
    const { onStart, onKeyDown } = createSlashSuggestion({ getCommands: () => [] }).render!();

    withStubDocument(() => {
      onStart!(fakeStartProps('', (row) => selected.push(row)));
    });
    onKeyDown!(fakeKeyDown('ArrowDown'));
    onKeyDown!(fakeKeyDown('Enter'));

    expect(selected).toHaveLength(1);
    expect(selected[0].index).toBe(1); // moved off row 0 exactly once
  });

  test('going back to zero rows (query changes to a non-match) declines Enter again', () => {
    const selected: SlashRow[] = [];
    const { onStart, onUpdate, onKeyDown } = createSlashSuggestion({ getCommands: () => [] }).render!();

    withStubDocument(() => {
      onStart!(fakeStartProps('', (row) => selected.push(row)));
    });
    expect(onKeyDown!(fakeKeyDown('Enter'))).toBe(true); // rows existed
    selected.length = 0;

    onUpdate!(fakeStartProps('zzzzznomatch-nothing-here', (row) => selected.push(row)));

    expect(onKeyDown!(fakeKeyDown('Enter'))).toBe(false);
    expect(selected).toHaveLength(0);
  });
});
