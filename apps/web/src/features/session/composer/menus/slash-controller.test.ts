import { describe, expect, test } from 'bun:test';
import type { Command } from '@kortix/sdk/react';
import { Editor } from '@tiptap/core';
import type { SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion';

import { baseExtensions } from '../editor/extensions';
import { MentionNode } from '../editor/mention-node';
import { createSlashSuggestion } from './slash-controller';
import { SLASH_ACTIONS, type SlashAction } from './slash-actions';
import type { SlashFile } from './slash-files';
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

/**
 * `getActions` lets a host override the Actions section. `composer.tsx` no
 * longer uses it — it used to pass `[]` to suppress the whole palette while a
 * command was staged, and that suppression is exactly the bug the command-chip
 * model removed. The option itself stays: it is the only way to reach
 * `buildSlashSections`' `actions` parameter from a host, and these tests bind
 * it to the real `createSlashSuggestion` rather than to `buildSlashSections`
 * in isolation (`slash-items.test.ts:121` covers that half).
 */
describe('createSlashSuggestion — getActions threads through to buildSlashSections', () => {
  test('getActions: () => [] suppresses the Actions section entirely — Enter declines with zero rows', () => {
    // Passing `[]` must leave onStart with NOTHING to select — not just an
    // empty Commands section. Before this option existed, `getCommands: () =>
    // []` alone still left the (fixed, unreachable) SLASH_ACTIONS default
    // populated.
    const { onStart, onKeyDown } = createSlashSuggestion({
      getCommands: () => [],
      getActions: () => [],
    }).render!();

    withStubDocument(() => {
      onStart!(fakeStartProps('', () => {}));
    });

    expect(onKeyDown!(fakeKeyDown('Enter'))).toBe(false);
  });

  test('a custom getActions list is what gets selected — proves an override, not just an empty', () => {
    const customAction: SlashAction = {
      id: 'attach-file',
      label: 'Custom-only action',
      description: 'proves getActions overrides SLASH_ACTIONS, not just empties it',
    };
    const selected: SlashRow[] = [];
    const { onStart, onKeyDown } = createSlashSuggestion({
      getCommands: () => [],
      getActions: () => [customAction],
    }).render!();

    withStubDocument(() => {
      onStart!(fakeStartProps('', (row) => selected.push(row)));
    });
    onKeyDown!(fakeKeyDown('Enter'));

    expect(selected).toHaveLength(1);
    expect(selected[0].type).toBe('action');
    expect(selected[0].action).toBe(customAction);
  });

  test('omitting getActions entirely falls back to the SLASH_ACTIONS default — unchanged pre-fix behavior', () => {
    const selected: SlashRow[] = [];
    const { onStart, onKeyDown } = createSlashSuggestion({ getCommands: () => [] }).render!();

    withStubDocument(() => {
      onStart!(fakeStartProps('', (row) => selected.push(row)));
    });
    onKeyDown!(fakeKeyDown('Enter'));

    expect(selected).toHaveLength(1);
    expect(selected[0].type).toBe('action');
    expect(SLASH_ACTIONS).toContainEqual(selected[0].action);
  });
});

/**
 * The command-chip contract — the fix for "`/` works once and then never
 * again".
 *
 * These drive the REAL `command()` callback the Suggestion plugin invokes on a
 * selection, against a real headless `@tiptap/core` Editor (constructed with
 * no `element`, the same pattern `editor/composer-editor.test.ts` uses — its
 * `view` getter falls back to a stub that still dispatches transactions). No
 * DOM, no mocking of the node or the editor.
 */
function editorWithSlashQuery(typed: string): Editor {
  return new Editor({
    extensions: [...baseExtensions(() => ''), MentionNode],
    content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: typed }] }] },
  });
}

function chipsIn(editor: Editor): { kind: string; label: string }[] {
  const chips: { kind: string; label: string }[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'mention') {
      chips.push({ kind: String(node.attrs.kind), label: String(node.attrs.label) });
    }
  });
  return chips;
}

const deepResearch = { name: 'deep-research', description: 'Research deeply' } as never as Command;

