import { describe, expect, test } from 'bun:test';
import type { SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion';

import { createMentionSuggestion } from './mention-controller';
import type { MenuRow } from './menu-items';

/**
 * Fix round 2, Open 1 — binds the CRITICAL fix to the real, exported
 * `createMentionSuggestion`, the same way `slash-controller.test.ts` does for
 * `/`. See that file's header for the full rationale on `withStubDocument`
 * and why it's scoped to one synchronous `onStart` call rather than
 * installed for the whole file.
 *
 * The `@` menu has one extra wrinkle `/` doesn't: its rows arrive
 * ASYNCHRONOUSLY, from `MentionMenuHost`'s `useFileSearch` + `useEffect`
 * (`mention-menu.tsx`) — which never actually runs here, because nothing in
 * this file attaches a real React reconciler (no `document`-backed
 * `react-dom` root, no jsdom). `ReactRenderer.render()` only ever builds a
 * `react/jsx-runtime` element DESCRIPTOR (`jsx(Component, props)`); nothing
 * in this test environment ever calls `MentionMenuHost` as a function to
 * execute its hooks. Proving "consumes when a row exists" therefore can't go
 * through the hook pipeline — instead, this drives the SAME real code path
 * the pipeline would eventually call: `mention-controller.ts`'s `onStart`
 * hands its `handleRowsChange` closure to `ReactRenderer` as the
 * `onRowsChange` prop, and `ReactRenderer.render()` publishes the live
 * instance via `editor.contentComponent.setRenderer(id, this)` — a real,
 * documented `@tiptap/react` extension point (`ContentComponent`, what
 * `EditorContent` itself implements). Supplying a MINIMAL fake
 * `contentComponent` here captures that exact instance, and
 * `captured.props.onRowsChange` IS `handleRowsChange` — calling it exercises
 * `nav.setRows` and `renderer.updateProps` for real, with no internals
 * mocked. `isEditorContentInitialized: true` routes `ReactRenderer`'s
 * constructor through `flushSync` instead of `queueMicrotask`, so the
 * capture happens synchronously within the `onStart` call the test makes.
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

interface CapturedRenderer {
  props: { onRowsChange: (rows: MenuRow[]) => void };
}

/**
 * Calls the real `onStart`, capturing the real `ReactRenderer` instance it
 * constructs via a fake `contentComponent.setRenderer` — see the file header.
 */
function startAndCapture(
  onStart: (props: SuggestionProps<never, MenuRow>) => void,
  query: string,
  command: (row: MenuRow) => void,
): CapturedRenderer {
  let captured: CapturedRenderer | null = null;
  withStubDocument(() => {
    onStart({
      query,
      command,
      editor: {
        isEditorContentInitialized: true,
        contentComponent: {
          setRenderer: (_id: string, renderer: unknown) => {
            captured = renderer as CapturedRenderer;
          },
          removeRenderer: () => {},
        },
      },
      mount: () => () => {},
    } as unknown as SuggestionProps<never, MenuRow>);
  });
  if (!captured) throw new Error('onStart did not construct a ReactRenderer');
  return captured;
}

const sampleRow: MenuRow = { index: 0, kind: 'file', label: 'a.ts', value: 'a.ts' };

describe('createMentionSuggestion — Enter declines with zero rows, consumes with a row', () => {
  test('a freshly built controller declines Enter — no transaction has ever reached it', () => {
    const { onKeyDown } = createMentionSuggestion({
      getAgents: () => [],
      getSessions: () => [],
      getCurrentSessionId: () => undefined,
    }).render!();

    expect(onKeyDown!(fakeKeyDown('Enter'))).toBe(false);
  });

  // The realistic case, not just the trivial one: the menu just opened, and
  // `MentionMenuHost`'s async `useFileSearch` pipeline has not reported any
  // rows back yet (the "one-React-tick window" — a known, deferred-to-T14
  // structural gap, NOT what this test is pinning). What this DOES pin: in
  // that window, Enter must decline — not accept a phantom row, not throw.
  test('declines Enter immediately after opening, before any rows have been reported', () => {
    const { onStart, onKeyDown } = createMentionSuggestion({
      getAgents: () => [],
      getSessions: () => [],
      getCurrentSessionId: () => undefined,
    }).render!();

    startAndCapture(onStart!, 'nonexistentfile', () => {});

    expect(onKeyDown!(fakeKeyDown('Enter'))).toBe(false);
  });

  test('ArrowDown/ArrowUp are also declined with zero rows (not just Enter)', () => {
    const { onKeyDown } = createMentionSuggestion({
      getAgents: () => [],
      getSessions: () => [],
      getCurrentSessionId: () => undefined,
    }).render!();

    expect(onKeyDown!(fakeKeyDown('ArrowDown'))).toBe(false);
    expect(onKeyDown!(fakeKeyDown('ArrowUp'))).toBe(false);
  });

  test('still declines Enter when the host reports an empty row list explicitly', () => {
    const { onStart, onKeyDown } = createMentionSuggestion({
      getAgents: () => [],
      getSessions: () => [],
      getCurrentSessionId: () => undefined,
    }).render!();

    const captured = startAndCapture(onStart!, 'nonexistentfile', () => {});
    captured.props.onRowsChange([]); // e.g. the file search resolved to nothing

    expect(onKeyDown!(fakeKeyDown('Enter'))).toBe(false);
  });

  test("consumes Enter and runs the selected row's captured command once rows arrive", () => {
    const selected: MenuRow[] = [];
    const { onStart, onKeyDown } = createMentionSuggestion({
      getAgents: () => [],
      getSessions: () => [],
      getCurrentSessionId: () => undefined,
    }).render!();

    const captured = startAndCapture(onStart!, 'a', (row) => selected.push(row));
    captured.props.onRowsChange([sampleRow]);

    const handled = onKeyDown!(fakeKeyDown('Enter'));

    expect(handled).toBe(true);
    expect(selected).toEqual([sampleRow]);
  });

  test('Tab also consumes the selected row, same as Enter', () => {
    const selected: MenuRow[] = [];
    const { onStart, onKeyDown } = createMentionSuggestion({
      getAgents: () => [],
      getSessions: () => [],
      getCurrentSessionId: () => undefined,
    }).render!();

    const captured = startAndCapture(onStart!, 'a', (row) => selected.push(row));
    captured.props.onRowsChange([sampleRow]);

    expect(onKeyDown!(fakeKeyDown('Tab'))).toBe(true);
    expect(selected).toEqual([sampleRow]);
  });

  test('rows going from some back to none (a debounced search resolving to nothing) declines Enter again', () => {
    const selected: MenuRow[] = [];
    const { onStart, onKeyDown } = createMentionSuggestion({
      getAgents: () => [],
      getSessions: () => [],
      getCurrentSessionId: () => undefined,
    }).render!();

    const captured = startAndCapture(onStart!, 'a', (row) => selected.push(row));
    captured.props.onRowsChange([sampleRow]);
    expect(onKeyDown!(fakeKeyDown('Enter'))).toBe(true); // rows existed
    selected.length = 0;

    captured.props.onRowsChange([]);

    expect(onKeyDown!(fakeKeyDown('Enter'))).toBe(false);
    expect(selected).toHaveLength(0);
  });
});
