import { describe, expect, test } from 'bun:test';
import { qk, runtimeKeys } from '@kortix/sdk/react';

import {
  canKeepPlaceholderFiles,
  composerFileSearchKey,
  isMenuOpenTransition,
  menuRevalidationKeys,
} from './use-file-search';

/**
 * Task 14. `useFileSearch` itself needs React + a QueryClient + the SDK's
 * sandbox context, none of which exist in this repo's DOM-free `bun test`
 * (see composer-editor.test.ts's header). What IS testable, and what actually
 * carries the correctness, is the placeholder guard: which previous query's
 * results may still be displayed while the next one is in flight.
 *
 * These assert against the REAL key builder rather than hand-written tuples,
 * so the guard's index into that tuple cannot silently drift out of step with
 * the key shape.
 */
describe('composerFileSearchKey', () => {
  test('scopes the cache entry by server and query', () => {
    expect(composerFileSearchKey('https://a', 'auth')).toEqual([
      'web',
      'composer',
      'file-search',
      'https://a',
      'auth',
    ]);
  });

  test('two sandboxes searching the same term are different cache entries', () => {
    expect(composerFileSearchKey('https://a', 'auth')).not.toEqual([
      ...composerFileSearchKey('https://b', 'auth'),
    ]);
  });
});

describe('canKeepPlaceholderFiles', () => {
  test('keeps the previous results while only the query changed (same sandbox)', () => {
    // Typing "au" -> "aut": the menu must not flash empty mid-word.
    expect(canKeepPlaceholderFiles('https://a', composerFileSearchKey('https://a', 'au'))).toBe(
      true,
    );
  });

  test('DROPS the previous results when the sandbox changed', () => {
    // The regression this exists to prevent: a composer stays mounted across
    // a session switch, so the `@` menu would otherwise show the previous
    // sandbox's files with isLoading:false — paths that do not exist in the
    // workspace the user is now in.
    expect(canKeepPlaceholderFiles('https://b', composerFileSearchKey('https://a', 'au'))).toBe(
      false,
    );
  });

  test('drops the previous results when the sandbox changed even for an identical query', () => {
    expect(canKeepPlaceholderFiles('https://b', composerFileSearchKey('https://a', 'auth'))).toBe(
      false,
    );
  });

  test('the unbound sentinel is treated as its own sandbox, not as a wildcard', () => {
    expect(canKeepPlaceholderFiles('unbound', composerFileSearchKey('https://a', 'auth'))).toBe(
      false,
    );
    expect(canKeepPlaceholderFiles('https://a', composerFileSearchKey('unbound', 'auth'))).toBe(
      false,
    );
    expect(canKeepPlaceholderFiles('unbound', composerFileSearchKey('unbound', 'auth'))).toBe(true);
  });

  test('no previous query at all means nothing to keep', () => {
    expect(canKeepPlaceholderFiles('https://a', undefined)).toBe(false);
  });

  test('a foreign key shape never matches by accident', () => {
    expect(canKeepPlaceholderFiles('https://a', ['web', 'files', 'https://a'])).toBe(false);
  });
});

/**
 * Task 9. `useMenuRevalidation` calls `useQueryClient().invalidateQueries`,
 * which needs a real `QueryClientProvider` and cannot run in this repo's
 * DOM-free `bun test` — same constraint `canKeepPlaceholderFiles` above
 * exists to work around for `useFileSearch`. `isMenuOpenTransition` is the
 * decision the hook delegates to, extracted so it stays directly provable.
 */
describe('isMenuOpenTransition', () => {
  test('closed -> open is a transition', () => {
    expect(isMenuOpenTransition(false, true)).toBe(true);
  });

  test('open -> open (still open on a later render) is NOT a transition', () => {
    // The regression this guards: revalidating on every render while the
    // menu stays open would refire on every keystroke typed into an already
    // -open `@`/`/` query, undoing Task 8's removal of a 3x-per-keystroke
    // render storm.
    expect(isMenuOpenTransition(true, true)).toBe(false);
  });

  test('open -> closed is NOT a transition (no revalidation on close)', () => {
    expect(isMenuOpenTransition(true, false)).toBe(false);
  });

  test('closed -> closed is NOT a transition', () => {
    expect(isMenuOpenTransition(false, false)).toBe(false);
  });
});

/**
 * Binds `useMenuRevalidation`'s invalidation keys to the SDK's REAL,
 * PUBLIC `runtimeKeys.agents()`/`.commands()` rather than a hand-typed
 * literal — so a rename of the underlying segments in
 * `packages/sdk/src/react/use-opencode-sessions/keys.ts` fails THIS test
 * instead of silently leaving `useMenuRevalidation`'s `invalidateQueries`
 * calls matching nothing (an `invalidateQueries` miss throws no error and
 * emits no warning; the menus would just stay stale forever with no signal
 * anything is wrong).
 */
