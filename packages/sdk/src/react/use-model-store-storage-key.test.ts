import { expect, test } from 'bun:test';
import React from 'react';
import { act, create } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// The model picks persist in localStorage under `kortix-model-store-v1`. Before
// 2026-11-06 the key was `opencode-model-store-v1`. A browser that saved picks
// under the old key keeps them: the store reads the old key once, writes the
// value under the new key, and removes the old key. The store loads when its
// module is imported, so storage is prepared before the import below.

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
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
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  get length(): number {
    return this.map.size;
  }
}

const OLD_KEY = 'opencode-model-store-v1';
const NEW_KEY = 'kortix-model-store-v1';
const storage = new MemoryStorage();
(globalThis as any).localStorage = storage;
// The model store persists only where a window exists.
(globalThis as any).window ??= globalThis;
storage.setItem(
  OLD_KEY,
  JSON.stringify({
    user: [],
    recent: [],
    variant: {},
    sessionModel: { ses_saved: { providerID: 'kortix', modelID: 'picked-before-rename' } },
  }),
);

test('picks saved under the old key survive: read once, moved to the new key, old key removed', async () => {
  const { useModelStore } = await import('./use-model-store');
  let api!: ReturnType<typeof useModelStore>;
  function Probe() {
    api = useModelStore([]);
    return null;
  }
  let root!: ReturnType<typeof create>;
  act(() => {
    root = create(React.createElement(Probe));
  });

  expect(api.getSessionModel('ses_saved')).toEqual({ providerID: 'kortix', modelID: 'picked-before-rename' });
  expect(storage.getItem(OLD_KEY)).toBeNull();
  expect(storage.getItem(NEW_KEY) ?? '').toContain('picked-before-rename');

  // A new pick writes the new key only.
  act(() => {
    api.setSessionModel('ses_next', { providerID: 'kortix', modelID: 'picked-after-rename' });
  });
  expect(storage.getItem(NEW_KEY) ?? '').toContain('picked-after-rename');
  expect(storage.getItem(OLD_KEY)).toBeNull();
  act(() => root.unmount());
});
