# Composer Draft Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An unsent composer draft survives a page refresh, keyed per project (home composer) and per session (session composer), restoring text and `@mention` chips exactly as typed.

**Architecture:** A new `features/session/composer/draft/` module holds all pure logic (scope keying, envelope serialize/deserialize, size cap, restore precedence) plus a thin seam over the existing `ScopedCache` in `lib/storage/managed-storage.ts`. `ComposerEditor` gains an optional `onDocChange` prop fired from its existing `onUpdate`; a `useComposerDraft` hook debounces that into `localStorage` through a ref-held timer, setting no React state. Restore runs once per scope, only when no prefill is present and the editor is empty.

**Tech Stack:** Next.js 16 / React 19, TipTap 3 (`@tiptap/core`, `@tiptap/react`), zustand-adjacent `ScopedCache` storage helper, `bun test`, TypeScript, ESLint.

**Spec:** `docs/superpowers/specs/2026-08-23-composer-draft-persistence-design.md`

## Global Constraints

- **Browser-local only.** `localStorage` via `ScopedCache`. No API route, no DB migration, no `@kortix/sdk` change.
- **Persisted payload is `JSONContent`**, never a plain string. `setContent(text)` cannot rebuild `mention` atom nodes (`editor/composer-editor.tsx:50-72`); storing text silently breaks `<file_ref>` / `<agent_ref>` / `<session_ref>` on the next send.
- **No React state on the typing path.** `ComposerEditor` is render-silent while typing — `onEmptyChange` fires only on the empty↔non-empty boundary (`editor/composer-editor.tsx:123`). The save path must use refs and timers only.
- **All storage writes go through `lib/storage/managed-storage.ts`.** Never call `localStorage` directly. That module is the documented chokepoint that prevents a repeat of the `QuotaExceededError` outage recorded at its lines 1-28.
- **`local` attachments are dropped silently.** They hold a live `File` and a blob object URL; neither survives a reload. Only `remote` attachments are stored.
- **Cache family:** `kortix_draft`. **Scope cap:** 50. **Per-draft size cap:** 131072 bytes (128 KB).
- **Envelope version:** `1`. A mismatch makes `deserializeDraft` return `null`.
- **Verification is `bun test` + `tsc --noEmit` + `eslint` only.** No browser, no Playwright, no stack boot (operator's standing rule).
- **Working directory for every command:** `/Users/jay/root/kortix/suna-composer-drafts` (worktree, branch `composer-drafts`).
- **Known-clean baseline:** `apps/web` `tsc --noEmit` reports ~15 pre-existing `@types/bun` `test.each` errors in 3 test files (`app/(system)/api/og/template/template-url.test.ts`, `features/file-viewer/preview-fit.test.tsx`, `features/session/action-panel/easy/easy-panel-logic.test.ts`). Those are expected. Any OTHER error is a regression.
- **Do not commit or push without asking the operator first.** Commit steps below are written out so the diff is staged correctly when permission is given.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `apps/web/src/features/session/composer/draft/composer-draft.ts` | **New.** Pure logic only — no DOM, no storage, no React. Scope keying, envelope serialize/deserialize, size cap, restore precedence. |
| `apps/web/src/features/session/composer/draft/composer-draft.test.ts` | **New.** Unit tests for the above. |
| `apps/web/src/features/session/composer/draft/composer-draft-store.ts` | **New.** Thin seam over `ScopedCache`. The only file in the feature that touches storage. |
| `apps/web/src/features/session/composer/draft/composer-draft-store.test.ts` | **New.** Round-trip, prune, and remove, against a fake `localStorage`. |
| `apps/web/src/features/session/composer/draft/use-composer-draft.ts` | **New.** React glue — debounce, flush listeners, restore-once effect. Kept out of `composer.tsx`, which is already 1576 lines. |
| `apps/web/src/features/session/composer/editor/composer-editor.tsx` | **Modify.** Add optional `onDocChange` prop, a ref for it, and `createUpdateHandler` composing it with the existing `trackEmptyBoundary`. |
| `apps/web/src/features/session/composer/editor/composer-editor.test.ts` | **Modify.** Add a headless test that `createUpdateHandler` fires per document change while `onEmptyChange` still fires only on the boundary. |
| `apps/web/src/features/session/composer/composer.tsx` | **Modify.** Accept `draftScope`, call the hook, wire `onDocChange`, restore into editor + attachments, clear on successful send. |
| `apps/web/src/features/session/composer-chat-input.tsx` | **Modify.** Thread `draftScope` through to `SessionChatInput`. |
| `apps/web/src/features/workspace/project-layout/project-home.tsx` | **Modify.** Pass the project scope. |
| `apps/web/src/features/session/instant-session-shell.tsx` | **Modify.** Pass the session scope. |
| `apps/web/src/features/session/session-chat.tsx` | **Modify.** Pass the session scope (memoized — the composer is `React.memo`-wrapped). |

---

## Task 1: Pure draft logic

**Files:**
- Create: `apps/web/src/features/session/composer/draft/composer-draft.ts`
- Test: `apps/web/src/features/session/composer/draft/composer-draft.test.ts`

**Interfaces:**
- Consumes: `AttachedFile` from `../types`, `JSONContent` from `@tiptap/core`.
- Produces:
  - `type DraftScope = { kind: 'project'; projectId: string } | { kind: 'session'; sessionId: string }`
  - `type RemoteAttachedFile = Extract<AttachedFile, { kind: 'remote' }>`
  - `const DRAFT_ENVELOPE_VERSION = 1`
  - `const MAX_DRAFT_BYTES = 131072`
  - `interface StoredDraft { v: number; u: string; doc: JSONContent; files: RemoteAttachedFile[] }`
  - `function draftScopeKey(scope: DraftScope): string`
  - `function serializeDraft(input: { doc: JSONContent; documentIsEmpty: boolean; files: readonly AttachedFile[]; userId: string }): StoredDraft | null`
  - `function deserializeDraft(raw: unknown, currentUserId: string): StoredDraft | null`
  - `function shouldRestoreDraft(input: { editorReady: boolean; editorIsEmpty: boolean; hasPrefill: boolean; alreadyRestored: boolean }): boolean`

**Note on `documentIsEmpty`:** it is passed in, never re-derived here. The canonical definition of "empty" for a TipTap document is `editor.isEmpty`, and the caller already holds a live `ComposerEditorHandle.isEmpty()`. `composer-draft-recovery.ts:38-44` records the same reasoning for `mergeFailedSubmissionDocument`; re-implementing emptiness here would risk drifting from it.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/features/session/composer/draft/composer-draft.test.ts`:

```ts
import type { JSONContent } from '@tiptap/core';
import { describe, expect, test } from 'bun:test';

import type { AttachedFile } from '../types';
import {
  DRAFT_ENVELOPE_VERSION,
  MAX_DRAFT_BYTES,
  deserializeDraft,
  draftScopeKey,
  serializeDraft,
  shouldRestoreDraft,
  type StoredDraft,
} from './composer-draft';

const USER = 'user-aaa';
const OTHER_USER = 'user-bbb';

const EMPTY_DOC: JSONContent = { type: 'doc', content: [{ type: 'paragraph' }] };

const TEXT_DOC: JSONContent = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'ship it' }] }],
};

