import { describe, expect, test } from 'bun:test';

import {
  WARM_TAKEN_STORAGE_KEY,
  createWarmTakenRegistry,
  takenIdsAddedByStorageEvent,
  type WarmTakenStorage,
} from './warm-session-taken-registry';

/** Minimal Storage stand-in shared by "tabs" (registries) in one test. */
function fakeStorage(): WarmTakenStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

const T0 = Date.parse('2026-08-17T09:00:00.000Z');

describe('createWarmTakenRegistry', () => {
  test('an id is not taken until recorded, then is', () => {
    const registry = createWarmTakenRegistry(fakeStorage(), () => T0);
    expect(registry.has('s-1')).toBe(false);
    registry.record('s-1');
    expect(registry.has('s-1')).toBe(true);
    expect(registry.has('s-2')).toBe(false);
  });

  test('two registries over the SAME storage see each other — the cross-tab contract', () => {
    const storage = fakeStorage();
    const tabA = createWarmTakenRegistry(storage, () => T0);
    const tabB = createWarmTakenRegistry(storage, () => T0);

    tabA.record('s-1');

    expect(tabB.has('s-1')).toBe(true);
  });

  test('storage unavailable: falls back to in-memory, still correct within the tab', () => {
    const registry = createWarmTakenRegistry(null, () => T0);
    registry.record('s-1');
    expect(registry.has('s-1')).toBe(true);
  });

  test('a storage that throws on write degrades to in-memory instead of throwing', () => {
    const storage: WarmTakenStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
    };
    const registry = createWarmTakenRegistry(storage, () => T0);
    registry.record('s-1');
    expect(registry.has('s-1')).toBe(true);
  });

  test('a corrupt payload reads as empty, then gets overwritten by the next record', () => {
    const storage = fakeStorage();
    storage.data.set(WARM_TAKEN_STORAGE_KEY, '{not json');
    const registry = createWarmTakenRegistry(storage, () => T0);
    expect(registry.has('s-1')).toBe(false);
    registry.record('s-1');
    expect(registry.has('s-1')).toBe(true);
  });

  // Pruning is asserted through a SECOND registry (another tab's view): the
  // writing registry's own in-memory mirror deliberately keeps every id it
  // recorded, so only the shared payload — what other tabs read — is pruned.
  test('entries older than 24h are pruned from the shared payload on write', () => {
    const storage = fakeStorage();
    let now = T0;
    const registry = createWarmTakenRegistry(storage, () => now);

    registry.record('old');
    now = T0 + 25 * 60 * 60 * 1000;
    registry.record('new');

    const otherTab = createWarmTakenRegistry(storage, () => now);
    expect(otherTab.has('new')).toBe(true);
    expect(otherTab.has('old')).toBe(false);
  });

  test('at most the newest 64 entries survive in the shared payload', () => {
    const storage = fakeStorage();
    let now = T0;
    const registry = createWarmTakenRegistry(storage, () => now);

    for (let i = 0; i < 70; i += 1) {
      now += 1000;
      registry.record(`s-${i}`);
    }

    const otherTab = createWarmTakenRegistry(storage, () => now);
    expect(otherTab.has('s-0')).toBe(false);
    expect(otherTab.has('s-69')).toBe(true);
  });

  test('recording the same id twice keeps one entry', () => {
    const storage = fakeStorage();
    const registry = createWarmTakenRegistry(storage, () => T0);
    registry.record('s-1');
    registry.record('s-1');
    const payload = JSON.parse(storage.data.get(WARM_TAKEN_STORAGE_KEY) ?? '[]') as unknown[];
    expect(payload.length).toBe(1);
  });
});

describe('takenIdsAddedByStorageEvent', () => {
  test('returns only the ids the event ADDED, from oldValue → newValue', () => {
    const oldValue = JSON.stringify([['s-1', T0]]);
    const newValue = JSON.stringify([
      ['s-1', T0],
      ['s-2', T0 + 1],
    ]);
    expect(takenIdsAddedByStorageEvent({ key: WARM_TAKEN_STORAGE_KEY, oldValue, newValue })).toEqual(
      ['s-2'],
    );
  });

  test('an event for a different key adds nothing', () => {
    expect(
      takenIdsAddedByStorageEvent({ key: 'other', oldValue: null, newValue: '[["s-2",1]]' }),
    ).toEqual([]);
  });

  test('a null oldValue means every id in newValue is new', () => {
    const newValue = JSON.stringify([['s-1', T0]]);
    expect(
      takenIdsAddedByStorageEvent({ key: WARM_TAKEN_STORAGE_KEY, oldValue: null, newValue }),
    ).toEqual(['s-1']);
  });

  test('corrupt values add nothing', () => {
    expect(
      takenIdsAddedByStorageEvent({ key: WARM_TAKEN_STORAGE_KEY, oldValue: null, newValue: '{x' }),
    ).toEqual([]);
  });
});
