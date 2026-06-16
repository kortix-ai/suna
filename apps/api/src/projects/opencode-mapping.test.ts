import { describe, expect, test } from 'bun:test';

import {
  pickCanonicalRoot,
  resolveRootSessionId,
  type OpencodeSessionLite,
} from './opencode-session-resolver';

function sess(
  id: string,
  opts: { parentID?: string; created?: number; updated?: number } = {},
): OpencodeSessionLite {
  const created = opts.created ?? 0;
  return { id, parentID: opts.parentID, time: { created, updated: opts.updated ?? created } };
}

describe('pickCanonicalRoot (server)', () => {
  test('null for empty / only sub-sessions', () => {
    expect(pickCanonicalRoot([])).toBeNull();
    expect(pickCanonicalRoot([sess('s', { parentID: 'x' })])).toBeNull();
  });
  test('most-recently-active root, ignoring sub-sessions', () => {
    const list = [
      sess('stale', { created: 100, updated: 100 }),
      sess('sub', { parentID: 'live', created: 1, updated: 999 }),
      sess('live', { created: 300, updated: 500 }),
    ];
    expect(pickCanonicalRoot(list)?.id).toBe('live');
  });
  test('the orphaned-restart case: newer live root wins over older frozen root', () => {
    // Mirrors the 2026-06-15 incident: an old bootstrap root frozen mid-turn
    // (updated long ago) and the fresh post-restart root the agent resumed into.
    const orphan = sess('quiet-harbor', { created: 100, updated: 110 });
    const live = sess('shiny-circuit', { created: 200, updated: 900 });
    expect(pickCanonicalRoot([orphan, live])?.id).toBe('shiny-circuit');
    expect(pickCanonicalRoot([live, orphan])?.id).toBe('shiny-circuit');
  });
  test('tie on activity → newest created wins', () => {
    const a = sess('a', { created: 50, updated: 500 });
    const b = sess('b', { created: 80, updated: 500 });
    expect(pickCanonicalRoot([a, b])?.id).toBe('b');
  });
  test('full tie → id tie-break → order-independent / deterministic', () => {
    const a = [sess('b', { created: 100, updated: 100 }), sess('a', { created: 100, updated: 100 })];
    expect(pickCanonicalRoot(a)?.id).toBe('a');
    expect(pickCanonicalRoot([...a].reverse())?.id).toBe('a');
  });
});

describe('resolveRootSessionId (server)', () => {
  test('honors the pin while present even when another root is more active', () => {
    const sessions = [sess('other', { created: 1, updated: 999 }), sess('pinned', { created: 9, updated: 9 })];
    expect(resolveRootSessionId({ pinnedRootId: 'pinned', sessions })).toBe('pinned');
  });
  test('heals a stale pin to the canonical (most-active) root', () => {
    const sessions = [sess('liveRoot', { created: 9, updated: 900 }), sess('staleRoot', { created: 1, updated: 5 })];
    expect(resolveRootSessionId({ pinnedRootId: 'ghost', sessions })).toBe('liveRoot');
  });
  test('adopts canonical (most-active) when no pin yet', () => {
    expect(
      resolveRootSessionId({
        pinnedRootId: null,
        sessions: [sess('r1', { created: 5, updated: 5 }), sess('r2', { created: 2, updated: 50 })],
      }),
    ).toBe('r2');
  });
  test('empty DB → just-created id, else null', () => {
    expect(resolveRootSessionId({ pinnedRootId: null, sessions: [], justCreatedId: 'fresh' })).toBe('fresh');
    expect(resolveRootSessionId({ pinnedRootId: null, sessions: [] })).toBeNull();
  });
  test('two callers, same DB state, different order → same id', () => {
    const a = [sess('x', { created: 100, updated: 100 }), sess('y', { created: 50, updated: 200 })];
    const b = [sess('y', { created: 50, updated: 200 }), sess('x', { created: 100, updated: 100 })];
    expect(resolveRootSessionId({ pinnedRootId: null, sessions: a })).toBe(
      resolveRootSessionId({ pinnedRootId: null, sessions: b }),
    );
  });
});
