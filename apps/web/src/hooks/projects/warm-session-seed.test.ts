import { describe, expect, test } from 'bun:test';

import type { ProjectSession } from '@kortix/sdk';
import { seedAdoptedWarmSession } from './warm-session-seed';

function makeSession(overrides: Partial<ProjectSession> = {}): ProjectSession {
  return {
    session_id: 's1',
    project_id: 'p1',
    status: 'running',
    created_at: '2026-08-15T00:00:00.000Z',
    custom_name: null,
    name: null,
    branch_name: null,
    metadata: { warm: true },
    ...overrides,
  } as unknown as ProjectSession;
}

describe('seedAdoptedWarmSession', () => {
  test('an empty cache becomes a fresh one-row list', () => {
    const result = seedAdoptedWarmSession(undefined, makeSession({ session_id: 'w1' }));
    expect(result).toEqual([makeSession({ session_id: 'w1' })]);
  });

  test('a new session id is placed FIRST — the most recently adopted', () => {
    const existing = [makeSession({ session_id: 'old-1' }), makeSession({ session_id: 'old-2' })];

    const result = seedAdoptedWarmSession(existing, makeSession({ session_id: 'w1' }));

    expect(result.map((s) => s.session_id)).toEqual(['w1', 'old-1', 'old-2']);
  });

  test('every other row is left byte-identical (same object reference)', () => {
    const other = makeSession({ session_id: 'old-1' });
    const existing = [other];

    const result = seedAdoptedWarmSession(existing, makeSession({ session_id: 'w1' }));

    expect(result[1]).toBe(other);
  });

  test('a repeat seed for the SAME id replaces in place — never duplicates', () => {
    const first = makeSession({ session_id: 'w1', metadata: { warm: true } });
    const existing = [makeSession({ session_id: 'old-1' }), first];

    const result = seedAdoptedWarmSession(
      existing,
      makeSession({ session_id: 'w1', metadata: {} }),
    );

    expect(result).toHaveLength(2);
    expect(result.filter((s) => s.session_id === 'w1')).toHaveLength(1);
    // Position is preserved on replace — this is a settle, not a re-promote.
    expect(result.map((s) => s.session_id)).toEqual(['old-1', 'w1']);
    expect(result[1].metadata).toEqual({});
  });

  test('the returned array is a new reference — subscribers re-render', () => {
    const existing = [makeSession({ session_id: 'old-1' })];

    const result = seedAdoptedWarmSession(existing, makeSession({ session_id: 'w1' }));

    expect(result).not.toBe(existing);
  });
});
