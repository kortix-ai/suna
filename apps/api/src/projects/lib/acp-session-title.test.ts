/**
 * `persistHarnessSessionTitle` / `persistFallbackSessionTitle` — the write
 * path for the ACP title-sync pipeline. Mocking idiom mirrors
 * `acp-session-identity.test.ts` (a fake drizzle-shaped db: select().from().where().limit()
 * / update().set().where()).
 */
import { beforeEach, describe, expect, test } from 'bun:test';

import { persistFallbackSessionTitle, persistHarnessSessionTitle } from './acp-session-title';

type UpdateCall = { updates: Record<string, unknown> };

let selectMetadataResult: Record<string, unknown> | null;
let updateCalls: UpdateCall[];
let selectCalls: number;

function fakeDb() {
  return {
    select: (_proj?: unknown) => ({
      from: (_table: unknown) => ({
        where: (_cond: unknown) => ({
          limit: async () => {
            selectCalls += 1;
            return selectMetadataResult ? [{ metadata: selectMetadataResult }] : [];
          },
        }),
      }),
    }),
    update: (_table: unknown) => ({
      set: (updates: Record<string, unknown>) => ({
        where: async (_cond: unknown) => {
          updateCalls.push({ updates });
        },
      }),
    }),
  } as never;
}

beforeEach(() => {
  selectMetadataResult = {};
  updateCalls = [];
  selectCalls = 0;
});

const BASE = { projectSessionId: 'sess-1', projectId: 'proj-1' };

describe('persistHarnessSessionTitle', () => {
  test('applies the title on a row with no title yet, tagging title_source=harness', async () => {
    const applied = await persistHarnessSessionTitle({ db: fakeDb() }, {
      ...BASE,
      title: 'Fix the login bug',
      updatedAt: '2026-07-21T10:00:00.000Z',
    });
    expect(applied).toBe(true);
    expect(updateCalls).toHaveLength(1);
    const { metadata } = updateCalls[0]!.updates as { metadata: Record<string, unknown> };
    expect(metadata).toEqual({
      name: 'Fix the login bug',
      title_source: 'harness',
      title_updated_at: '2026-07-21T10:00:00.000Z',
    });
  });

  test('preserves unrelated existing metadata keys', async () => {
    selectMetadataResult = { runtime_protocol: 'acp', acp_session_id: 'abc' };
    await persistHarnessSessionTitle({ db: fakeDb() }, { ...BASE, title: 'T', updatedAt: null });
    const { metadata } = updateCalls[0]!.updates as { metadata: Record<string, unknown> };
    expect(metadata.runtime_protocol).toBe('acp');
    expect(metadata.acp_session_id).toBe('abc');
    expect(metadata.name).toBe('T');
  });

  test('never overwrites a user-set custom_name — no db write at all', async () => {
    selectMetadataResult = { custom_name: 'My renamed session', name: 'old-auto' };
    const applied = await persistHarnessSessionTitle({ db: fakeDb() }, {
      ...BASE,
      title: 'A harness title',
      updatedAt: '2026-07-21T10:00:00.000Z',
    });
    expect(applied).toBe(false);
    expect(updateCalls).toHaveLength(0);
  });

  test('a newer updatedAt overwrites an older stored harness title (last-write-wins, in-order)', async () => {
    selectMetadataResult = {
      name: 'Old title',
      title_source: 'harness',
      title_updated_at: '2026-07-21T10:00:00.000Z',
    };
    const applied = await persistHarnessSessionTitle({ db: fakeDb() }, {
      ...BASE,
      title: 'Newer title',
      updatedAt: '2026-07-21T10:05:00.000Z',
    });
    expect(applied).toBe(true);
    const { metadata } = updateCalls[0]!.updates as { metadata: Record<string, unknown> };
    expect(metadata.name).toBe('Newer title');
    expect(metadata.title_updated_at).toBe('2026-07-21T10:05:00.000Z');
  });

  test('idempotency: an equal or older updatedAt than the stored harness title is a no-op (out-of-order SSE delivery)', async () => {
    selectMetadataResult = {
      name: 'Current title',
      title_source: 'harness',
      title_updated_at: '2026-07-21T10:05:00.000Z',
    };
    const sameTimestamp = await persistHarnessSessionTitle({ db: fakeDb() }, {
      ...BASE,
      title: 'Replayed title',
      updatedAt: '2026-07-21T10:05:00.000Z',
    });
    expect(sameTimestamp).toBe(false);

    const olderTimestamp = await persistHarnessSessionTitle({ db: fakeDb() }, {
      ...BASE,
      title: 'Stale earlier title',
      updatedAt: '2026-07-21T09:00:00.000Z',
    });
    expect(olderTimestamp).toBe(false);
    expect(updateCalls).toHaveLength(0);
  });

  test('a harness title always overwrites an existing FALLBACK title, regardless of timestamps (harness is strictly more authoritative)', async () => {
    selectMetadataResult = { name: 'first prompt guess', title_source: 'fallback' };
    const applied = await persistHarnessSessionTitle({ db: fakeDb() }, {
      ...BASE,
      title: 'Real harness title',
      updatedAt: '2026-07-21T10:00:00.000Z',
    });
    expect(applied).toBe(true);
    const { metadata } = updateCalls[0]!.updates as { metadata: Record<string, unknown> };
    expect(metadata.name).toBe('Real harness title');
    expect(metadata.title_source).toBe('harness');
  });

  test('a null updatedAt still applies the title but leaves no title_updated_at bookkeeping (never blocks a later real update)', async () => {
    await persistHarnessSessionTitle({ db: fakeDb() }, { ...BASE, title: 'T', updatedAt: null });
    const { metadata } = updateCalls[0]!.updates as { metadata: Record<string, unknown> };
    expect(metadata.title_updated_at).toBeUndefined();
  });

  test('bumps the row updatedAt on every applied write', async () => {
    const before = Date.now();
    await persistHarnessSessionTitle({ db: fakeDb() }, { ...BASE, title: 'T', updatedAt: null });
    const { updatedAt } = updateCalls[0]!.updates as { updatedAt: Date };
    expect(updatedAt).toBeInstanceOf(Date);
    expect(updatedAt.getTime()).toBeGreaterThanOrEqual(before);
  });
});