describe('the agents/commands cache-key prefixes useMenuRevalidation invalidates', () => {
  test('runtimeKeys.agents() drops to the 2-segment ["opencode", "agents"] prefix', () => {
    expect(runtimeKeys.agents().slice(0, -1)).toEqual(['opencode', 'agents']);
  });

  test('runtimeKeys.commands() drops to the 2-segment ["opencode", "commands"] prefix', () => {
    expect(runtimeKeys.commands().slice(0, -1)).toEqual(['opencode', 'commands']);
  });
});

/**
 * Fix round 1. The previous version of this file only checked the fact
 * above — a fact about the SDK's raw literal, true and IRRELEVANT to
 * whether `useMenuRevalidation` actually reaches the cache the live
 * composer subscribes through. It passed while the bug below was present.
 *
 * `useOpenCodeAgents` (`packages/sdk/src/react/use-opencode-sessions/
 * agents.ts:42-46`) does not have one query-key shape — it branches on
 * `projectId`:
 *
 *   projectId  -> [...qk.project.detail(projectId), 'agents']   ('kx' root)
 *   directory  -> [...opencodeKeys.agents(), 'dir', directory]  ('opencode' root)
 *   neither    -> opencodeKeys.agents()                          ('opencode' root)
 *
 * Every real composer call site passes `projectId`
 * (`instant-session-shell.tsx:88`, `composer-chat-input.tsx:108`,
 * `session-chat.tsx:1641`), which routes through the FIRST branch — a
 * completely different root segment ('kx', not 'opencode') than the bare
 * `runtimeKeys.agents()` prefix `menuRevalidationKeys` used to invalidate
 * alone. `realAgentsQueryKeyFor` below reproduces all three shapes (using
 * the SDK's own public `qk`/`runtimeKeys`, not hand-typed arrays) so these
 * tests assert `menuRevalidationKeys` actually reaches each one, not just
 * that its own literal looks plausible in isolation.
 */
describe('menuRevalidationKeys', () => {
  /** Mirrors TanStack Query's default `invalidateQueries` partial-match
   *  semantics closely enough for this test: `prefix` matches `key` when
   *  every element of `prefix` strictly equals the corresponding element of
   *  `key`, in order. Every segment involved here is a plain string, so this
   *  is sufficient without importing query-core's internal `partialMatchKey`. */
  function prefixMatches(prefix: readonly unknown[], key: readonly unknown[]): boolean {
    return prefix.every((segment, i) => segment === key[i]);
  }

  /** The exact query-key SHAPES `useOpenCodeAgents` can produce, reproduced
   *  via the same public building blocks (`qk`, `runtimeKeys`) the real hook
   *  uses — this is what "the key the composer's real
   *  `useRuntimeAgents({ projectId })` call resolves to" means concretely. */
  function realAgentsQueryKeyFor(args: {
    projectId?: string;
    directory?: string;
  }): readonly unknown[] {
    if (args.projectId) return [...qk.project.detail(args.projectId), 'agents'];
    if (args.directory) return [...runtimeKeys.agents(), 'dir', args.directory];
    return runtimeKeys.agents();
  }

  test('with no projectId, invalidates exactly the bare agents/commands prefixes', () => {
    expect(menuRevalidationKeys()).toEqual([
      ['opencode', 'agents'],
      ['opencode', 'commands'],
    ]);
  });

  test('reaches the no-argument branch of the real useOpenCodeAgents key', () => {
    const realKey = realAgentsQueryKeyFor({});
    expect(menuRevalidationKeys().some((prefix) => prefixMatches(prefix, realKey))).toBe(true);
  });

  test('reaches the directory-scoped branch of the real useOpenCodeAgents key', () => {
    const realKey = realAgentsQueryKeyFor({ directory: '/workspace' });
    expect(menuRevalidationKeys().some((prefix) => prefixMatches(prefix, realKey))).toBe(true);
  });

  // THE regression this whole round exists to fix. Before this test existed,
  // `menuRevalidationKeys` (then hard-coded to just the two bare prefixes)
  // passed every other test in this file while silently failing to reach
  // this branch — the ONE every real composer instance actually uses.
  test('reaches the projectId-scoped branch of the real useOpenCodeAgents key — the CRITICAL fix', () => {
    const realKey = realAgentsQueryKeyFor({ projectId: 'proj-123' });
    const keys = menuRevalidationKeys('proj-123');
    expect(keys.some((prefix) => prefixMatches(prefix, realKey))).toBe(true);
  });

  test('the projectId-scoped key is built through the SDK\'s own qk.project.detail, not a hand-typed literal', () => {
    expect(menuRevalidationKeys('proj-123')).toContainEqual([
      ...qk.project.detail('proj-123'),
      'agents',
    ]);
  });

  test('omitting projectId (undefined or null) does not add the project-scoped key', () => {
    expect(menuRevalidationKeys(undefined)).toHaveLength(2);
    expect(menuRevalidationKeys(null)).toHaveLength(2);
  });

  test('an empty-string projectId is treated as "no project", same as undefined', () => {
    expect(menuRevalidationKeys('')).toHaveLength(2);
  });
});