/** A document whose paragraph holds a `mention` ATOM node, not text. */
const MENTION_DOC: JSONContent = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'look at ' },
        { type: 'mention', attrs: { kind: 'file', label: 'README.md', value: 'README.md' } },
      ],
    },
  ],
};

const REMOTE_FILE: AttachedFile = {
  kind: 'remote',
  url: 'https://example.test/a.png',
  filename: 'a.png',
  mime: 'image/png',
  isImage: true,
};

const LOCAL_FILE: AttachedFile = {
  kind: 'local',
  file: new File(['x'], 'b.png', { type: 'image/png' }),
  localUrl: 'blob:local-b',
  isImage: true,
};

describe('draftScopeKey', () => {
  test('project and session scopes produce distinct, prefixed keys', () => {
    expect(draftScopeKey({ kind: 'project', projectId: 'p1' })).toBe('project:p1');
    expect(draftScopeKey({ kind: 'session', sessionId: 'p1' })).toBe('session:p1');
  });
});

describe('serializeDraft', () => {
  test('an empty document with no remote files stores nothing', () => {
    expect(
      serializeDraft({ doc: EMPTY_DOC, documentIsEmpty: true, files: [], userId: USER }),
    ).toBeNull();
  });

  test('an empty document WITH a remote file is still worth storing', () => {
    const draft = serializeDraft({
      doc: EMPTY_DOC,
      documentIsEmpty: true,
      files: [REMOTE_FILE],
      userId: USER,
    });
    expect(draft?.files).toEqual([REMOTE_FILE]);
  });

  test('local attachments are dropped, remote ones are kept', () => {
    const draft = serializeDraft({
      doc: TEXT_DOC,
      documentIsEmpty: false,
      files: [LOCAL_FILE, REMOTE_FILE],
      userId: USER,
    });
    expect(draft?.files).toEqual([REMOTE_FILE]);
  });

  test('stamps the envelope version and the author user id', () => {
    const draft = serializeDraft({
      doc: TEXT_DOC,
      documentIsEmpty: false,
      files: [],
      userId: USER,
    });
    expect(draft?.v).toBe(DRAFT_ENVELOPE_VERSION);
    expect(draft?.u).toBe(USER);
  });

  test('a draft over the size cap is refused rather than stored', () => {
    const huge: JSONContent = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'x'.repeat(MAX_DRAFT_BYTES + 1) }] },
      ],
    };
    expect(
      serializeDraft({ doc: huge, documentIsEmpty: false, files: [], userId: USER }),
    ).toBeNull();
  });
});

describe('deserializeDraft', () => {
  test('a mention atom node survives the round trip intact', () => {
    const stored = serializeDraft({
      doc: MENTION_DOC,
      documentIsEmpty: false,
      files: [],
      userId: USER,
    });
    const back = deserializeDraft(JSON.parse(JSON.stringify(stored)), USER);
    // The regression guard for the whole feature: storing text instead of the
    // document would flatten this atom to the literal string "@README.md" and
    // the next send would carry no <file_ref> block.
    expect(back?.doc.content?.[0]?.content?.[1]).toEqual({
      type: 'mention',
      attrs: { kind: 'file', label: 'README.md', value: 'README.md' },
    });
  });

  test('a draft written by another user is refused', () => {
    const stored = serializeDraft({
      doc: TEXT_DOC,
      documentIsEmpty: false,
      files: [],
      userId: USER,
    });
    expect(deserializeDraft(stored, OTHER_USER)).toBeNull();
  });

  test('a stale envelope version is refused', () => {
    const stale = { v: 0, u: USER, doc: TEXT_DOC, files: [] } as unknown as StoredDraft;
    expect(deserializeDraft(stale, USER)).toBeNull();
  });

  test('malformed input is refused rather than thrown on', () => {
    expect(deserializeDraft(null, USER)).toBeNull();
    expect(deserializeDraft('not an object', USER)).toBeNull();
    expect(deserializeDraft({ v: 1, u: USER }, USER)).toBeNull();
    expect(deserializeDraft({ v: 1, u: USER, doc: TEXT_DOC, files: 'no' }, USER)).toBeNull();
  });

  test('an empty current user id refuses every draft', () => {
    const stored = serializeDraft({
      doc: TEXT_DOC,
      documentIsEmpty: false,
      files: [],
      userId: USER,
    });
    expect(deserializeDraft(stored, '')).toBeNull();
  });
});

