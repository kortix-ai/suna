import { describe, expect, test } from 'bun:test';

import {
  resolveRootSessionId,
  type OpencodeSessionLite,
} from '../projects/opencode-session-resolver';

function sess(id: string, opts: { parentID?: string; created?: number } = {}): OpencodeSessionLite {
  return { id, parentID: opts.parentID, time: { created: opts.created ?? 0, updated: opts.created ?? 0 } };
}

describe('resolveRootSessionId canonical root selection', () => {
  test('null for empty / only sub-sessions', () => {
    expect(resolveRootSessionId({ pinnedRootId: null, sessions: [] })).toBeNull();
    expect(resolveRootSessionId({ pinnedRootId: null, sessions: [sess('s', { parentID: 'x' })] })).toBeNull();
  });

  test('oldest root by created, ignoring sub-sessions', () => {
    const list = [
      sess('new', { created: 300 }),
      sess('sub', { parentID: 'old', created: 1 }),
      sess('old', { created: 100 }),
    ];
    expect(resolveRootSessionId({ pinnedRootId: null, sessions: list })).toBe('old');
  });

  test('tie-break by id → order-independent / deterministic', () => {
    const a = [sess('b', { created: 100 }), sess('a', { created: 100 })];
    expect(resolveRootSessionId({ pinnedRootId: null, sessions: a })).toBe('a');
    expect(resolveRootSessionId({ pinnedRootId: null, sessions: [...a].reverse() })).toBe('a');
  });
});

describe('resolveRootSessionId (server)', () => {
  test('honors the pin while present even with an older root', () => {
    const sessions = [sess('old', { created: 1 }), sess('pinned', { created: 9 })];
    expect(resolveRootSessionId({ pinnedRootId: 'pinned', sessions })).toBe('pinned');
  });
  test('heals a stale pin to the canonical (oldest) root', () => {
    const sessions = [sess('newRoot', { created: 9 }), sess('oldRoot', { created: 1 })];
    expect(resolveRootSessionId({ pinnedRootId: 'ghost', sessions })).toBe('oldRoot');
  });
  test('adopts canonical when no pin yet', () => {
    expect(resolveRootSessionId({ pinnedRootId: null, sessions: [sess('r1', { created: 5 }), sess('r2', { created: 2 })] })).toBe('r2');
  });
  test('empty DB → just-created id, else null', () => {
    expect(resolveRootSessionId({ pinnedRootId: null, sessions: [], justCreatedId: 'fresh' })).toBe('fresh');
    expect(resolveRootSessionId({ pinnedRootId: null, sessions: [] })).toBeNull();
  });
  test('two callers, same DB state, different order → same id', () => {
    const a = [sess('x', { created: 100 }), sess('y', { created: 50 })];
    const b = [sess('y', { created: 50 }), sess('x', { created: 100 })];
    expect(resolveRootSessionId({ pinnedRootId: null, sessions: a })).toBe(
      resolveRootSessionId({ pinnedRootId: null, sessions: b }),
    );
  });
});