describe('createSlashSuggestion — a picked command becomes an inline chip', () => {
  test('selecting a command row replaces the typed /query with a command chip', () => {
    // This is the behaviour change. The command used to leave the document
    // entirely and become host state, which is what forced the host to blank
    // the command list and broke every subsequent `/`.
    const editor = editorWithSlashQuery('/deep');
    const options = createSlashSuggestion({ getCommands: () => [deepResearch] });

    options.command!({
      editor,
      range: { from: 1, to: 6 }, // the "/deep" the user typed
      props: { index: 0, type: 'command', name: 'deep-research', description: '', command: deepResearch },
    } as never);

    expect(chipsIn(editor)).toEqual([{ kind: 'command', label: 'deep-research' }]);
    // The typed trigger text is gone — the chip stands in its place, not
    // alongside it.
    expect(editor.state.doc.textBetween(0, editor.state.doc.content.size)).not.toContain('/deep');
  });

  test('a SECOND command can be picked into the same document — the menu is never suppressed', () => {
    // The regression under test, stated directly: picking once must not put
    // the composer into a state where picking again is impossible.
    const editor = editorWithSlashQuery('/deep');
    const options = createSlashSuggestion({ getCommands: () => [deepResearch] });
    const pick = (from: number, to: number, name: string) =>
      options.command!({
        editor,
        range: { from, to },
        props: { index: 0, type: 'command', name, description: '', command: deepResearch },
      } as never);

    pick(1, 6, 'deep-research');
    const afterFirst = editor.state.doc.content.size;
    pick(afterFirst, afterFirst, 'compact');

    expect(chipsIn(editor).map((c) => c.label)).toEqual(['deep-research', 'compact']);
  });

  test('selecting an ACTION row inserts no chip — actions operate the composer, they are not message content', () => {
    const editor = editorWithSlashQuery('/switch');
    const picked: SlashAction[] = [];
    const options = createSlashSuggestion({
      getCommands: () => [],
      onSelectAction: (action) => picked.push(action),
    });

    options.command!({
      editor,
      range: { from: 1, to: 8 },
      props: { index: 0, type: 'action', name: 'Switch model', description: '', action: SLASH_ACTIONS[0] },
    } as never);

    expect(chipsIn(editor)).toEqual([]);
    expect(picked).toEqual([SLASH_ACTIONS[0]]);
  });

  test('onSelectCommand still fires, as a notification alongside the insert', () => {
    const editor = editorWithSlashQuery('/deep');
    const notified: Command[] = [];
    const options = createSlashSuggestion({
      getCommands: () => [deepResearch],
      onSelectCommand: (command) => notified.push(command),
    });

    options.command!({
      editor,
      range: { from: 1, to: 6 },
      props: { index: 0, type: 'command', name: 'deep-research', description: '', command: deepResearch },
    } as never);

    expect(notified).toEqual([deepResearch]);
    expect(chipsIn(editor)).toHaveLength(1);
  });

  test('a nameless command inserts NO chip — it could never be resolved back at submit', () => {
    const editor = editorWithSlashQuery('/x');
    const options = createSlashSuggestion({ getCommands: () => [] });

    options.command!({
      editor,
      range: { from: 1, to: 3 },
      props: { index: 0, type: 'command', name: '', description: '', command: {} as never },
    } as never);

    expect(chipsIn(editor)).toEqual([]);
  });
});

describe('createSlashSuggestion — dockSelector reaches the plugin', () => {
  test('dockSelector becomes the Suggestion plugin container, so the menu renders in flow', () => {
    // `container` is what redirects @tiptap/suggestion's appendChild away from
    // document.body. Without this threading the menu still opens — it just
    // floats over the composer instead of docking above it, which is the
    // failure that looks like nothing is wrong.
    const options = createSlashSuggestion({ getCommands: () => [], dockSelector: '#dock-42' });

    expect(options.container).toBe('#dock-42');
  });

  test('omitting dockSelector leaves container undefined — the plugin default (document.body)', () => {
    expect(createSlashSuggestion({ getCommands: () => [] }).container).toBeUndefined();
  });
});

describe('createSlashSuggestion — the inline "/Type to search" hint', () => {
  test('the trigger decoration carries a class and the hint content', () => {
    // The plugin adds `is-empty` and copies `decorationContent` onto the
    // decoration span itself; `globals.css`'s
    // `.kortix-slash-trigger.is-empty::after` is what paints it. Both halves
    // have to agree on the class name, and nothing else in the codebase
    // would catch a rename of one without the other.
    const options = createSlashSuggestion({ getCommands: () => [] });

    expect(options.decorationClass).toBe('kortix-slash-trigger');
    expect(options.decorationContent).toBe('Type to search');
  });
});

