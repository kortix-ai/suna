import { describe, expect, test } from 'bun:test';
import { runtimeKeys } from '@kortix/sdk/react';

import {
  canKeepPlaceholderFiles,
  composerFileSearchKey,
  isMenuOpenTransition,
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