describe('shouldRestoreDraft — precedence', () => {
  const ready = { editorReady: true, editorIsEmpty: true, hasPrefill: false, alreadyRestored: false };

  test('restores on ready + empty + no prefill + not yet restored', () => {
    expect(shouldRestoreDraft(ready)).toBe(true);
  });

  test('a prefill wins over a stored draft', () => {
    expect(shouldRestoreDraft({ ...ready, hasPrefill: true })).toBe(false);
  });

  test('never restores twice for one scope', () => {
    expect(shouldRestoreDraft({ ...ready, alreadyRestored: true })).toBe(false);
  });

  test('never overwrites text already in the editor', () => {
    expect(shouldRestoreDraft({ ...ready, editorIsEmpty: false })).toBe(false);
  });

  test('waits for the editor to be ready', () => {
    expect(shouldRestoreDraft({ ...ready, editorReady: false })).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/jay/root/kortix/suna-composer-drafts/apps/web && bun test src/features/session/composer/draft/composer-draft.test.ts
```

Expected: FAIL — `Cannot find module './composer-draft'`.

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/features/session/composer/draft/composer-draft.ts`:

```ts
import type { JSONContent } from '@tiptap/core';

import type { AttachedFile } from '../types';

/**
 * What a persisted composer draft is keyed by.
 *
 * Project scope is the home hero composer — one draft per project, because
 * that composer has no session yet. Session scope is every in-thread composer.
 * Both ids are UUIDs, so the two families can never collide.
 */
export type DraftScope =
  | { kind: 'project'; projectId: string }
  | { kind: 'session'; sessionId: string };

/**
 * The only attachment shape that can cross a reload. A `local` AttachedFile
 * holds a live `File` and a blob object URL: the `File` is not JSON, and the
 * blob URL is revoked the moment the document unloads. Storing either would
 * restore an attachment chip pointing at nothing.
 */
export type RemoteAttachedFile = Extract<AttachedFile, { kind: 'remote' }>;

/** Bumped whenever `StoredDraft`'s shape changes. Old drafts then read as misses. */
export const DRAFT_ENVELOPE_VERSION = 1;

/**
 * Per-draft ceiling, bytes of serialized JSON. The whole origin shares one
 * ~5-10MB localStorage bucket (see `lib/storage/managed-storage.ts`), so one
 * pasted logfile must not be able to consume it. Enforced here rather than in
 * the store so it is testable without storage.
 */
export const MAX_DRAFT_BYTES = 131072;

export interface StoredDraft {
  /** Envelope version — see DRAFT_ENVELOPE_VERSION. */
  v: number;
  /**
   * Supabase user id of the author.
   *
   * Sign-out is called from three places and two of them
   * (`features/layout/user-menu-shared.tsx`, `features/workspace/command-palette.tsx`)
   * call `supabase.auth.signOut()` directly rather than through
   * `features/providers/auth-provider.tsx`. A "clear drafts on sign-out" hook
   * wired to one would silently miss the others, and would miss token expiry
   * entirely. Checking the author on every READ covers all of them with no
   * sign-out wiring at all. This matters because project access is shared: two
   * teammates on one machine can both legitimately open the same project route.
   */
  u: string;
  /**
   * The ProseMirror document, mention atoms intact. NOT a string:
   * `ComposerEditorHandle.setContent(text)` only ever builds plain paragraphs,
   * so a text round trip flattens every chip to literal "@label" and the next
   * send emits no `<file_ref>`/`<agent_ref>`/`<session_ref>` block.
   */
  doc: JSONContent;
  files: RemoteAttachedFile[];
}

/** The `<kind>:<id>` half of the storage key. The family prefix is the store's. */
export function draftScopeKey(scope: DraftScope): string {
  return scope.kind === 'project' ? `project:${scope.projectId}` : `session:${scope.sessionId}`;
}

const isRemote = (file: AttachedFile): file is RemoteAttachedFile => file.kind === 'remote';

/**
 * Build the envelope to store, or `null` for "there is nothing worth keeping —
 * remove the key". `null` has exactly one meaning throughout the feature, which
 * is what lets an emptied editor delete its own draft through the same path
 * that writes one.
 *
 * `documentIsEmpty` is supplied by the caller, never re-derived from `doc`.
 * The canonical definition of empty for a TipTap document is `editor.isEmpty`,
 * and the caller holds a live `ComposerEditorHandle.isEmpty()`. Re-implementing
 * it here would risk drifting from it — the same reasoning
 * `composer-draft-recovery.ts` records for `mergeFailedSubmissionDocument`.
 */
export function serializeDraft(input: {
  doc: JSONContent;
  documentIsEmpty: boolean;
  files: readonly AttachedFile[];
  userId: string;
}): StoredDraft | null {
  const files = input.files.filter(isRemote);
  if (input.documentIsEmpty && files.length === 0) return null;
  if (!input.userId) return null;
  const draft: StoredDraft = {
    v: DRAFT_ENVELOPE_VERSION,
    u: input.userId,
    doc: input.doc,
    files,
  };
  if (JSON.stringify(draft).length > MAX_DRAFT_BYTES) return null;
  return draft;
}

/**
 * Validate a value read back out of storage. Returns `null` — never throws and
 * never partially trusts — on a version mismatch, a malformed payload, or a
 * draft written by a different user.
 */
export function deserializeDraft(raw: unknown, currentUserId: string): StoredDraft | null {
  if (!currentUserId) return null;
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Partial<StoredDraft>;
  if (candidate.v !== DRAFT_ENVELOPE_VERSION) return null;
  if (typeof candidate.u !== 'string' || candidate.u !== currentUserId) return null;
  if (!candidate.doc || typeof candidate.doc !== 'object') return null;
  if (!Array.isArray(candidate.files)) return null;
  return {
    v: candidate.v,
    u: candidate.u,
    doc: candidate.doc,
    files: candidate.files.filter(isRemote),
  };
}

/**
 * The restore gate. Precedence, highest first: failed-send recovery, then an
 * explicit prefill (`?q=` deep link, onboarding hand-off, command palette,
 * carried draft from the boot shell), then the stored draft. Both higher
 * sources arrive as a `prefill`, so `hasPrefill` is the whole check.
 *
 * `alreadyRestored` makes this once-per-scope: without it, a remount (tab
 * switch, panel toggle) would ghost a draft back into an editor the user had
 * deliberately emptied.
 */
export function shouldRestoreDraft(input: {
  editorReady: boolean;
  editorIsEmpty: boolean;
  hasPrefill: boolean;
  alreadyRestored: boolean;
}): boolean {
  if (!input.editorReady) return false;
  if (input.alreadyRestored) return false;
  if (input.hasPrefill) return false;
  if (!input.editorIsEmpty) return false;
  return true;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /Users/jay/root/kortix/suna-composer-drafts/apps/web && bun test src/features/session/composer/draft/composer-draft.test.ts
```

Expected: PASS, 17 tests.

- [ ] **Step 5: Lint and typecheck the new files**

```bash
cd /Users/jay/root/kortix/suna-composer-drafts/apps/web && npx eslint src/features/session/composer/draft/
```

Expected: no errors.

- [ ] **Step 6: Commit (ask the operator first — see Global Constraints)**

```bash
cd /Users/jay/root/kortix/suna-composer-drafts && git add apps/web/src/features/session/composer/draft/composer-draft.ts apps/web/src/features/session/composer/draft/composer-draft.test.ts && git commit -m "feat(composer): pure draft envelope logic

Scope keying, serialize/deserialize with a user-id stamp and a 128KB
cap, and the restore precedence gate. No storage and no React yet."
```

---

## Task 2: Storage seam over ScopedCache

**Files:**
- Create: `apps/web/src/features/session/composer/draft/composer-draft-store.ts`
- Test: `apps/web/src/features/session/composer/draft/composer-draft-store.test.ts`

**Interfaces:**
- Consumes: `DraftScope`, `StoredDraft`, `deserializeDraft`, `draftScopeKey` from Task 1; `ScopedCache` from `@/lib/storage/managed-storage`.
- Produces:
  - `const DRAFT_CACHE_FAMILY = 'kortix_draft'`
  - `const DRAFT_CACHE_MAX_SCOPES = 50`
  - `function readDraft(scope: DraftScope, currentUserId: string): StoredDraft | null`
  - `function writeDraft(scope: DraftScope, draft: StoredDraft | null): void`
  - `function clearDraft(scope: DraftScope): void`

**Why `ScopedCache` and not `localStorage`:** `lib/storage/managed-storage.ts:1-28` records the incident this class exists to prevent — per-sandbox cache keys grew unbounded, the shared bucket saturated, and the next `setItem` from any unrelated store threw `QuotaExceededError` synchronously and crashed the render. `ScopedCache` stamps every entry with a write timestamp, prunes its family to the N most-recent scopes on every write, and calls `registerDisposableFamily` so a full bucket evicts drafts instead of throwing. Drafts are exactly the unbounded-key-family shape that caused that outage.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/features/session/composer/draft/composer-draft-store.test.ts`:

```ts
import type { JSONContent } from '@tiptap/core';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { DRAFT_ENVELOPE_VERSION, type StoredDraft } from './composer-draft';
import {
  DRAFT_CACHE_MAX_SCOPES,
  clearDraft,
  readDraft,
  writeDraft,
} from './composer-draft-store';

/**
 * `bun test` registers no DOM in this repo (`apps/web/test-setup.ts` adds
 * none), so `managed-storage.ts`'s `getLocalStorage()` returns null and every
 * write is a silent no-op. This installs a real, minimal `Storage` so the
 * ScopedCache path — including `prune()`, which walks `storage.key(i)` — runs
 * for real rather than being skipped.
 *
 * Both globals are set: `getLocalStorage()` reads `window.localStorage`, while
 * `safeSetItem`/`safeGetItem` call the bare `localStorage` binding.
 */
class FakeStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

const globalRef = globalThis as unknown as { window?: unknown; localStorage?: Storage };
let previousWindow: unknown;
let previousStorage: Storage | undefined;

beforeEach(() => {
  previousWindow = globalRef.window;
  previousStorage = globalRef.localStorage;
  const storage = new FakeStorage();
  globalRef.localStorage = storage;
  globalRef.window = { localStorage: storage };
});

afterEach(() => {
  // Restored, not just deleted: this file must not leak a fake `window` into
  // sibling test files sharing the process.
  globalRef.window = previousWindow;
  globalRef.localStorage = previousStorage;
});

const USER = 'user-aaa';
const DOC: JSONContent = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }],
};

const draft = (text: string): StoredDraft => ({
  v: DRAFT_ENVELOPE_VERSION,
  u: USER,
  doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
  files: [],
});

describe('composer draft store', () => {
  test('a written draft reads back for the same scope', () => {
    const scope = { kind: 'session', sessionId: 's1' } as const;
    writeDraft(scope, { v: DRAFT_ENVELOPE_VERSION, u: USER, doc: DOC, files: [] });
    expect(readDraft(scope, USER)?.doc).toEqual(DOC);
  });

  test('project and session scopes do not collide on the same id', () => {
    writeDraft({ kind: 'project', projectId: 'x' }, draft('project text'));
    writeDraft({ kind: 'session', sessionId: 'x' }, draft('session text'));
    expect(readDraft({ kind: 'project', projectId: 'x' }, USER)?.doc).toEqual(
      draft('project text').doc,
    );
    expect(readDraft({ kind: 'session', sessionId: 'x' }, USER)?.doc).toEqual(
      draft('session text').doc,
    );
  });

  test('writing null removes the key', () => {
    const scope = { kind: 'session', sessionId: 's2' } as const;
    writeDraft(scope, draft('temporary'));
    writeDraft(scope, null);
    expect(readDraft(scope, USER)).toBeNull();
  });

  test('clearDraft removes the key', () => {
    const scope = { kind: 'session', sessionId: 's3' } as const;
    writeDraft(scope, draft('temporary'));
    clearDraft(scope);
    expect(readDraft(scope, USER)).toBeNull();
  });

  test('a missing scope reads as null, not as a throw', () => {
    expect(readDraft({ kind: 'session', sessionId: 'never-written' }, USER)).toBeNull();
  });

  test('another user cannot read this user draft', () => {
    const scope = { kind: 'session', sessionId: 's4' } as const;
    writeDraft(scope, draft('private'));
    expect(readDraft(scope, 'user-bbb')).toBeNull();
  });

  test('the family is pruned to the scope cap, newest kept', () => {
    for (let i = 0; i < DRAFT_CACHE_MAX_SCOPES + 10; i++) {
      writeDraft({ kind: 'session', sessionId: `s-${i}` }, draft(`draft ${i}`));
    }
    const storage = globalRef.localStorage as Storage;
    const familyKeys = Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter(
      (k): k is string => !!k && k.startsWith('kortix_draft:'),
    );
    expect(familyKeys.length).toBeLessThanOrEqual(DRAFT_CACHE_MAX_SCOPES);
    // The most recent write always survives the prune.
    expect(
      readDraft({ kind: 'session', sessionId: `s-${DRAFT_CACHE_MAX_SCOPES + 9}` }, USER),
    ).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/jay/root/kortix/suna-composer-drafts/apps/web && bun test src/features/session/composer/draft/composer-draft-store.test.ts
```

Expected: FAIL — `Cannot find module './composer-draft-store'`.

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/features/session/composer/draft/composer-draft-store.ts`:

```ts
'use client';

import { ScopedCache } from '@/lib/storage/managed-storage';

import { type DraftScope, type StoredDraft, deserializeDraft, draftScopeKey } from './composer-draft';

/** Storage key prefix. Full keys are `kortix_draft:project:<id>` / `kortix_draft:session:<id>`. */
export const DRAFT_CACHE_FAMILY = 'kortix_draft';

/**
 * How many distinct drafts survive. `ScopedCache` prunes to the N
 * most-recently-WRITTEN scopes on every write, so the drafts a person is
 * actually working in are the ones that stay. Stale keys for deleted sessions
 * age out through the same mechanism, which is why the feature needs no
 * deletion hook of its own.
 */
export const DRAFT_CACHE_MAX_SCOPES = 50;

/**
 * The ONE storage object for the feature. Constructing it registers
 * `kortix_draft` as a disposable family, so a saturated bucket evicts drafts
 * rather than letting an unrelated store's `setItem` throw — the failure mode
 * `lib/storage/managed-storage.ts:1-28` documents.
 */
const draftCache = new ScopedCache<StoredDraft>(DRAFT_CACHE_FAMILY, DRAFT_CACHE_MAX_SCOPES);

/** Reads and validates. Returns null for a miss, a stale envelope, or another user's draft. */
export function readDraft(scope: DraftScope, currentUserId: string): StoredDraft | null {
  return deserializeDraft(draftCache.get(draftScopeKey(scope)), currentUserId);
}

/**
 * Writes, or REMOVES on `null`. `null` carries `serializeDraft`'s single
 * meaning — "there is nothing worth keeping" — so emptying the editor deletes
 * the key through the same call that writes one.
 */
export function writeDraft(scope: DraftScope, draft: StoredDraft | null): void {
  const key = draftScopeKey(scope);
  if (draft === null) {
    draftCache.remove(key);
    return;
  }
  draftCache.set(key, draft);
}

/** Explicit removal, for the successful-send path. */
export function clearDraft(scope: DraftScope): void {
  draftCache.remove(draftScopeKey(scope));
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /Users/jay/root/kortix/suna-composer-drafts/apps/web && bun test src/features/session/composer/draft/
```

Expected: PASS, both files, 24 tests total.

- [ ] **Step 5: Lint**

```bash
cd /Users/jay/root/kortix/suna-composer-drafts/apps/web && npx eslint src/features/session/composer/draft/
```

Expected: no errors.

- [ ] **Step 6: Commit (ask first)**

```bash
cd /Users/jay/root/kortix/suna-composer-drafts && git add apps/web/src/features/session/composer/draft/composer-draft-store.ts apps/web/src/features/session/composer/draft/composer-draft-store.test.ts && git commit -m "feat(composer): draft storage seam over ScopedCache

Reuses the quota-resilient cache so drafts are a registered disposable
family and the 50-scope cap bounds growth. Tests install a real fake
Storage so prune() actually runs."
```

---

## Task 3: `onDocChange` on ComposerEditor

**Files:**
- Modify: `apps/web/src/features/session/composer/editor/composer-editor.tsx`
- Test: `apps/web/src/features/session/composer/editor/composer-editor.test.ts` (append)

**Interfaces:**
- Consumes: the existing exported `trackEmptyBoundary`.
- Produces:
  - `ComposerEditorProps.onDocChange?: (doc: JSONContent) => void`
  - `function createUpdateHandler(onEmptyChange: (isEmpty: boolean) => void, onDocChange: (doc: JSONContent) => void): (props: { editor: Pick<Editor, 'isEmpty' | 'getJSON'> }) => void`

`trackEmptyBoundary` is left exactly as it is and its existing tests keep passing. `createUpdateHandler` composes it — the boundary behaviour must not change, only gain a sibling.

- [ ] **Step 1: Write the failing test**

Append to `apps/web/src/features/session/composer/editor/composer-editor.test.ts`. Add `createUpdateHandler` to the existing import from `./composer-editor`, then append:

```ts
describe('createUpdateHandler — per-change doc snapshots alongside the empty boundary', () => {
  test('fires onDocChange for every keystroke while onEmptyChange fires once', () => {
    const boundaries: boolean[] = [];
    const docs: JSONContent[] = [];
    const editor = new Editor({
      extensions: [...baseExtensions(() => 'Type a message'), MentionNode],
      onUpdate: createUpdateHandler(
        (isEmpty) => boundaries.push(isEmpty),
        (doc) => docs.push(doc),
      ),
      content: { type: 'doc', content: [{ type: 'paragraph' }] },
    });

    for (const char of 'hello') {
      editor.commands.insertContent({ type: 'text', text: char });
    }

    // The whole point of the composition: the draft saver sees every change,
    // the toolbar still sees exactly one boundary crossing.
    expect(docs).toHaveLength(5);
    expect(boundaries).toEqual([false]);
    expect(editor.getText()).toBe('hello');
  });

  test('the snapshot handed to onDocChange is the live document, mentions included', () => {
    const docs: JSONContent[] = [];
    const editor = new Editor({
      extensions: [...baseExtensions(() => 'Type a message'), MentionNode],
      onUpdate: createUpdateHandler(
        () => {},
        (doc) => docs.push(doc),
      ),
      content: { type: 'doc', content: [{ type: 'paragraph' }] },
    });

    editor.commands.insertContent({
      type: 'mention',
      attrs: { kind: 'file', label: 'README.md', value: 'README.md' },
    });

    const last = docs.at(-1);
    expect(JSON.stringify(last)).toContain('"type":"mention"');
  });

  test('deleting the last character reports the empty boundary and an empty doc', () => {
    const boundaries: boolean[] = [];
    const docs: JSONContent[] = [];
    const editor = new Editor({
      extensions: [...baseExtensions(() => 'Type a message'), MentionNode],
      onUpdate: createUpdateHandler(
        (isEmpty) => boundaries.push(isEmpty),
        (doc) => docs.push(doc),
      ),
      content: { type: 'doc', content: [{ type: 'paragraph' }] },
    });

    editor.commands.insertContent({ type: 'text', text: 'a' });
    editor.commands.clearContent();

    expect(boundaries).toEqual([false, true]);
    expect(editor.isEmpty).toBe(true);
    expect(docs).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/jay/root/kortix/suna-composer-drafts/apps/web && bun test src/features/session/composer/editor/composer-editor.test.ts
```

Expected: FAIL — `createUpdateHandler` is not exported.

- [ ] **Step 3: Add the export**

In `apps/web/src/features/session/composer/editor/composer-editor.tsx`, directly below the existing `trackEmptyBoundary` function, add:

```ts
/**
 * The editor's single `onUpdate`, composing the boundary tracker with a
 * per-change document snapshot.
 *
 * These two have deliberately different cadences and must not be merged.
 * `onEmptyChange` fires only on the empty<->non-empty boundary — that is what
 * stops the toolbar re-rendering per keystroke, and it is asserted directly in
 * this file's tests. `onDocChange` has to see EVERY change, because a draft
 * saver that only heard about boundaries would persist the first character and
 * nothing after it.
 *
 * The cost of that per-keystroke callback is one `editor.getJSON()` plus one
 * `setTimeout` reset in the host's debounce (`draft/use-composer-draft.ts`).
 * The host sets no React state, so nothing here re-renders.
 *
 * Exported, like its two neighbours, so the exact production wiring can be
 * driven against a real headless `@tiptap/core` Editor in
 * composer-editor.test.ts rather than a stand-in.
 */
export function createUpdateHandler(
  onEmptyChange: (isEmpty: boolean) => void,
  onDocChange: (doc: JSONContent) => void,
) {
  const trackEmpty = trackEmptyBoundary(onEmptyChange);
  return ({ editor }: { editor: Pick<Editor, 'isEmpty' | 'getJSON'> }) => {
    trackEmpty({ editor });
    onDocChange(editor.getJSON() as JSONContent);
  };
}
```

- [ ] **Step 4: Wire the prop through the component**

Add to `ComposerEditorProps`, directly after `onEmptyChange`:

```ts
  /**
   * Fires on EVERY document change, unthrottled, with the live ProseMirror
   * JSON. The host debounces and persists it — see
   * `draft/use-composer-draft.ts`. Deliberately separate from
   * `onEmptyChange`, which fires only on the empty<->non-empty boundary.
   */
  onDocChange?: (doc: JSONContent) => void;
```

Add `onDocChange` to the destructured props list (next to `onEmptyChange`).

Add the ref, beside the existing `onEmptyChangeRef` block (`composer-editor.tsx:313-316`):

```ts
    const onDocChangeRef = useRef(onDocChange);
    useEffect(() => {
      onDocChangeRef.current = onDocChange;
    }, [onDocChange]);
```

Replace the existing `handleUpdate` memo (`composer-editor.tsx:456-459`) with:

```ts
    const handleUpdate = useMemo(
      () =>
        createUpdateHandler(
          (isEmpty) => onEmptyChangeRef.current(isEmpty),
          (doc) => onDocChangeRef.current?.(doc),
        ),
      [],
    );
```

The empty dependency array and the ref indirection are load-bearing: `useEditor` re-syncs its callback options when any other option changes, and a fresh handler identity per render would reset `trackEmptyBoundary`'s internal `wasEmpty` and re-fire the boundary. This is the same discipline the file already applies to `onEmptyChange`, `onSubmit`, `disabled` and `placeholder` (`composer-editor.tsx:308-316`).

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd /Users/jay/root/kortix/suna-composer-drafts/apps/web && bun test src/features/session/composer/editor/composer-editor.test.ts
```

Expected: PASS — the three new tests plus every pre-existing `trackEmptyBoundary` test unchanged.

- [ ] **Step 6: Lint**

```bash
cd /Users/jay/root/kortix/suna-composer-drafts/apps/web && npx eslint src/features/session/composer/editor/composer-editor.tsx src/features/session/composer/editor/composer-editor.test.ts
```

Expected: no errors.

- [ ] **Step 7: Commit (ask first)**

```bash
cd /Users/jay/root/kortix/suna-composer-drafts && git add apps/web/src/features/session/composer/editor/composer-editor.tsx apps/web/src/features/session/composer/editor/composer-editor.test.ts && git commit -m "feat(composer): onDocChange on ComposerEditor

Composes a per-change document snapshot with the existing empty-boundary
tracker. The boundary cadence is unchanged and still asserted."
```

---

## Task 4: The draft hook, and wiring it into Composer

**Files:**
- Create: `apps/web/src/features/session/composer/draft/use-composer-draft.ts`
- Modify: `apps/web/src/features/session/composer/composer.tsx`

**Interfaces:**
- Consumes: `DraftScope`, `StoredDraft`, `serializeDraft` (Task 1); `readDraft`, `writeDraft`, `clearDraft` (Task 2); `ComposerEditorHandle` from `../editor/composer-editor`; `useAuth` from `@/features/providers/auth-provider`.
- Produces:
  - `function useComposerDraft(input: UseComposerDraftInput): { handleDocChange: (doc: JSONContent) => void; clearSavedDraft: () => void }`
  - `interface UseComposerDraftInput { scope: DraftScope | null | undefined; editorRef: RefObject<ComposerEditorHandle | null>; editorReady: boolean; attachedFiles: readonly AttachedFile[]; hasPrefill: boolean; onRestore: (draft: StoredDraft) => void }`
  - `Composer` gains prop `draftScope?: DraftScope | null`

`useAuth` is safe to call here: `AuthProvider` is mounted in the ROOT `app/layout.tsx:358`, so it wraps every composer mount including the marketing demo. When `user` is null (signed out) the hook persists nothing.

- [ ] **Step 1: Create the hook**

Create `apps/web/src/features/session/composer/draft/use-composer-draft.ts`:

```ts
'use client';

import type { JSONContent } from '@tiptap/core';
import { type RefObject, useCallback, useEffect, useRef } from 'react';

import { useAuth } from '@/features/providers/auth-provider';

import type { ComposerEditorHandle } from '../editor/composer-editor';
import type { AttachedFile } from '../types';
import { type DraftScope, type StoredDraft, serializeDraft, shouldRestoreDraft } from './composer-draft';
import { clearDraft, readDraft, writeDraft } from './composer-draft-store';

/**
 * How long after the last keystroke the draft is written. Long enough that a
 * fast typist produces one write per pause rather than one per character,
 * short enough that a crash loses at most this much typing.
 */
const SAVE_DEBOUNCE_MS = 400;

export interface UseComposerDraftInput {
  /** Omitted or null → the composer persists nothing (marketing demo, tests). */
  scope: DraftScope | null | undefined;
  editorRef: RefObject<ComposerEditorHandle | null>;
  /** The editor element exists, so the handle's methods are safe to call. */
  editorReady: boolean;
  attachedFiles: readonly AttachedFile[];
  /** An explicit prefill outranks a stored draft — see `shouldRestoreDraft`. */
  hasPrefill: boolean;
  /** Called once, with the validated draft, when it is this draft's turn. */
  onRestore: (draft: StoredDraft) => void;
}

/**
 * Persist and restore the unsent composer draft.
 *
 * The save path never touches React state. `handleDocChange` is called from
 * `ComposerEditor.onDocChange` on every keystroke; all it does is stash the
 * document in a ref and reset a timer. That is deliberate — the composer is
 * render-silent while typing (`editor/composer-editor.tsx:123`) and lifting the
 * document into state would defeat it.
 */
export function useComposerDraft({
  scope,
  editorRef,
  editorReady,
  attachedFiles,
  hasPrefill,
  onRestore,
}: UseComposerDraftInput): {
  handleDocChange: (doc: JSONContent) => void;
  clearSavedDraft: () => void;
} {
  const { user } = useAuth();
  const userId = user?.id ?? '';
  const enabled = !!scope && !!userId;

  // Everything the debounced writer reads, held in refs so the timer callback
  // is created once and always sees current values.
  const scopeRef = useRef(scope);
  const userIdRef = useRef(userId);
  const filesRef = useRef(attachedFiles);
  const pendingDocRef = useRef<JSONContent | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restoredKeyRef = useRef<string | null>(null);

  scopeRef.current = scope;
  userIdRef.current = userId;
  filesRef.current = attachedFiles;

  const flush = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const activeScope = scopeRef.current;
    const doc = pendingDocRef.current;
    if (!activeScope || !userIdRef.current || !doc) return;
    pendingDocRef.current = null;
    // `isEmpty()` is the canonical emptiness definition and is read here, live,
    // rather than derived from the snapshot — see `serializeDraft`'s comment.
    const documentIsEmpty = editorRef.current?.isEmpty() ?? true;
    writeDraft(
      activeScope,
      serializeDraft({
        doc,
        documentIsEmpty,
        files: filesRef.current,
        userId: userIdRef.current,
      }),
    );
  }, [editorRef]);

  const handleDocChange = useCallback(
    (doc: JSONContent) => {
      if (!scopeRef.current || !userIdRef.current) return;
      pendingDocRef.current = doc;
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(flush, SAVE_DEBOUNCE_MS);
    },
    [flush],
  );

  const clearSavedDraft = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingDocRef.current = null;
    const activeScope = scopeRef.current;
    if (activeScope) clearDraft(activeScope);
  }, []);

  // Flush on every way a page can go away without unmounting cleanly.
  // `beforeunload` is deliberately absent: iOS Safari does not fire it
  // reliably, and `pagehide` covers the same transition everywhere.
  useEffect(() => {
    if (!enabled) return;
    const onHide = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    const onPageHide = () => flush();
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onPageHide);
      flush();
    };
  }, [enabled, flush]);

  // Restore, at most once per scope key.
  useEffect(() => {
    if (!scope || !userId) return;
    const key = `${scope.kind}:${scope.kind === 'project' ? scope.projectId : scope.sessionId}`;
    if (
      !shouldRestoreDraft({
        editorReady,
        editorIsEmpty: editorRef.current?.isEmpty() ?? true,
        hasPrefill,
        alreadyRestored: restoredKeyRef.current === key,
      })
    ) {
      return;
    }
    restoredKeyRef.current = key;
    const stored = readDraft(scope, userId);
    if (stored) onRestore(stored);
  }, [scope, userId, editorReady, hasPrefill, editorRef, onRestore]);

  return { handleDocChange, clearSavedDraft };
}
```

- [ ] **Step 2: Add the `draftScope` prop to Composer**

In `apps/web/src/features/session/composer/composer.tsx`, add to the props interface (beside `sessionId` / `projectId`, around line 169):

```ts
  /**
   * Persist the unsent draft under this scope and restore it on the next
   * mount. Omitted → the composer persists nothing, which is what the two
   * marketing-demo composers rely on.
   */
  draftScope?: DraftScope | null;