/**
 * The session's own files, reachable from `/`.
 *
 * The point of the feature, stated as behavior: a file the Outputs card shows
 * can be picked from the `/` palette and lands in the document as the SAME
 * mention the `@` menu inserts — so the send path (`editor/serialize.ts` ->
 * `lib/project-preamble.ts`'s `<file_ref>` block) needs nothing new, and the
 * user keeps typing with the file attached.
 */
const reportFile: SlashFile = {
  path: 'docs/report.md',
  name: 'Q3 revenue report',
  folder: 'docs',
  origin: 'output',
};

describe("createSlashSuggestion — a picked file becomes a file mention", () => {
  test('selecting a file row replaces the typed /query with a file mention', () => {
    const editor = editorWithSlashQuery('/report');
    const options = createSlashSuggestion({ getCommands: () => [], getFiles: () => [reportFile] });

    options.command!({
      editor,
      range: { from: 1, to: 8 }, // the "/report" the user typed
      props: {
        index: 0,
        type: 'file',
        name: reportFile.name,
        description: reportFile.path,
        file: reportFile,
      },
    } as never);

    expect(chipsIn(editor)).toEqual([{ kind: 'file', label: 'docs/report.md' }]);
    expect(editor.state.doc.textBetween(0, editor.state.doc.content.size)).not.toContain('/report');
  });

  test('the mention label is the PATH, never the row\'s display name', () => {
    // `serialize.ts`'s `collectMentions` addresses files by LABEL — `value` is
    // dropped for every kind but `session`. A display name here would hand the
    // agent a `<file_ref>` for "Q3 revenue report", which resolves to nothing.
    const editor = editorWithSlashQuery('/q3');
    const options = createSlashSuggestion({ getCommands: () => [], getFiles: () => [reportFile] });

    options.command!({
      editor,
      range: { from: 1, to: 4 },
      props: { index: 0, type: 'file', name: reportFile.name, description: '', file: reportFile },
    } as never);

    expect(chipsIn(editor)[0].label).toBe(reportFile.path);
  });

  test('a file row with no file attached inserts nothing rather than an empty mention', () => {
    const editor = editorWithSlashQuery('/x');
    const options = createSlashSuggestion({ getCommands: () => [] });

    options.command!({
      editor,
      range: { from: 1, to: 3 },
      props: { index: 0, type: 'file', name: 'ghost', description: '' },
    } as never);

    expect(chipsIn(editor)).toEqual([]);
  });

  test('getFiles is read LIVE, so a file produced mid-session is offered by the next /', () => {
    // The reason `composer-editor.tsx` holds this in a ref: extensions are
    // frozen at construction, so a list captured there would offer the
    // session's files as they were when the tab opened, forever.
    let files: SlashFile[] = [];
    const selected: SlashRow[] = [];
    const { onStart, onKeyDown } = createSlashSuggestion({
      getCommands: () => [],
      getActions: () => [],
      getFiles: () => files,
    }).render!();

    withStubDocument(() => {
      onStart!(fakeStartProps('', (row) => selected.push(row)));
    });
    expect(onKeyDown!(fakeKeyDown('Enter'))).toBe(false); // no rows at all yet

    files = [reportFile];
    withStubDocument(() => {
      onStart!(fakeStartProps('', (row) => selected.push(row)));
    });
    onKeyDown!(fakeKeyDown('Enter'));

    expect(selected).toHaveLength(1);
    expect(selected[0].type).toBe('file');
    expect(selected[0].file).toBe(reportFile);
  });

  test('omitting getFiles leaves the palette exactly as it was — no file sections', () => {
    const selected: SlashRow[] = [];
    const { onStart, onKeyDown } = createSlashSuggestion({
      getCommands: () => [],
      getActions: () => [],
    }).render!();

    withStubDocument(() => {
      onStart!(fakeStartProps('', (row) => selected.push(row)));
    });

    expect(onKeyDown!(fakeKeyDown('Enter'))).toBe(false);
    expect(selected).toEqual([]);
  });
});
