# Enhance Chat Input — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 1,383-line `session-chat-input.tsx` with a composer whose editor owns its own text, so typing re-renders nothing outside it, and whose `@` mentions are atomic inline badges rather than substring matches against a string.

**Architecture:** An uncontrolled TipTap (ProseMirror) editor sits inside a layout shell that holds no text state. The toolbar receives only stable props and re-renders on agent/model change alone. All pure logic — serialization, menu assembly, selection maths, the action registry — lives in `.ts` modules with `bun:test` coverage; the `.tsx` files stay thin enough not to need DOM tests, matching the existing `queued-messages-logic.ts` / `queued-messages.tsx` split.

**Tech Stack:** TipTap 3.27 on ProseMirror (both MIT, already installed), `@tiptap/suggestion` + `@tiptap/extension-mention` (MIT, to add), TanStack Query 5 (installed), Floating UI (installed via `@tiptap/react`), Tailwind + Kortix tokens, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-08-09-enhance-chat-input-design.md`

---

## Global Constraints

Every task's requirements implicitly include this section.

- **Editor stack is TipTap on ProseMirror.** They are one stack: `@tiptap/pm` is a re-export of 13 `prosemirror-*` packages. Never substitute CodeMirror or Lexical.
- **MIT only.** No Tiptap Cloud, no Pro extensions, no registry token, no runtime call to any Tiptap service. Verified package set: 40 `@tiptap/*` + 13 `prosemirror-*` + the 2 additions, all MIT.
- **Do NOT use `@tiptap/starter-kit`.** It pulls tables, math and images. The extension list is explicit and declared in Task 3.
- **`onSend(text, files, mentions)` keeps its exact current signature.** No consumer outside `features/session/composer/` changes its call shape.
- **Never edit these tests to make something pass:** `composer-reset.test.ts`, `composer-draft-recovery.test.ts`, `message-queue-boundary.test.ts`, `queued-messages-logic.test.ts`, `model-availability.test.ts`, `model-flatten.test.ts`. If one goes red, a contract moved — stop and report it.
- **No `…` overflow popover and no "advanced mode" toggle.** Both were built and reverted; `composer-toolbar.tsx:19-36` records why.
- **Verification is code + `bun test` + `eslint` + `tsc`.** Do not drive a browser or boot the stack.
- **Test commands** (run from `apps/web`): `bun test src/features/session/composer`, `npx tsc --noEmit`, `npx eslint <changed files>`.
- **Commit after every task.** Never commit unless the task's step says to. Do not push, do not open a PR, do not merge to `main` without asking.
- **Query keys stay local to `apps/web`.** Do not add keys to `packages/sdk/src/react/query-keys.ts` — that package has mandatory TDD, a public-export snapshot gate, and npm publishing.

---

## File Structure

```
apps/web/src/features/session/composer/
├── composer.tsx                        NEW   shell; owns attachments/staged/drag, NOT text
├── editor/
│   ├── composer-editor.tsx             NEW   TipTap React wrapper + imperative handle
│   ├── extensions.ts                   NEW   the explicit extension list
│   ├── mention-node.ts                 NEW   atom node definition
│   ├── serialize.ts                    NEW   PURE: doc → { text, mentions }
│   └── serialize.test.ts               NEW
├── menus/
│   ├── mention-menu.tsx                NEW   renders sections, no data logic
│   ├── slash-menu.tsx                  NEW
│   ├── menu-items.ts                   NEW   PURE: data → sections
│   ├── menu-items.test.ts              NEW
│   ├── slash-actions.ts                NEW   PURE: local action registry
│   ├── slash-actions.test.ts           NEW
│   ├── menu-selection.ts               NEW   PURE: index move/clamp
│   └── menu-selection.test.ts          NEW
├── hooks/
│   ├── use-composer-focus.ts           NEW   autofocus + focus event + type-anywhere
│   ├── use-debounced-value.ts          NEW
│   ├── use-debounced-value.test.ts     NEW
│   └── use-file-search.ts              NEW   TanStack Query
├── attachment-tiles.tsx                NEW   replaces attachment-preview.tsx
├── composer-toolbar.tsx                MOD   loses variant + effort
├── types.ts                            MOD   add MentionKind
├── attachment-preview.tsx              DELETE (superseded by attachment-tiles.tsx)
├── mention-popover.tsx                 DELETE (superseded by menus/mention-menu.tsx)
└── slash-command-popover.tsx           DELETE (superseded by menus/slash-menu.tsx)

apps/web/src/features/session/
├── session-chat-input.tsx              MOD   1,383 lines → ~8-line re-export barrel
├── model-selector.tsx                  MOD   absorbs variant + reasoning effort
└── session-chat.tsx                    MOD   one import line at :57, render at :3937
```

`composer-chat-input.tsx` is **not** modified — it keeps its exact public props, so `instant-session-shell.tsx` and `project-home.tsx` need no edit at all.

---

## Milestone 1 — Foundation

### Task 1: Extract composer focus behaviour into one hook

Three of the eight effects in `session-chat-input.tsx` are focus management, and each currently registers its own `window` listener **per mounted composer**. With N session tabs open there are N type-anywhere listeners, all doing `offsetParent` checks on every printable keypress.

**Files:**
- Create: `apps/web/src/features/session/composer/hooks/use-composer-focus.ts`
- Reference (do not edit yet): `apps/web/src/features/session/session-chat-input.tsx:398-430`, `:451-467`, `:475-499`

**Interfaces:**
- Consumes: nothing.
- Produces: `useComposerFocus({ ref, autoFocus, disabled }): void` where `ref` is `RefObject<HTMLElement | null>`.

- [ ] **Step 1: Write the hook**

```ts
'use client';

import { type RefObject, useEffect } from 'react';

/** True for elements that already handle their own typing. */
function isTextEditingElement(el: Element | null): boolean {
  if (!el) return false;
  const html = el as HTMLElement;
  if (html.isContentEditable) return true;
  const tag = html.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/** Only the composer inside the visible tab should answer a global event. */
function isVisible(el: HTMLElement | null): el is HTMLElement {
  return !!el && el.offsetParent !== null;
}

export interface UseComposerFocusOptions {
  /** The focusable editor root. */
  ref: RefObject<HTMLElement | null>;
  /** Default: true on viewports >= 640px. */
  autoFocus?: boolean;
  disabled?: boolean;
}

/**
 * The composer's three focus behaviours, in one place:
 *  1. focus on mount, including when revealed later inside a hidden tab
 *  2. focus on the `focus-session-textarea` window event
 *  3. typing anywhere on the page redirects into the composer
 *
 * Replaces session-chat-input.tsx:398-430, :451-467 and :475-499, which each
 * registered their own listener per mounted composer.
 */
export function useComposerFocus({ ref, autoFocus, disabled = false }: UseComposerFocusOptions) {
  const shouldAutoFocus =
    autoFocus ?? (typeof window !== 'undefined' && window.innerWidth >= 640);

  // 1 — focus on mount, or when revealed.
  useEffect(() => {
    if (!shouldAutoFocus) return;
    const el = ref.current;
    if (!el) return;
    if (isVisible(el)) {
      el.focus();
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          el.focus();
          observer.disconnect();
        }
      },
      { threshold: 0.1 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, shouldAutoFocus]);

  // 2 + 3 — one listener pair, both guarded on visibility.
  useEffect(() => {
    const onFocusRequest = () => {
      const el = ref.current;
      if (isVisible(el)) el.focus();
    };

    const onGlobalKeyDown = (e: KeyboardEvent) => {
      if (disabled || e.defaultPrevented) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (typeof e.key !== 'string' || e.key.length !== 1) return;
      const el = ref.current;
      if (!isVisible(el)) return;
      if (document.activeElement === el || el.contains(document.activeElement)) return;
      if (isTextEditingElement(document.activeElement)) return;
      // Focus only. The character is NOT replayed here — ProseMirror receives
      // the keypress itself once focused, and replaying would double it.
      e.preventDefault();
      el.focus();
      document.execCommand?.('insertText', false, e.key);
    };

    window.addEventListener('focus-session-textarea', onFocusRequest);
    window.addEventListener('keydown', onGlobalKeyDown);
    return () => {
      window.removeEventListener('focus-session-textarea', onFocusRequest);
      window.removeEventListener('keydown', onGlobalKeyDown);
    };
  }, [ref, disabled]);
}
```

- [ ] **Step 2: Typecheck**

Run from `apps/web`: `npx tsc --noEmit`
Expected: no new errors. (~15 known `@types/bun` `test.each` errors in 3 unrelated files are the pre-existing baseline.)

- [ ] **Step 3: Lint**

Run: `npx eslint src/features/session/composer/hooks/use-composer-focus.ts`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/features/session/composer/hooks/use-composer-focus.ts
git commit -m "feat(composer): extract focus behaviour into useComposerFocus"
```

---

### Task 2: Replace the hand-rolled file-search cache with TanStack Query

`session-chat-input.tsx:602-656` is ~55 lines implementing debounce, a stale-response guard (`fileSearchSeq`), and a result cache (`fileResultsCache`, a `Set` in a ref). All three are TanStack Query features, and because the cache is a ref it is per-composer — a second tab shares nothing.

**Files:**
- Create: `apps/web/src/features/session/composer/hooks/use-debounced-value.ts`
- Create: `apps/web/src/features/session/composer/hooks/use-debounced-value.test.ts`
- Create: `apps/web/src/features/session/composer/hooks/use-file-search.ts`

**Interfaces:**
- Consumes: `searchWorkspaceFiles(query, limit)` from `@/features/files`.
- Produces: `useFileSearch(query: string, enabled: boolean): { files: string[]; isLoading: boolean }`, and `useDebouncedValue<T>(value: T, ms: number): T`.

- [ ] **Step 1: Write the failing test for the debounce helper**

```ts
// use-debounced-value.test.ts
import { describe, expect, test } from 'bun:test';

import { shouldEmit } from './use-debounced-value';

describe('shouldEmit', () => {
  test('emits immediately when the value clears', () => {
    // An empty query must not wait 150ms — closing the menu should be instant.
    expect(shouldEmit('', 'abc')).toBe(true);
  });

  test('debounces a non-empty change', () => {
    expect(shouldEmit('ab', 'a')).toBe(false);
  });

  test('does not emit when the value is unchanged', () => {
    expect(shouldEmit('ab', 'ab')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test src/features/session/composer/hooks/use-debounced-value.test.ts`
Expected: FAIL — `Export named 'shouldEmit' not found`.

- [ ] **Step 3: Implement the helper**

```ts
// use-debounced-value.ts
'use client';

import { useEffect, useState } from 'react';

/**
 * Whether `next` should bypass the debounce timer.
 *
 * Clearing the query is the one case that must be immediate: it closes the
 * menu, and a 150ms lag there reads as the UI hanging.
 */
export function shouldEmit(next: string, current: string): boolean {
  if (next === current) return false;
  return next.length === 0;
}

export function useDebouncedValue(value: string, ms: number): string {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    if (shouldEmit(value, debounced)) {
      setDebounced(value);
      return;
    }
    if (value === debounced) return;
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, debounced, ms]);

  return debounced;
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `bun test src/features/session/composer/hooks/use-debounced-value.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Write the query hook**

```ts
// use-file-search.ts
'use client';

import { searchWorkspaceFiles } from '@/features/files';
import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { useDebouncedValue } from './use-debounced-value';

/**
 * Local to apps/web on purpose. `qk` lives in `packages/sdk`, which is
 * published to npm and gates every export on a snapshot test — a host-only
 * mention cache does not belong in that contract.
 */
const composerKeys = {
  fileSearch: (query: string) => ['web', 'composer', 'file-search', query] as const,
};

/**
 * File results for the `@` menu.
 *
 * Replaces session-chat-input.tsx:602-656 entirely:
 *  - `fileSearchTimer`   → useDebouncedValue on the key
 *  - `fileSearchSeq`     → the query key itself; a stale response resolves
 *                          under its own key and is never applied to a newer one
 *  - `fileResultsCache`  → keepPreviousData + a 30s staleTime, shared
 *                          process-wide instead of per-composer
 */
export function useFileSearch(query: string, enabled: boolean) {
  const debounced = useDebouncedValue(query, 150);

  const { data, isFetching } = useQuery({
    queryKey: composerKeys.fileSearch(debounced),
    queryFn: () => searchWorkspaceFiles(debounced),
    enabled,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    placeholderData: keepPreviousData,
    retry: false,
  });

  return { files: data ?? [], isLoading: isFetching && !data };
}
```

- [ ] **Step 6: Typecheck, lint, commit**

```bash
cd apps/web && npx tsc --noEmit && npx eslint src/features/session/composer/hooks/
cd ../.. && git add apps/web/src/features/session/composer/hooks/
git commit -m "feat(composer): move @ file search onto TanStack Query"
```

---

## Milestone 2 — Editor core

### Task 3: The editor shell

**Files:**
- Create: `apps/web/src/features/session/composer/editor/extensions.ts`
- Create: `apps/web/src/features/session/composer/editor/composer-editor.tsx`
- Modify: `apps/web/package.json` (add 2 MIT deps)

**Interfaces:**
- Consumes: `useComposerFocus` (Task 1).
- Produces: `ComposerEditorHandle { getContent(): { text: string; mentions: TrackedMention[] }; setContent(markdown: string): void; clear(): void; focus(): void; isEmpty(): boolean }`, and `<ComposerEditor ref placeholder disabled onSubmit onEmptyChange />`.

- [ ] **Step 1: Add the two MIT dependencies**

```bash
cd apps/web && pnpm add @tiptap/suggestion@^3 @tiptap/extension-mention@^3
```

Then confirm the licence, do not assume it:

```bash
node -e "for (const p of ['@tiptap/suggestion','@tiptap/extension-mention']) console.log(require(\`./node_modules/\${p}/package.json\`).license, p)"
```
Expected: `MIT @tiptap/suggestion` and `MIT @tiptap/extension-mention`.

- [ ] **Step 2: Declare the extension list explicitly**

```ts
// extensions.ts
import Blockquote from '@tiptap/extension-blockquote';
import Bold from '@tiptap/extension-bold';
import Code from '@tiptap/extension-code';
import CodeBlock from '@tiptap/extension-code-block';
import Document from '@tiptap/extension-document';
import HardBreak from '@tiptap/extension-hard-break';
import Italic from '@tiptap/extension-italic';
import Link from '@tiptap/extension-link';
import { BulletList, ListItem, OrderedList } from '@tiptap/extension-list';
import Paragraph from '@tiptap/extension-paragraph';
import Placeholder from '@tiptap/extension-placeholder';
import Strike from '@tiptap/extension-strike';
import Text from '@tiptap/extension-text';
import Typography from '@tiptap/extension-typography';
import { History } from '@tiptap/extensions';

/**
 * Deliberately NOT @tiptap/starter-kit — it pulls tables, images and
 * horizontal rules, none of which belong in a chat composer. Every extension
 * here is MIT and already installed.
 */
export function baseExtensions(placeholder: string) {
  return [
    Document,
    Paragraph,
    Text,
    HardBreak,
    History,
    Placeholder.configure({ placeholder }),
    Typography,
    Bold,
    Italic,
    Strike,
    Code,
    CodeBlock,
    Link.configure({ openOnClick: false, autolink: true }),
    BulletList,
    OrderedList,
    ListItem,
    Blockquote,
  ];
}
```

- [ ] **Step 3: Write the editor component**

```tsx
// composer-editor.tsx
'use client';

import { cn } from '@/lib/utils';
import { EditorContent, useEditor } from '@tiptap/react';
import { forwardRef, useImperativeHandle, useRef, useState } from 'react';

import type { TrackedMention } from '../types';
import { baseExtensions } from './extensions';
import { MentionNode } from './mention-node';
import { serializeDocument } from './serialize';

export interface ComposerEditorHandle {
  getContent(): { text: string; mentions: TrackedMention[] };
  setContent(markdown: string, mode?: 'replace' | 'merge'): void;
  clear(): void;
  focus(): void;
  isEmpty(): boolean;
}

export interface ComposerEditorProps {
  placeholder: string;
  disabled?: boolean;
  autoFocus?: boolean;
  onSubmit: () => void;
  /**
   * Fires ONLY on the empty↔non-empty boundary — once when the first character
   * is typed, once when the last is deleted, never in between. This is the
   * whole reason the toolbar stops re-rendering per keystroke.
   */
  onEmptyChange: (isEmpty: boolean) => void;
}

export const ComposerEditor = forwardRef<ComposerEditorHandle, ComposerEditorProps>(
  function ComposerEditor({ placeholder, disabled, autoFocus, onSubmit, onEmptyChange }, ref) {
    const wasEmpty = useRef(true);

    const editor = useEditor({
      immediatelyRender: false, // required: Next SSR
      autofocus: autoFocus,
      editable: !disabled,
      extensions: [...baseExtensions(placeholder), MentionNode],
      editorProps: {
        attributes: {
          role: 'textbox',
          'aria-multiline': 'true',
          'aria-label': 'Message input',
          class: 'outline-none min-h-[3rem] max-h-[12.5rem] overflow-y-auto',
        },
        handleKeyDown: (_view, event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            onSubmit();
            return true;
          }
          return false;
        },
      },
      onUpdate: ({ editor: e }) => {
        const empty = e.isEmpty;
        if (empty !== wasEmpty.current) {
          wasEmpty.current = empty;
          onEmptyChange(empty);
        }
      },
    });

    useImperativeHandle(
      ref,
      (): ComposerEditorHandle => ({
        getContent: () =>
          editor ? serializeDocument(editor.state.doc) : { text: '', mentions: [] },
        setContent: (markdown, mode = 'replace') => {
          if (!editor) return;
          if (mode === 'merge' && !editor.isEmpty) {
            editor.commands.insertContent(`\n${markdown}`);
          } else {
            editor.commands.setContent(markdown);
          }
          editor.commands.focus('end');
        },
        clear: () => editor?.commands.clearContent(),
        focus: () => editor?.commands.focus('end'),
        isEmpty: () => editor?.isEmpty ?? true,
      }),
      [editor],
    );

    return (
      <EditorContent
        editor={editor}
        className={cn('kortix-composer-editor w-full text-base sm:text-sm', disabled && 'opacity-50')}
      />
    );
  },
);
```

- [ ] **Step 4: Typecheck and commit**

```bash
cd apps/web && npx tsc --noEmit
cd ../.. && git add apps/web/package.json apps/web/src/features/session/composer/editor/ pnpm-lock.yaml
git commit -m "feat(composer): TipTap editor shell on the explicit extension list"
```

---

### Task 4: The mention atom node

This is the task that fixes the two live bugs: `text.indexOf` highlighting only the first occurrence, and substring pruning failing on duplicates.

**Files:**
- Create: `apps/web/src/features/session/composer/editor/mention-node.ts`
- Modify: `apps/web/src/features/session/composer/types.ts`

**Interfaces:**
- Consumes: `MentionKind` from `../types`.
- Produces: `MentionNode` (a TipTap `Node`), and `insertMention(editor, { kind, label, value })`.

- [ ] **Step 1: Add `MentionKind` to types.ts**

```ts
// Append to types.ts
export type MentionKind = 'file' | 'agent' | 'session';
```

Then narrow the two existing interfaces to use it:

```ts
export interface MentionItem {
  kind: MentionKind;
  label: string;
  value?: string;
  description?: string;
}

export interface TrackedMention {
  kind: MentionKind;
  label: string;
  value?: string; // session ID for session mentions
}
```

- [ ] **Step 2: Define the node**

```ts
// mention-node.ts
import { Node, mergeAttributes } from '@tiptap/core';

import type { MentionKind } from '../types';

export interface MentionAttrs {
  kind: MentionKind;
  label: string;
  value: string;
}

/**
 * An indivisible inline badge.
 *
 * `atom: true` is the entire point: the caret can never land inside the badge,
 * one backspace removes it whole, and every occurrence is a distinct node. The
 * string model it replaces could do none of these — `text.indexOf(needle)`
 * found only the FIRST match, so a second `@README.md` rendered as plain text.
 */
export const MentionNode = Node.create({
  name: 'mention',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      kind: { default: 'file' as MentionKind },
      label: { default: '' },
      value: { default: '' },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-mention]' }];
  },

  renderHTML({ HTMLAttributes, node }) {
    const label = String(node.attrs.label ?? '');
    const kind = String(node.attrs.kind ?? 'file');
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-mention': kind,
        'aria-label': `${kind} mention: ${label}`,
        class:
          'bg-muted text-foreground rounded-md px-1 py-0.5 text-[0.9em] font-medium ' +
          'whitespace-nowrap align-baseline',
      }),
      `@${label}`,
    ];
  },

  renderText({ node }) {
    return `@${node.attrs.label}`;
  },
});
```

- [ ] **Step 3: Typecheck, lint, commit**

```bash
cd apps/web && npx tsc --noEmit && npx eslint src/features/session/composer/editor/ src/features/session/composer/types.ts
cd ../.. && git add apps/web/src/features/session/composer/
git commit -m "feat(composer): atomic mention node replaces string-matched mentions"
```

---

### Task 5: Serialization — document to wire format

The wire format must not drift, because `parseFileMentionReferences`, `parseAgentMentionReferences` and `parseSessionReferences` on the receiving side are unchanged.

**Files:**
- Create: `apps/web/src/features/session/composer/editor/serialize.ts`
- Create: `apps/web/src/features/session/composer/editor/serialize.test.ts`

**Interfaces:**
- Consumes: `MentionAttrs` (Task 4), `TrackedMention` (types.ts).
- Produces: `serializeDocument(doc: ProseMirrorNode): { text: string; mentions: TrackedMention[] }`, and the pure `collectMentions(nodes)` it is built from.

- [ ] **Step 1: Write the failing test**

```ts
// serialize.test.ts
import { describe, expect, test } from 'bun:test';

import { collectMentions, type SerializableNode } from './serialize';

const mention = (kind: string, label: string, value = ''): SerializableNode => ({
  type: 'mention',
  attrs: { kind, label, value },
});
const text = (t: string): SerializableNode => ({ type: 'text', text: t });

describe('collectMentions', () => {
  test('every occurrence is tracked, not just the first', () => {
    // The bug this whole node model exists to kill: the old string version
    // used text.indexOf(needle) and found ONE match per label.
    const nodes = [mention('file', 'README.md'), text(' and '), mention('file', 'README.md')];
    expect(collectMentions(nodes)).toEqual([
      { kind: 'file', label: 'README.md' },
      { kind: 'file', label: 'README.md' },
    ]);
  });

  test('a session mention carries its id, other kinds do not', () => {
    const nodes = [mention('session', 'Fix the parser', 'ses_abc'), mention('agent', 'build')];
    expect(collectMentions(nodes)).toEqual([
      { kind: 'session', label: 'Fix the parser', value: 'ses_abc' },
      { kind: 'agent', label: 'build' },
    ]);
  });

  test('plain text contributes no mentions', () => {
    expect(collectMentions([text('just an @email@example.com here')])).toEqual([]);
  });

  test('an empty document yields an empty list', () => {
    expect(collectMentions([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test src/features/session/composer/editor/serialize.test.ts`
Expected: FAIL — `Export named 'collectMentions' not found`.

- [ ] **Step 3: Implement**

```ts
// serialize.ts
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

import type { MentionKind, TrackedMention } from '../types';

/** The shape `collectMentions` needs — kept structural so it is testable
 *  without constructing a real ProseMirror document. */
export interface SerializableNode {
  type: string;
  text?: string;
  attrs?: { kind?: string; label?: string; value?: string };
}

export function collectMentions(nodes: SerializableNode[]): TrackedMention[] {
  const mentions: TrackedMention[] = [];
  for (const node of nodes) {
    if (node.type !== 'mention') continue;
    const kind = (node.attrs?.kind ?? 'file') as MentionKind;
    const label = node.attrs?.label ?? '';
    // Only sessions round-trip an id — files and agents are addressed by label,
    // which is what the existing parsers on the receiving side expect.
    mentions.push(
      kind === 'session' ? { kind, label, value: node.attrs?.value ?? '' } : { kind, label },
    );
  }
  return mentions;
}

/** Flatten a ProseMirror document into the structural node list above. */
export function flattenDocument(doc: ProseMirrorNode): SerializableNode[] {
  const nodes: SerializableNode[] = [];
  doc.descendants((node) => {
    if (node.type.name === 'mention') {
      nodes.push({ type: 'mention', attrs: node.attrs as SerializableNode['attrs'] });
      return false;
    }
    if (node.isText) nodes.push({ type: 'text', text: node.text ?? '' });
    return true;
  });
  return nodes;
}

export function serializeDocument(doc: ProseMirrorNode): {
  text: string;
  mentions: TrackedMention[];
} {
  const flat = flattenDocument(doc);
  // `doc.textBetween` with a block separator gives markdown-compatible text and
  // calls each mention's renderText(), which emits `@label` — the exact token
  // the existing parsers already match.
  const text = doc.textBetween(0, doc.content.size, '\n', (node) =>
    node.type.name === 'mention' ? `@${node.attrs.label}` : '',
  );
  return { text: text.trim(), mentions: collectMentions(flat) };
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `bun test src/features/session/composer/editor/serialize.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/session/composer/editor/
git commit -m "feat(composer): serialize document to the existing wire format"
```

---

## Milestone 3 — Menus

### Task 6: Menu selection maths and section assembly

Both menus need "move the highlight, clamp it to the list". Today that is an effect (`session-chat-input.tsx:704-708`) that fires a render after every list change. It is arithmetic and belongs in a pure function.

**Files:**
- Create: `apps/web/src/features/session/composer/menus/menu-selection.ts` + `.test.ts`
- Create: `apps/web/src/features/session/composer/menus/menu-items.ts` + `.test.ts`

**Interfaces:**
- Produces: `moveSelection(current, delta, length): number`, `clampSelection(current, length): number`, `buildMentionSections({ agents, sessions, files, query, currentSessionId }): MentionSection[]`.

- [ ] **Step 1: Write the failing selection test**

```ts
// menu-selection.test.ts
import { describe, expect, test } from 'bun:test';

import { clampSelection, moveSelection } from './menu-selection';

describe('moveSelection', () => {
  test('wraps at both ends so the list feels circular', () => {
    expect(moveSelection(2, 1, 3)).toBe(0);
    expect(moveSelection(0, -1, 3)).toBe(2);
  });

  test('moves normally in the middle', () => {
    expect(moveSelection(0, 1, 3)).toBe(1);
    expect(moveSelection(2, -1, 3)).toBe(1);
  });

  test('stays at 0 for an empty list instead of returning NaN', () => {
    // n % 0 is NaN, which would render an undefined row.
    expect(moveSelection(0, 1, 0)).toBe(0);
  });
});

describe('clampSelection', () => {
  test('pulls an out-of-range index back to the last row', () => {
    // Replaces the clamp effect at session-chat-input.tsx:704.
    expect(clampSelection(7, 3)).toBe(2);
  });

  test('leaves an in-range index alone', () => {
    expect(clampSelection(1, 3)).toBe(1);
  });

  test('returns 0 for an empty list', () => {
    expect(clampSelection(3, 0)).toBe(0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test src/features/session/composer/menus/menu-selection.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// menu-selection.ts

/** Move the highlight, wrapping at both ends. */
export function moveSelection(current: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return (current + delta + length) % length;
}

/**
 * Keep the highlight inside the list.
 *
 * Derived during render, which is what lets the clamp effect at
 * session-chat-input.tsx:704-708 be deleted rather than ported.
 */
export function clampSelection(current: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(Math.max(current, 0), length - 1);
}
```

- [ ] **Step 4: Run and confirm pass**

Run: `bun test src/features/session/composer/menus/menu-selection.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Write the failing section-assembly test**

```ts
// menu-items.test.ts
import { describe, expect, test } from 'bun:test';

import { buildMentionSections } from './menu-items';

const agent = (name: string) => ({ name, hidden: false, mode: 'primary' }) as never;
const session = (id: string, title: string, updated = 0) =>
  ({ id, title, parentID: null, time: { updated, archived: null }, summary: null }) as never;

describe('buildMentionSections', () => {
  test('orders sections agents, sessions, files', () => {
    const sections = buildMentionSections({
      agents: [agent('build')],
      sessions: [session('ses_1', 'Parser')],
      files: ['src/app.tsx'],
      query: '',
      currentSessionId: undefined,
    });
    expect(sections.map((s) => s.kind)).toEqual(['agent', 'session', 'file']);
  });

  test('omits an empty section rather than rendering an empty heading', () => {
    const sections = buildMentionSections({
      agents: [],
      sessions: [],
      files: ['src/app.tsx'],
      query: '',
      currentSessionId: undefined,
    });
    expect(sections.map((s) => s.kind)).toEqual(['file']);
  });

  test('excludes the session you are already in', () => {
    const sections = buildMentionSections({
      agents: [],
      sessions: [session('ses_1', 'This one'), session('ses_2', 'Other')],
      files: [],
      query: '',
      currentSessionId: 'ses_1',
    });
    expect(sections[0].items.map((i) => i.value)).toEqual(['ses_2']);
  });

  test('assigns a contiguous flat index across sections for keyboard nav', () => {
    const sections = buildMentionSections({
      agents: [agent('build')],
      sessions: [session('ses_1', 'Parser')],
      files: ['a.ts', 'b.ts'],
      query: '',
      currentSessionId: undefined,
    });
    expect(sections.flatMap((s) => s.items.map((i) => i.index))).toEqual([0, 1, 2, 3]);
  });
});
```

- [ ] **Step 6: Run it, watch it fail, then implement**

Run: `bun test src/features/session/composer/menus/menu-items.test.ts`
Expected: FAIL — module not found.

```ts
// menu-items.ts
import type { Agent, Session } from '@kortix/sdk/react';

import type { MentionKind } from '../types';

export interface MenuRow {
  index: number;
  kind: MentionKind;
  label: string;
  value: string;
  description?: string;
}

export interface MentionSection {
  kind: MentionKind;
  heading: string;
  items: MenuRow[];
}

export function formatRelativeTime(timestamp: number, now: number): string {
  const minutes = Math.floor((now - timestamp) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
}

export interface BuildMentionSectionsInput {
  agents: Agent[];
  sessions: Session[];
  files: string[];
  query: string;
  currentSessionId: string | undefined;
  /** Injected so the test is deterministic. */
  now?: number;
}

const SESSION_LIMIT = 5;
const FILE_LIMIT = 20;

export function buildMentionSections({
  agents,
  sessions,
  files,
  query,
  currentSessionId,
  now = 0,
}: BuildMentionSectionsInput): MentionSection[] {
  const q = query.toLowerCase();
  let index = 0;
  const sections: MentionSection[] = [];

  const agentRows: MenuRow[] = agents
    .filter((a) => !a.hidden && a.mode !== 'subagent')
    .filter((a) => (a.name || '').toLowerCase().includes(q))
    .map((a) => ({ index: index++, kind: 'agent' as const, label: a.name || '', value: a.name || '' }));
  if (agentRows.length) sections.push({ kind: 'agent', heading: 'Agents', items: agentRows });

  const sessionRows: MenuRow[] = sessions
    .filter((s) => !s.parentID && !s.time.archived && s.id !== currentSessionId)
    .filter((s) => (s.title || '').toLowerCase().includes(q) || s.id.toLowerCase().includes(q))
    .slice(0, SESSION_LIMIT)
    .map((s) => {
      const ago = formatRelativeTime(s.time.updated, now);
      const count = s.summary?.files;
      return {
        index: index++,
        kind: 'session' as const,
        label: s.title || s.id,
        value: s.id,
        description: count ? `${ago} · ${count} file${count === 1 ? '' : 's'} changed` : ago,
      };
    });
  if (sessionRows.length) sections.push({ kind: 'session', heading: 'Sessions', items: sessionRows });

  const fileRows: MenuRow[] = files
    .filter((f) => q.length === 0 || f.toLowerCase().includes(q))
    .slice(0, FILE_LIMIT)
    .map((f) => ({ index: index++, kind: 'file' as const, label: f, value: f }));
  if (fileRows.length) sections.push({ kind: 'file', heading: 'Files', items: fileRows });

  return sections;
}
```

- [ ] **Step 7: Run both suites and commit**

```bash
cd apps/web && bun test src/features/session/composer/menus/
cd ../.. && git add apps/web/src/features/session/composer/menus/
git commit -m "feat(composer): pure menu selection and section assembly"
```

---

### Task 7: The `/` action registry

**Files:**
- Create: `apps/web/src/features/session/composer/menus/slash-actions.ts` + `.test.ts`

**Interfaces:**
- Produces: `SLASH_ACTIONS: SlashAction[]`, `filterSlashActions(actions, query)`, `type SlashActionId`.

- [ ] **Step 1: Write the failing test**

```ts
// slash-actions.test.ts
import { describe, expect, test } from 'bun:test';

import { SLASH_ACTIONS, filterSlashActions } from './slash-actions';

describe('SLASH_ACTIONS', () => {
  test('every action has a unique id', () => {
    const ids = SLASH_ACTIONS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('every action has a label and a description for the card layout', () => {
    for (const action of SLASH_ACTIONS) {
      expect(action.label.length).toBeGreaterThan(0);
      expect(action.description.length).toBeGreaterThan(0);
    }
  });
});

describe('filterSlashActions', () => {
  test('matches on label', () => {
    expect(filterSlashActions(SLASH_ACTIONS, 'model').map((a) => a.id)).toContain('switch-model');
  });

  test('matches on description so a synonym still finds the action', () => {
    expect(filterSlashActions(SLASH_ACTIONS, 'thinking').map((a) => a.id)).toContain(
      'set-reasoning-effort',
    );
  });

  test('an empty query returns every action', () => {
    expect(filterSlashActions(SLASH_ACTIONS, '')).toHaveLength(SLASH_ACTIONS.length);
  });

  test('a non-matching query returns none', () => {
    expect(filterSlashActions(SLASH_ACTIONS, 'zzzzz')).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test src/features/session/composer/menus/slash-actions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// slash-actions.ts

export type SlashActionId =
  | 'switch-model'
  | 'switch-agent'
  | 'set-reasoning-effort'
  | 'attach-file'
  | 'start-voice'
  | 'set-scope';

export interface SlashAction {
  id: SlashActionId;
  label: string;
  /** Also searched, so "thinking" finds reasoning effort. */
  description: string;
  /** Shown right-aligned when the action has a shortcut. */
  hint?: string;
}

/**
 * Composer operations, executed locally. These never reach the agent — they
 * open the control they name. Distinct from the Commands section, which runs
 * real OpenCode commands through `session.command()`.
 */
export const SLASH_ACTIONS: SlashAction[] = [
  {
    id: 'switch-model',
    label: 'Switch model',
    description: 'Choose which model runs this turn',
  },
  {
    id: 'switch-agent',
    label: 'Switch agent',
    description: 'Choose which agent answers',
    hint: 'Tab',
  },
  {
    id: 'set-reasoning-effort',
    label: 'Set reasoning effort',
    description: 'How much thinking the model does before answering',
  },
  { id: 'attach-file', label: 'Attach file', description: 'Add an image or document' },
  { id: 'start-voice', label: 'Start voice input', description: 'Dictate instead of typing' },
  { id: 'set-scope', label: 'Set scope', description: 'Limit which files this session may touch' },
];

export function filterSlashActions(actions: SlashAction[], query: string): SlashAction[] {
  const q = query.toLowerCase().trim();
  if (!q) return actions;
  return actions.filter(
    (a) => a.label.toLowerCase().includes(q) || a.description.toLowerCase().includes(q),
  );
}
```

- [ ] **Step 4: Run, confirm pass, commit**

```bash
cd apps/web && bun test src/features/session/composer/menus/slash-actions.test.ts
cd ../.. && git add apps/web/src/features/session/composer/menus/
git commit -m "feat(composer): local action registry for the / palette"
```

---

### Task 8: Wire both suggestion plugins and render the menus

**Files:**
- Create: `apps/web/src/features/session/composer/menus/mention-menu.tsx`
- Create: `apps/web/src/features/session/composer/menus/slash-menu.tsx`
- Create: `apps/web/src/features/session/composer/editor/suggestion.ts`
- Modify: `apps/web/src/features/session/composer/editor/composer-editor.tsx`
- Delete: `mention-popover.tsx`, `slash-command-popover.tsx`

**Interfaces:**
- Consumes: `buildMentionSections`, `moveSelection`, `clampSelection`, `SLASH_ACTIONS`, `useFileSearch`.
- Produces: `createMentionSuggestion(opts)`, `createSlashSuggestion(opts)` — both returning a TipTap `SuggestionOptions`.

- [ ] **Step 1: Build the suggestion factory**

Position comes from `suggestion`'s `clientRect` callback, fed to Floating UI. This replaces the `getBoundingClientRect()`-during-render in both old popovers, and means the menu now repositions on scroll.

```ts
// suggestion.ts — the shared shape both menus use.
import type { SuggestionOptions } from '@tiptap/suggestion';

export interface MenuController {
  onStart(props: { query: string; clientRect: (() => DOMRect | null) | null }): void;
  onUpdate(props: { query: string; clientRect: (() => DOMRect | null) | null }): void;
  onKeyDown(props: { event: KeyboardEvent }): boolean;
  onExit(): void;
}

/**
 * `allowedPrefixes: [' ', '\n']` reproduces the old rule — a trigger only fires
 * at the start of input or after whitespace, so `user@example.com` is not a
 * mention — without the backwards character walk at session-chat-input.tsx:1011.
 *
 * `startOfLine: false` is the fix for `/` being stuck at position 0. The old
 * regex was /^\/(\S*)$/, which made a slash command after a newline impossible.
 */
export function baseSuggestion(char: string, controller: MenuController): Partial<SuggestionOptions> {
  return {
    char,
    startOfLine: false,
    allowedPrefixes: [' ', '\n'],
    render: () => ({
      onStart: controller.onStart,
      onUpdate: controller.onUpdate,
      onKeyDown: controller.onKeyDown,
      onExit: controller.onExit,
    }),
  };
}
```

- [ ] **Step 2: Render the mention menu**

```tsx
// mention-menu.tsx
'use client';

import { getFileIcon } from '@/features/project-files';
import Loading from '@/components/ui/loading';
import { cn } from '@/lib/utils';
import { ChatIcon, FolderIcon } from '@phosphor-icons/react';

import type { MenuRow, MentionSection } from './menu-items';

export function MentionMenu({
  sections,
  selectedIndex,
  loading,
  onSelect,
}: {
  sections: MentionSection[];
  selectedIndex: number;
  loading: boolean;
  onSelect: (row: MenuRow) => void;
}) {
  if (!sections.length && !loading) return null;

  return (
    <div
      role="listbox"
      aria-label="Mention suggestions"
      aria-activedescendant={`mention-row-${selectedIndex}`}
      className="bg-popover border-border w-[min(28rem,90vw)] overflow-hidden rounded-xl border shadow-md"
    >
      <div className="max-h-72 overflow-y-auto p-1">
        {sections.map((section) => (
          <div key={section.kind}>
            <div className="text-muted-foreground px-2 py-1.5 text-xs font-medium">
              {section.heading}
            </div>
            {section.items.map((row) => (
              <button
                key={`${row.kind}-${row.value}-${row.index}`}
                id={`mention-row-${row.index}`}
                role="option"
                aria-selected={row.index === selectedIndex}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  onSelect(row);
                }}
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm',
                  row.index === selectedIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
                )}
              >
                <RowIcon row={row} />
                <span className="truncate font-medium">{rowTitle(row)}</span>
                {row.description && (
                  <span className="text-muted-foreground ml-auto truncate text-xs">
                    {row.description}
                  </span>
                )}
              </button>
            ))}
          </div>
        ))}
        {loading && (
          <div className="text-muted-foreground flex items-center gap-2 px-2 py-2 text-xs">
            <Loading className="size-3.5" />
            Searching…
          </div>
        )}
      </div>
    </div>
  );
}

function rowTitle(row: MenuRow): string {
  if (row.kind !== 'file') return row.label;
  const clean = row.label.endsWith('/') ? row.label.slice(0, -1) : row.label;
  return clean.split('/').pop() || clean;
}

function RowIcon({ row }: { row: MenuRow }) {
  if (row.kind === 'agent') {
    return (
      <span className="bg-foreground/10 text-foreground/60 flex size-4 shrink-0 items-center justify-center rounded text-xs font-semibold">
        @
      </span>
    );
  }
  if (row.kind === 'session') return <ChatIcon className="text-muted-foreground size-4 shrink-0" />;
  if (row.label.endsWith('/')) return <FolderIcon className="text-muted-foreground size-4 shrink-0" />;
  return getFileIcon(row.label, { className: 'size-4 shrink-0 text-muted-foreground' });
}
```

- [ ] **Step 3: Render the slash menu as cards**

```tsx
// slash-menu.tsx
'use client';

import { cn } from '@/lib/utils';
import type { Command } from '@kortix/sdk/react';

import type { SlashAction } from './slash-actions';

export interface SlashRow {
  index: number;
  type: 'command' | 'action';
  name: string;
  description: string;
  hint?: string;
}

export function SlashMenu({
  rows,
  selectedIndex,
  onSelect,
}: {
  rows: SlashRow[];
  selectedIndex: number;
  onSelect: (row: SlashRow) => void;
}) {
  if (!rows.length) return null;
  const commands = rows.filter((r) => r.type === 'command');
  const actions = rows.filter((r) => r.type === 'action');

  return (
    <div
      role="listbox"
      aria-label="Commands and actions"
      aria-activedescendant={`slash-row-${selectedIndex}`}
      className="bg-popover border-border w-[min(28rem,90vw)] overflow-hidden rounded-xl border shadow-md"
    >
      <div className="max-h-80 overflow-y-auto p-1">
        <SlashGroup heading="Commands" rows={commands} selectedIndex={selectedIndex} onSelect={onSelect} />
        <SlashGroup heading="Actions" rows={actions} selectedIndex={selectedIndex} onSelect={onSelect} />
      </div>
    </div>
  );
}

function SlashGroup({
  heading,
  rows,
  selectedIndex,
  onSelect,
}: {
  heading: string;
  rows: SlashRow[];
  selectedIndex: number;
  onSelect: (row: SlashRow) => void;
}) {
  if (!rows.length) return null;
  return (
    <div>
      <div className="text-muted-foreground px-2 py-1.5 text-xs font-medium">{heading}</div>
      {rows.map((row) => (
        <button
          key={`${row.type}-${row.name}`}
          id={`slash-row-${row.index}`}
          role="option"
          aria-selected={row.index === selectedIndex}
          type="button"
          onMouseDown={(e) => {
            e.preventDefault();
            onSelect(row);
          }}
          className={cn(
            'flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left',
            row.index === selectedIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
          )}
        >
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">
              {row.type === 'command' ? `/${row.name}` : row.name}
            </div>
            <p className="text-muted-foreground truncate text-xs">{row.description}</p>
          </div>
          {row.hint && (
            <kbd className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 font-sans text-xs">
              {row.hint}
            </kbd>
          )}
        </button>
      ))}
    </div>
  );
}

export function toCommandRows(commands: Command[], startIndex: number): SlashRow[] {
  return commands.map((c, i) => ({
    index: startIndex + i,
    type: 'command' as const,
    name: c.name || '',
    description: c.description || '',
  }));
}

export function toActionRows(actions: SlashAction[], startIndex: number): SlashRow[] {
  return actions.map((a, i) => ({
    index: startIndex + i,
    type: 'action' as const,
    name: a.label,
    description: a.description,
    hint: a.hint,
  }));
}
```

- [ ] **Step 4: Delete the superseded popovers**

```bash
git rm apps/web/src/features/session/composer/mention-popover.tsx \
       apps/web/src/features/session/composer/slash-command-popover.tsx
```

- [ ] **Step 5: Typecheck, lint, commit**

```bash
cd apps/web && npx tsc --noEmit && npx eslint src/features/session/composer/
cd ../.. && git add -u && git add apps/web/src/features/session/composer/
git commit -m "feat(composer): @ and / menus on tiptap suggestion + floating ui"
```

---

### Task 9: Revalidate agents and commands when a menu opens

`useOpenCodeCommands` sets `staleTime: Infinity` (`packages/sdk/src/react/use-opencode-sessions/commands.ts:26`), so a skill created after page load never appears. Jay's requirement is that `@` and `/` show the latest.

**Files:**
- Modify: `apps/web/src/features/session/composer/hooks/use-file-search.ts` (add `useMenuRevalidation`)

**Interfaces:**
- Produces: `useMenuRevalidation(isOpen: boolean): void`.

- [ ] **Step 1: Add the hook**

`staleTime: Infinity` lives in the published SDK, and changing it there would alter behaviour for every consumer. Invalidating from the host is the correct seam.

```ts
// append to use-file-search.ts
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

/**
 * Agents and commands are cached with `staleTime: Infinity` in the SDK, so a
 * skill or agent created after page load would never appear. Invalidate on the
 * open transition only — not on every keystroke, and not on close.
 *
 * Done from the host rather than by lowering staleTime in @kortix/sdk: that
 * package is published, and the setting is correct for its other consumers.
 */
export function useMenuRevalidation(isOpen: boolean) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!isOpen) return;
    queryClient.invalidateQueries({ queryKey: ['opencode', 'commands'] });
    queryClient.invalidateQueries({ queryKey: ['opencode', 'agents'] });
  }, [isOpen, queryClient]);
}
```

- [ ] **Step 2: Re-confirm the key prefixes still match**

Verified 2026-08-09 — `packages/sdk/src/react/use-opencode-sessions/keys.ts`:

```ts
agents:   () => ['opencode', 'agents',   activeServerKey()] as const,   // :128
commands: () => ['opencode', 'commands', activeServerKey()] as const,   // :135
```

The keys carry a third `activeServerKey()` segment. The prefixes in Step 1 are
still correct because `invalidateQueries` **prefix-matches by default**, so
`['opencode','commands']` matches every server's entry — which is what we want.

Re-run the check before relying on it, since an invalidate against a wrong key
fails silently and no test in this plan would catch it:

```bash
rg -n "agents:|commands:" packages/sdk/src/react/use-opencode-sessions/keys.ts
```
Expected: the two lines above. If a segment moved to the FRONT of either array,
the prefix no longer matches and must be updated.

- [ ] **Step 3: Typecheck, lint, commit**

```bash
cd apps/web && npx tsc --noEmit && npx eslint src/features/session/composer/hooks/
cd ../.. && git add apps/web/src/features/session/composer/hooks/
git commit -m "feat(composer): revalidate agents and commands on menu open"
```

---

## Milestone 4 — Chrome

### Task 10: Model popover absorbs variant and reasoning effort

**Files:**
- Modify: `apps/web/src/features/session/model-selector.tsx` (add a footer section above the defaults block at :442)
- Modify: `apps/web/src/features/session/composer/composer-toolbar.tsx` (drop `VariantSelector` and `ReasoningEffortSelector` from the inline row)

**Interfaces:**
- Consumes: `variants`, `selectedVariant`, `onVariantChange`, `projectId` — all already threaded to `ComposerToolbar`.
- Produces: `ModelSelectorProps` gains `variants?`, `selectedVariant?`, `onVariantChange?`, `projectId?`.

- [ ] **Step 1: Remove the two selectors from the inline row**

In `composer-toolbar.tsx`, delete the `showVariant` block (lines 175-181) and the bare `<ReasoningEffortSelector … />` (line 184), and pass their props into `ModelSelector` instead:

```tsx
{showModel && (
  <ModelSelector
    models={models}
    modelsLoading={modelsLoading}
    selectedModel={selectedModel}
    onSelect={onModelChange!}
    providers={providers}
    defaultControls={modelDefaultControls}
    variants={variants}
    selectedVariant={selectedVariant}
    onVariantChange={onVariantChange}
    projectId={projectId}
  />
)}
```

- [ ] **Step 2: Render them inside the popover**

In `model-selector.tsx`, insert directly above the `defaultControls` block at line 442:

```tsx
{availableSelectedModel && (variants.length > 0 || projectId) && (
  <div className="border-border/60 flex flex-col gap-1 border-t p-1.5">
    {/* Capability-gated internally — renders nothing when the selected model
        exposes no reasoning-effort knob, exactly as it did in the toolbar. */}
    <ReasoningEffortSelector model={availableSelectedModel} projectId={projectId} inline />
    {variants.length > 0 && onVariantChange && (
      <VariantSelector
        variants={variants}
        selectedVariant={selectedVariant ?? null}
        onSelect={onVariantChange}
        inline
      />
    )}
  </div>
)}
```

- [ ] **Step 3: Verify the capability gate still short-circuits**

Read `reasoning-effort-selector.tsx` and confirm it returns `null` when the model has no effort knob. If the `inline` prop does not exist, add it as a presentation-only variant — **do not change the gating predicate.**

Run: `bun test src/features/session/reasoning-effort-selector.test.ts`
Expected: PASS, unchanged.

- [ ] **Step 4: Typecheck, lint, commit**

```bash
cd apps/web && npx tsc --noEmit && npx eslint src/features/session/model-selector.tsx src/features/session/composer/composer-toolbar.tsx
cd ../.. && git add apps/web/src/features/session/
git commit -m "feat(composer): fold variant and reasoning effort into the model popover"
```

---

### Task 11: Attachment tiles matching the sent message

**Files:**
- Create: `apps/web/src/features/session/composer/attachment-tiles.tsx`
- Delete: `apps/web/src/features/session/composer/attachment-preview.tsx`

**Interfaces:**
- Consumes: `AttachedFile` from `../types`, `getFileIcon` from `@/lib/utils/file-utils`.
- Produces: `<AttachmentTiles files onRemove />`.

- [ ] **Step 1: Build the tiles using the sent-message treatment**

Mirror `turn/user-message.tsx:464-649` so the composer preview and the sent message are the same shape. Keep the HEIC conversion and text-preview logic from `attachment-preview.tsx:16-134` verbatim — both are correct and non-obvious.

```tsx
// attachment-tiles.tsx — key surface constants, copied from user-message.tsx
// so the two stay visually identical.
const TILE_SURFACE =
  'border-border bg-background relative block size-20 shrink-0 overflow-hidden rounded-md border';
const TILE_INTERACTIVE = 'hover:bg-muted/50 cursor-pointer transition-colors active:scale-[0.97]';
```

Wrapping row, not a grid:

```tsx
<ul className="flex flex-wrap gap-2 px-3 pt-3">
  {files.map((af, i) => (
    <li key={i} className="group relative contents">
      {/* tile + corner remove button */}
    </li>
  ))}
</ul>
```

The remove button keeps its current classes but becomes always-visible on touch:

```tsx
className={cn(
  'border-card absolute -top-1.5 -right-1.5 z-10 flex size-5 items-center justify-center',
  'rounded-full border-2 bg-black text-white dark:bg-white dark:text-black',
  'opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100',
  '[@media(pointer:coarse)]:opacity-100',
)}
```

- [ ] **Step 2: Delete the old preview and typecheck**

```bash
git rm apps/web/src/features/session/composer/attachment-preview.tsx
cd apps/web && npx tsc --noEmit
```
Expected: errors only where `AttachmentPreview` was imported — fix those to `AttachmentTiles`.

- [ ] **Step 3: Lint and commit**

```bash
cd apps/web && npx eslint src/features/session/composer/
cd ../.. && git add -u && git add apps/web/src/features/session/composer/
git commit -m "feat(composer): attachment tiles match the sent-message treatment"
```

---

### Task 12: The composer shell, surface, a11y and mobile

**Files:**
- Create: `apps/web/src/features/session/composer/composer.tsx`

**Interfaces:**
- Consumes: everything from Tasks 1-11.
- Produces: `<Composer {...SessionChatInputProps} />` — the exact prop interface the old `SessionChatInputImpl` had.

- [ ] **Step 1: Build the shell**

It holds `attachedFiles`, `stagedCommand`, `isDragOver`, `isEmpty` — and **no text**. Port these unchanged from `session-chat-input.tsx`: `appendAttachedFiles` (:501), the four drag handlers (:526-568), `handlePaste` (:570), `removeAttachedFile` (:582), and `handleSubmit` (:742-873) with `text` replaced by `editorRef.current.getContent()`.

Card surface:

```tsx
className={cn(
  'bg-card border-border relative z-10 w-full rounded-xl border',
  'shadow-none transition-[border-color,box-shadow] duration-150',
  'focus-within:border-foreground/20 focus-within:shadow-sm',
  'focus-within:ring-ring focus-within:ring-2 focus-within:ring-offset-2',
  cardClassName,
  isDragOver && 'border-primary',
)}
```

- [ ] **Step 2: Make the toolbar responsive without wrapping**

```tsx
<div className="mb-1.5 flex items-center justify-between gap-1 pr-1.5 pl-2">
  <div className="flex min-w-0 items-center gap-0">
    {/* attach, agent, model — each trigger gets max-w-[7rem] truncate */}
  </div>
  <div className="flex shrink-0 items-center gap-0">
    <div className="hidden sm:flex"><TokenProgress … /></div>
    {toolbarSlot}
    <VoiceRecorder … />
    <SendStopControl … />
  </div>
</div>
```

Coarse-pointer targets, added once at the shell:

```css
/* globals.css */
@media (pointer: coarse) {
  .kortix-composer-toolbar button { min-height: 2.5rem; min-width: 2.5rem; }
}
```

- [ ] **Step 3: Honour reduced motion for the menus**

```tsx
className="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 motion-reduce:animate-none"
```

- [ ] **Step 4: Typecheck, lint, commit**

```bash
cd apps/web && npx tsc --noEmit && npx eslint src/features/session/composer/composer.tsx
cd ../.. && git add apps/web/src/features/session/composer/composer.tsx apps/web/src/app/globals.css
git commit -m "feat(composer): shell, surface, a11y and mobile layout"
```

---

## Milestone 5 — Swap and verify

### Task 13: Swap the call sites and reduce the old file to a barrel

**Files:**
- Modify: `apps/web/src/features/session/session-chat-input.tsx` (1,383 → ~10 lines)
- Modify: `apps/web/src/features/session/session-chat.tsx` (import at :57, render at :3937)

- [ ] **Step 1: Replace the old file's body with the barrel**

The 13 external importers listed in the spec §8.2 must keep working, so the module stays — only its implementation goes.

```ts
'use client';

/**
 * Public module boundary for the composer. No logic lives here.
 *
 * Kept as a barrel rather than deleted because 13 modules outside the composer
 * import from this path — `flattenModels` alone has 6 importers across
 * onboarding, the command palette, schedules, channels and the agent editor.
 * Deleting it would drag all of them into an unrelated diff.
 */
export { Composer as SessionChatInput } from './composer/composer';
export type { SessionChatInputProps } from './composer/composer';
export { AgentSelector } from './composer/agent-selector';
export { flattenModels, type FlatModel } from './model-flatten';
export type { AttachedFile, MentionItem, MentionKind, TrackedMention } from './composer/types';
export type { ProviderListResponse } from '@kortix/sdk/react';
```

- [ ] **Step 2: Verify every importer still resolves**

```bash
cd apps/web && npx tsc --noEmit
```
Expected: no new errors. This single command proves all 13 importers still resolve — that is exactly what the barrel is for.

- [ ] **Step 3: Confirm the two ComposerChatInput sites were untouched**

```bash
git diff --name-only | grep -E 'instant-session-shell|project-home' && echo "UNEXPECTED — these should not change" || echo "correct: neither file changed"
```
Expected: `correct: neither file changed`.

- [ ] **Step 4: Run the full composer suite and commit**

```bash
cd apps/web && bun test src/features/session
cd ../.. && git add apps/web/src/features/session/
git commit -m "refactor(composer): swap to the new composer, reduce old module to a barrel"
```

---

### Task 14: Walk the 22-row compatibility matrix

The rewrite's real risk is a silently dropped behaviour. Spec §7 lists all 22 with their current source lines.

**Files:**
- Create: `docs/superpowers/plans/2026-08-09-enhance-chat-input-verification.md`

- [ ] **Step 1: Confirm the protected suites are green and unmodified**

```bash
cd apps/web && bun test src/features/session
git diff --stat -- '*composer-reset.test.ts' '*composer-draft-recovery.test.ts' \
  '*message-queue-boundary.test.ts' '*queued-messages-logic.test.ts' \
  '*model-availability.test.ts' '*model-flatten.test.ts'
```
Expected: all tests pass, and `git diff --stat` prints **nothing**. A modified protected test means a contract moved — stop and report it rather than accepting the diff.

- [ ] **Step 2: Record evidence per row**

Write the verification file with one row per §7 entry: behaviour, how it was checked, and the actual output. Mark anything unverified as unverified — do not leave a blank implying coverage.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/plans/2026-08-09-enhance-chat-input-verification.md
git commit -m "docs(composer): compatibility matrix verification evidence"
```

---

### Task 15: Measure the performance and bundle budgets

Spec §6 states targets. This task produces the numbers; it does not assume them.

- [ ] **Step 1: Record the bundle baseline from before the change**

```bash
git stash && cd apps/web && pnpm build 2>&1 | tee /tmp/bundle-before.txt && cd ../.. && git stash pop
```

- [ ] **Step 2: Measure after**

```bash
cd apps/web && pnpm build 2>&1 | tee /tmp/bundle-after.txt
diff <(grep -E 'First Load JS|/sessions' /tmp/bundle-before.txt) \
     <(grep -E 'First Load JS|/sessions' /tmp/bundle-after.txt)
```

- [ ] **Step 3: Apply the budget**

Spec §6 sets the ceiling at **baseline + 100 KB gz**. If the delta exceeds it, cut extensions from `extensions.ts` — `Typography`, `Link` and `CodeBlock` are the first candidates — and re-measure. **Do not open the PR over budget.**

- [ ] **Step 4: Record both numbers in the verification doc and commit**

```bash
git add docs/superpowers/plans/2026-08-09-enhance-chat-input-verification.md
git commit -m "docs(composer): bundle and render budget measurements"
```

---

## Self-Review

**Spec coverage.** §1.1 → T3/T12; §1.2 → T3 (placeholder deleted); §1.3 → T2/T5/T8; §1.4 → T4/T5/T8; §1.5 → T1/T2/T6; §4.1 → T12; §4.2 → T3; §4.3 → T4; §5.1 → T6/T8/T9; §5.2 → T7/T8; §5.3 → T10; §5.4 → T5; §5.5 → T11; §5.6 → T12; §6 → T15; §7 → T14; §8 → T13. No gaps.

**Type consistency.** `MentionKind` defined in T4 and used in T5/T6. `TrackedMention` unchanged from the existing `types.ts`. `ComposerEditorHandle` defined in T3, consumed in T12. `MenuRow`/`MentionSection` defined in T6, consumed in T8. `SlashAction`/`SlashActionId` defined in T7, consumed in T8. `SlashRow` defined in T8 only.

**Known risk left explicit.** T9's invalidation is the one step no test in this plan covers: an `invalidateQueries` against a wrong key fails silently. The prefixes were verified against `keys.ts:128` and `:135` on 2026-08-09 and prefix-match correctly past the trailing `activeServerKey()` segment, but that verification is a point-in-time read, not a guard. If the SDK reorders those arrays, this breaks quietly.