```

Add `draftScope` to the destructured parameter list beside `sessionId, projectId` (around line 384).

Add the imports:

```ts
import type { DraftScope, StoredDraft } from './draft/composer-draft';
import { useComposerDraft } from './draft/use-composer-draft';
```

- [ ] **Step 3: Call the hook**

Insert after the `attachedFiles` state and the `editorElement` state are declared (after `composer.tsx:444`, i.e. after `setEditorRef`):

```ts
  /**
   * Restore a stored draft into the live editor.
   *
   * `setDocumentWithoutStealingFocus`, not `setDocument`: a session page mount
   * would otherwise yank focus into the composer on every reload. Remote
   * attachments are appended; local ones were never storable and are simply
   * absent.
   */
  const handleDraftRestore = useCallback((draft: StoredDraft) => {
    setDocumentWithoutStealingFocus(editorRef.current, draft.doc);
    if (draft.files.length > 0) {
      setAttachedFiles((current) => (current.length > 0 ? current : [...draft.files]));
    }
  }, []);

  const { handleDocChange, clearSavedDraft } = useComposerDraft({
    scope: draftScope,
    editorRef,
    editorReady: editorElement != null,
    attachedFiles,
    hasPrefill: !!prefill,
    onRestore: handleDraftRestore,
  });
