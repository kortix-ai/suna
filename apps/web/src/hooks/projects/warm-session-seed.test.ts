import { describe, expect, mock, test } from 'bun:test';

import type { ProjectSession } from '@kortix/sdk';
import { reconcileSessionsAfterCreate, seedAdoptedWarmSession } from './warm-session-seed';

const AT = '2026-08-17T10:00:00.000Z';

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
    const result = seedAdoptedWarmSession(undefined, makeSession({ session_id: 'w1' }), AT);
    expect(result).toHaveLength(1);
    expect(result[0].session_id).toBe('w1');
  });

  // The seeded copy is the row AS THE SERVER WILL REPORT IT after adoption:
  // `/start` drops `metadata.warm` and stamps `last_activity_at` in the same
  // statement (apps/api/src/projects/routes/warm-sessions.ts). Seeding the raw
  // create-time row instead left it carrying `warm: true` and no activity, so
  // the sidebar sorted it at its create time — the start of the user's home
  // dwell — burying the session the user just started.
  test('the seeded copy drops metadata.warm and stamps last_activity_at', () => {
    const result = seedAdoptedWarmSession(
      undefined,
      makeSession({ session_id: 'w1', metadata: { warm: true, source: 'ui' } }),
      AT,
    );

    const metadata = result[0].metadata as Record<string, unknown>;
    expect(metadata.warm).toBeUndefined();
    expect(metadata.last_activity_at).toBe(AT);
    expect(metadata.source).toBe('ui');
  });

  test('a null metadata row seeds with just the stamp', () => {
    const result = seedAdoptedWarmSession(
      undefined,
      makeSession({ session_id: 'w1', metadata: null as unknown as Record<string, unknown> }),
      AT,
    );
    expect((result[0].metadata as Record<string, unknown>).last_activity_at).toBe(AT);
  });

  test('the input session object is not mutated', () => {
    const session = makeSession({ session_id: 'w1', metadata: { warm: true } });

    seedAdoptedWarmSession(undefined, session, AT);

    expect((session.metadata as Record<string, unknown>).warm).toBe(true);
    expect((session.metadata as Record<string, unknown>).last_activity_at).toBeUndefined();
  });

  test('a new session id is placed FIRST — the most recently adopted', () => {
    const existing = [makeSession({ session_id: 'old-1' }), makeSession({ session_id: 'old-2' })];

    const result = seedAdoptedWarmSession(existing, makeSession({ session_id: 'w1' }), AT);

    expect(result.map((s) => s.session_id)).toEqual(['w1', 'old-1', 'old-2']);
  });

  test('every other row is left byte-identical (same object reference)', () => {
    const other = makeSession({ session_id: 'old-1' });
    const existing = [other];

    const result = seedAdoptedWarmSession(existing, makeSession({ session_id: 'w1' }), AT);

    expect(result[1]).toBe(other);
  });

  test('a repeat seed for the SAME id replaces in place — never duplicates', () => {
    const first = makeSession({ session_id: 'w1', metadata: { warm: true } });
    const existing = [makeSession({ session_id: 'old-1' }), first];

    const result = seedAdoptedWarmSession(
      existing,
      makeSession({ session_id: 'w1', metadata: {} }),
      AT,
    );

    expect(result).toHaveLength(2);
    expect(result.filter((s) => s.session_id === 'w1')).toHaveLength(1);
    // Position is preserved on replace — this is a settle, not a re-promote.
    expect(result.map((s) => s.session_id)).toEqual(['old-1', 'w1']);
    expect((result[1].metadata as Record<string, unknown>).last_activity_at).toBe(AT);
  });

  test('the returned array is a new reference — subscribers re-render', () => {
    const existing = [makeSession({ session_id: 'old-1' })];

    const result = seedAdoptedWarmSession(existing, makeSession({ session_id: 'w1' }), AT);

    expect(result).not.toBe(existing);
  });
});

describe('reconcileSessionsAfterCreate', () => {
  test('an ordinary create invalidates immediately — the row is already visible server-side', () => {
    const invalidate = mock(() => {});

    reconcileSessionsAfterCreate({
      adoptedWarm: false,
      started: new Promise(() => {}),
      invalidate,
    });

    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  test('a warm adoption defers the invalidate until /start settles — the refetch must not race the marker drop', async () => {
    const invalidate = mock(() => {});
    let releaseStart = () => {};
    const started = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });

    reconcileSessionsAfterCreate({ adoptedWarm: true, started, invalidate });
    await Promise.resolve();
    expect(invalidate).not.toHaveBeenCalled();

    releaseStart();
    await Promise.resolve();
    await Promise.resolve();
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  test('a rejected start promise still invalidates — server truth must reconcile the optimistic seed away', async () => {
    const invalidate = mock(() => {});
    const started = Promise.reject(new Error('start failed'));

    reconcileSessionsAfterCreate({ adoptedWarm: true, started, invalidate });
    await Promise.resolve();
    await Promise.resolve();

    expect(invalidate).toHaveBeenCalledTimes(1);
  });
});
