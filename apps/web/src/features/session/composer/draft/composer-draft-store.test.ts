import type { JSONContent } from '@tiptap/core';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { DRAFT_ENVELOPE_VERSION, serializeDraft, type StoredDraft } from './composer-draft';
import {
  DRAFT_CACHE_FAMILY,
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
  [name: string]: unknown;
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
  test('the fake storage is actually reached (guards against a silent no-op suite)', () => {
    writeDraft({ kind: 'session', sessionId: 'probe' }, draft('probe'));
    const storage = globalRef.localStorage as Storage;
    expect(storage.getItem(`${DRAFT_CACHE_FAMILY}:session:probe`)).not.toBeNull();
  });

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
      (k): k is string => !!k && k.startsWith(`${DRAFT_CACHE_FAMILY}:`),
    );
    expect(familyKeys.length).toBeLessThanOrEqual(DRAFT_CACHE_MAX_SCOPES);
    // The most recent write always survives the prune.
    expect(
      readDraft({ kind: 'session', sessionId: `s-${DRAFT_CACHE_MAX_SCOPES + 9}` }, USER),
    ).not.toBeNull();
  });
});

/**
 * The save/restore data path, composed exactly as `use-composer-draft.ts`
 * composes it: a document snapshot is serialized, written, then read back and
 * validated on the next mount.
 *
 * This does not cover the hook's TIMING (debounce, visibilitychange/pagehide
 * flush, restore-once) — `apps/web` has no React test harness, so that glue is
 * only exercised in a real browser. What it does cover is every decision the
 * timing eventually delegates to, in order.
 */
describe('draft lifecycle — the sequence the hook performs', () => {
  const scope = { kind: 'session', sessionId: 'lifecycle' } as const;

  /** One `onDocChange` -> debounce -> flush cycle. */
  const save = (doc: JSONContent, isEmpty: boolean, files: never[] = []) =>
    writeDraft(scope, serializeDraft({ doc, documentIsEmpty: isEmpty, files, userId: USER }));

  test('typing then reloading restores the same document', () => {
    save(DOC, false);
    expect(readDraft(scope, USER)?.doc).toEqual(DOC);
  });

  test('emptying the editor deletes the draft rather than storing an empty one', () => {
    save(DOC, false);
    save({ type: 'doc', content: [{ type: 'paragraph' }] }, true);
    expect(readDraft(scope, USER)).toBeNull();
  });

  test('a successful send clears the draft, and typing again starts a new one', () => {
    save(DOC, false);
    clearDraft(scope);
    expect(readDraft(scope, USER)).toBeNull();

    const next: JSONContent = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'follow up' }] }],
    };
    save(next, false);
    expect(readDraft(scope, USER)?.doc).toEqual(next);
  });

  test('the newest snapshot wins — a later keystroke overwrites the earlier draft', () => {
    save(DOC, false);
    const later: JSONContent = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello world' }] }],
    };
    save(later, false);
    expect(readDraft(scope, USER)?.doc).toEqual(later);
  });
});