```

`setDocumentWithoutStealingFocus` already exists in this file — do not re-declare it.

- [ ] **Step 4: Pass `onDocChange` to the editor**

Find the `<ComposerEditor ... />` element in the JSX and add, beside its existing `onEmptyChange`:

```tsx
              onDocChange={handleDocChange}
```

- [ ] **Step 5: Clear the draft on a successful send**

In `handleSubmit`, after the message has been dispatched and the reset decision is taken — immediately after the `const reset = resolveComposerResetOnSend(clearOnSend, filesNow);` line (`composer.tsx:1050`) — add:

```ts
      // Explicitly, NOT derived from `reset.clear`: the project-home composer
      // passes `clearOnSend={false}` because its send navigates it away
      // (`composer-reset.ts`), so keying the draft removal off the editor
      // clearing would leave a stale home draft behind forever.
      clearSavedDraft();
```

Also add `clearSavedDraft()` immediately before the `onCommand?.(plan.command, plan.args, draft?.commandSplit);` dispatch (`composer.tsx:1015`), so a dispatched `/` command clears the draft too. Do NOT add it on any refusal path (`guard.kind === 'refuse'`, `blocker`) — those keep the text in the editor on purpose.

Add `clearSavedDraft` to `handleSubmit`'s `useCallback` dependency array.

- [ ] **Step 6: Typecheck and lint**

```bash
cd /Users/jay/root/kortix/suna-composer-drafts/apps/web && npx tsc --noEmit 2>&1 | grep -v "test.each" | head -30
```

Expected: only the ~15 known `@types/bun` errors in the 3 files named in Global Constraints, and nothing else.

```bash
cd /Users/jay/root/kortix/suna-composer-drafts/apps/web && npx eslint src/features/session/composer/
```

Expected: no errors.

- [ ] **Step 7: Run the whole composer test suite**

```bash
cd /Users/jay/root/kortix/suna-composer-drafts/apps/web && bun test src/features/session/
```

Expected: PASS, no regressions against the pre-existing suite.

- [ ] **Step 8: Commit (ask first)**

```bash
cd /Users/jay/root/kortix/suna-composer-drafts && git add apps/web/src/features/session/composer/draft/use-composer-draft.ts apps/web/src/features/session/composer/composer.tsx && git commit -m "feat(composer): persist and restore the unsent draft