describe('persistFallbackSessionTitle', () => {
  test('applies a title on a row with no title yet, tagging title_source=fallback', async () => {
    const applied = await persistFallbackSessionTitle({ db: fakeDb() }, {
      ...BASE,
      title: 'fix the login bug',
    });
    expect(applied).toBe(true);
    const { metadata } = updateCalls[0]!.updates as { metadata: Record<string, unknown> };
    expect(metadata).toEqual({ name: 'fix the login bug', title_source: 'fallback' });
  });

  test('never fires twice: a row that already has ANY name (harness or fallback) is left untouched', async () => {
    selectMetadataResult = { name: 'Already titled', title_source: 'harness' };
    const applied = await persistFallbackSessionTitle({ db: fakeDb() }, { ...BASE, title: 'second prompt text' });
    expect(applied).toBe(false);
    expect(updateCalls).toHaveLength(0);
  });

  test('never overwrites a user-set custom_name', async () => {
    selectMetadataResult = { custom_name: 'My renamed session' };
    const applied = await persistFallbackSessionTitle({ db: fakeDb() }, { ...BASE, title: 'first prompt text' });
    expect(applied).toBe(false);
    expect(updateCalls).toHaveLength(0);
  });

  test('idempotent across repeated calls with the same first-prompt text (every prompt turn is a safe call site)', async () => {
    const first = await persistFallbackSessionTitle({ db: fakeDb() }, { ...BASE, title: 'first prompt text' });
    expect(first).toBe(true);
    // Simulate the row now carrying what was just written.
    selectMetadataResult = updateCalls[0]!.updates.metadata as Record<string, unknown>;
    updateCalls = [];
    const second = await persistFallbackSessionTitle({ db: fakeDb() }, { ...BASE, title: 'a later prompt text' });
    expect(second).toBe(false);
    expect(updateCalls).toHaveLength(0);
  });

  test('a null select result (row not found under this scope) still writes a fresh metadata object, no crash', async () => {
    selectMetadataResult = null;
    const applied = await persistFallbackSessionTitle({ db: fakeDb() }, { ...BASE, title: 'T' });
    expect(applied).toBe(true);
    expect(selectCalls).toBe(1);
  });
});