Debounced save off onDocChange through refs only, flushed on
visibilitychange/pagehide/unmount. Restore is once per scope and yields
to any explicit prefill. Cleared on a successful send, never on a refusal."
```

---

## Task 5: Thread the scope through all three mount sites

**Files:**
- Modify: `apps/web/src/features/session/composer-chat-input.tsx`
- Modify: `apps/web/src/features/workspace/project-layout/project-home.tsx`
- Modify: `apps/web/src/features/session/instant-session-shell.tsx`
- Modify: `apps/web/src/features/session/session-chat.tsx`

**Interfaces:**
- Consumes: `DraftScope` and the `draftScope` prop from Task 4.
- Produces: nothing new. This task only connects existing surfaces.

- [ ] **Step 1: Thread through `ComposerChatInput`**

In `apps/web/src/features/session/composer-chat-input.tsx`:

Add the import:

```ts
import type { DraftScope } from './composer/draft/composer-draft';
```

Add to the props type, after `sandboxSlot`:

```ts
  /** Persist the unsent draft under this scope — see `composer/draft/`. */
  draftScope?: DraftScope | null;
```

Add `draftScope` to the destructured parameter list, and pass it straight through on the `<SessionChatInput ... />` element:

```tsx
      draftScope={draftScope}
```

- [ ] **Step 2: Project home — one draft per project**

In `apps/web/src/features/workspace/project-layout/project-home.tsx`, add above the `return`:

```ts
  // The home composer has no session yet, so its draft is keyed by the
  // project. Memoized because `ComposerChatInput` passes it into a
  // `React.memo`-wrapped composer.
  const draftScope = useMemo<DraftScope>(
    () => ({ kind: 'project', projectId }),
    [projectId],
  );
```

Add `useMemo` to the existing `react` import and add:

```ts
import type { DraftScope } from '@/features/session/composer/draft/composer-draft';
```

Pass it on the `<ComposerChatInput ... />` at line 245:

```tsx
            draftScope={draftScope}
```

- [ ] **Step 3: Instant session shell — keyed by the new session**

In `apps/web/src/features/session/instant-session-shell.tsx`, add:

```ts
import type { DraftScope } from '@/features/session/composer/draft/composer-draft';
```

and, above `composerEl`:

```ts
  const draftScope = useMemo<DraftScope>(
    () => ({ kind: 'session', sessionId }),
    [sessionId],
  );
```

Pass it on the `<ComposerChatInput ... />` at line 231:

```tsx
      draftScope={draftScope}
```

- [ ] **Step 4: Live session composer**

In `apps/web/src/features/session/session-chat.tsx`, add:

```ts
import type { DraftScope } from '@/features/session/composer/draft/composer-draft';
```

and, alongside the other memoized composer props in the "Stable props for `<SessionChatInput>`" block (`session-chat.tsx:4182`):

```ts
  // Memoized like every other prop in this block: SessionChatInput is
  // React.memo-wrapped, and a fresh object literal per render would defeat the
  // memo on every streaming token.
  const composerDraftScope = useMemo<DraftScope>(
    () => ({ kind: 'session', sessionId }),
    [sessionId],
  );
```

Pass it on the `<SessionChatInput ... />` at line 4867:

```tsx
              draftScope={composerDraftScope}
```

If the local variable holding the session id in that scope is not named `sessionId`, use whichever identifier is in scope — confirm with `grep -n "sessionId" apps/web/src/features/session/session-chat.tsx | head` before editing.

- [ ] **Step 5: Confirm the marketing demo is untouched**

```bash
cd /Users/jay/root/kortix/suna-composer-drafts/apps/web && grep -n "draftScope" src/components/home/interactive-demo-section.tsx src/components/home/interactive-demo/pages/chat-page.tsx
```

Expected: no matches. `draftScope` is optional, so both demo composers persist nothing.

- [ ] **Step 6: Full gate run**

```bash
cd /Users/jay/root/kortix/suna-composer-drafts/apps/web && bun test src/
```

Expected: PASS with no new failures.

```bash
cd /Users/jay/root/kortix/suna-composer-drafts/apps/web && npx tsc --noEmit 2>&1 | tail -30
```

Expected: only the ~15 known `@types/bun` `test.each` errors in the 3 files named in Global Constraints.

```bash
cd /Users/jay/root/kortix/suna-composer-drafts/apps/web && npx eslint src/features/session/composer/ src/features/session/composer-chat-input.tsx src/features/session/instant-session-shell.tsx src/features/session/session-chat.tsx src/features/workspace/project-layout/project-home.tsx
```

Expected: no errors.

- [ ] **Step 7: Commit (ask first)**

```bash
cd /Users/jay/root/kortix/suna-composer-drafts && git add apps/web/src/features/session/composer-chat-input.tsx apps/web/src/features/session/instant-session-shell.tsx apps/web/src/features/session/session-chat.tsx apps/web/src/features/workspace/project-layout/project-home.tsx && git commit -m "feat(composer): key drafts per project and per session

Project home keys by projectId, both session composers by sessionId.
The marketing demo composers pass no scope and persist nothing."
```

---

## Self-Review Notes

**Spec coverage.** Every numbered spec section maps to a task: §4.1 pure module → Task 1; §4.1 store → Task 2; §4.2 save path → Tasks 3 and 4; §4.3 restore and precedence → Tasks 1 (gate) and 4 (effect); §4.4 multi-user → Task 1 (`u` stamp, `deserializeDraft`) with tests; §4.5 clear path → Task 4 step 5; §4.6 out-of-scope items are implemented as absences and need no task; §5 file list matches the File Structure table; §6 test list is covered by Tasks 1-3.

**Deviation from the spec, recorded deliberately.** The spec's §4.1 listed an `isDraftDocumentEmpty(doc)` helper. It is not in this plan. Emptiness has exactly one canonical definition in this codebase — `editor.isEmpty` — and `composer-draft-recovery.ts:38-44` already records why a second implementation must not be written. `serializeDraft` therefore takes `documentIsEmpty` from the caller, who holds the live handle. The spec is updated to match.

**Type consistency.** `DraftScope`, `StoredDraft`, `RemoteAttachedFile`, `draftScopeKey`, `serializeDraft`, `deserializeDraft`, `shouldRestoreDraft`, `readDraft`, `writeDraft`, `clearDraft`, `createUpdateHandler`, `onDocChange`, `useComposerDraft`, `handleDocChange`, `clearSavedDraft`, `draftScope` are each spelled identically at every definition and use site above.
