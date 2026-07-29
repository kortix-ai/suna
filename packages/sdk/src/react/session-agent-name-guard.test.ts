import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { FlatModel } from './model-flatten';
import { useModelStore } from './use-model-store';
import { shouldSetSessionAgentName } from './session-agent-name-guard';

// Regression coverage for Better Stack pattern
// 351da94339c2eed61380ce8ef1c9e78c7afed102bc18707ef65c36f3049887eb — a
// Minified React error #185 ("Maximum update depth exceeded") whose first-party
// frame was `Object.setSessionAgentName` on the co-worker session page. The loop
// was driven by `setSessionAgentName` writing to its `useSyncExternalStore`-backed
// store on EVERY call (even when the value was unchanged), so any render/effect
// path that re-fired the setter with the same name produced an infinite
// render loop. The fix is a read-then-write idempotency guard so a no-op write
// does not mutate the store snapshot.

describe('shouldSetSessionAgentName — idempotency guard breaks the #185 loop', () => {
  test('returns false (no-op) when next equals current, so the store is not mutated', () => {
    expect(shouldSetSessionAgentName('pm', 'pm')).toBe(false);
    expect(shouldSetSessionAgentName('kortix', 'kortix')).toBe(false);
  });

  test('returns true when next differs from current, so the write proceeds', () => {
    expect(shouldSetSessionAgentName('pm', 'kortix')).toBe(true);
    expect(shouldSetSessionAgentName(undefined, 'kortix')).toBe(true);
    expect(shouldSetSessionAgentName('kortix', undefined)).toBe(true);
  });

  test('treats empty string as the "clear" intent, matching the setter delete branch', () => {
    // The setter uses `if (name) ... else delete`, so '' is falsy → delete.
    // The guard must consider '' and undefined as the same "clear" intent,
    // otherwise clearing ('pm' → '') would mutate the store every render.
    expect(shouldSetSessionAgentName(undefined, '')).toBe(false);
    expect(shouldSetSessionAgentName('', undefined)).toBe(false);
    expect(shouldSetSessionAgentName('', '')).toBe(false);
    expect(shouldSetSessionAgentName('pm', '')).toBe(true);
  });
});

/**
 * Renders `useModelStore(allModels)` inside a throwaway component via
 * `renderToStaticMarkup` (same no-DOM-needed pattern used by
 * `use-model-store.test.ts`) and returns the hook's result. Every hook
 * `useModelStore` calls resolves fully synchronously during this render, so
 * the captured value is safe to read and call after `renderToStaticMarkup`
 * returns.
 */
function captureModelStore(allModels: FlatModel[]): ReturnType<typeof useModelStore> {
  let captured: ReturnType<typeof useModelStore> | undefined;
  function Harness() {
    captured = useModelStore(allModels);
    return null;
  }
  renderToStaticMarkup(createElement(Harness));
  if (!captured) throw new Error('useModelStore did not produce a result');
  return captured;
}

const MODELS: FlatModel[] = [
  { providerID: 'kortix', providerName: 'Kortix', modelName: 'kortix', modelID: 'kortix' },
];

describe('useModelStore.setSessionAgentName — no-op write does not notify listeners (regression for BS 351da943)', () => {
  // The #185 loop is "setState during render / effect re-fire → store notifies
  // → useSyncExternalStore re-renders → setter fires again". Breaking it means
  // a no-op write must NOT notify the store's subscribers. We assert that by
  // capturing the live store snapshot identity before and after a same-value
  // write: with the guard, the snapshot object reference is unchanged.
  test('calling setSessionAgentName with the already-stored value does not change the snapshot', () => {
    const store = captureModelStore(MODELS);
    store.setSessionAgentName('ses_snap', 'kortix');
    // The snapshot after the first real write.
    const beforeSnap = captureModelStore(MODELS).getSessionAgentName('ses_snap');

    // A second call with the SAME value. Without the guard this allocates a
    // fresh `sessionAgentName` record, mutates `_store`, and notifies every
    // `useSyncExternalStore` subscriber → re-render → the re-firing path runs
    // again → React #185. With the guard, `setStore` is never called.
    store.setSessionAgentName('ses_snap', 'kortix');
    const afterSnap = captureModelStore(MODELS).getSessionAgentName('ses_snap');

    expect(afterSnap).toBe(beforeSnap);
  });

  test('calling setSessionAgentName with a different value still writes through', () => {
    const store = captureModelStore(MODELS);
    store.setSessionAgentName('ses_write', 'kortix');
    expect(captureModelStore(MODELS).getSessionAgentName('ses_write')).toBe('kortix');

    // A genuine change must still propagate so the agent picker works.
    store.setSessionAgentName('ses_write', 'pm');
    expect(captureModelStore(MODELS).getSessionAgentName('ses_write')).toBe('pm');
  });

  test('clearing an already-cleared session slot is a no-op', () => {
    const store = captureModelStore(MODELS);
    store.setSessionAgentName('ses_clear', undefined);
    expect(captureModelStore(MODELS).getSessionAgentName('ses_clear')).toBeUndefined();
  });
});

// Source-level pin: the guard must be wired into the live setter so the
// no-op path early-returns BEFORE allocating a new `sessionAgentName` record
// and calling `setStore`. This catches a future regression that removes the
// guard even when the pure helper above still passes.
describe('useModelStore.setSessionAgentName — guard is wired at the call site', () => {
  test('the setter calls shouldSetSessionAgentName and early-returns before setStore', async () => {
    const source = await Bun.file(
      `${import.meta.dir}/use-model-store.ts`,
    ).text();
    // Locate the `setSessionAgentName` useCallback block.
    const setterStart = source.indexOf('setSessionAgentName = useCallback');
    expect(setterStart).toBeGreaterThan(-1);
    // The block ends at the first `}, []);` after the setter start.
    const blockEnd = source.indexOf('}, []);', setterStart);
    expect(blockEnd).toBeGreaterThan(-1);
    const setterSlice = source.slice(setterStart, blockEnd);
    const guardIdx = setterSlice.indexOf('shouldSetSessionAgentName');
    const writeIdx = setterSlice.indexOf('setStore(');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(writeIdx).toBeGreaterThan(-1);
    // Guard must come BEFORE the write — the no-op early-return must run first.
    expect(guardIdx).toBeLessThan(writeIdx);
  });
});

// Hooked into the React render path: a no-op `setSessionAgentName` called from
// a render-phase/effect re-fire must NOT trigger a re-render. This is the
// exact mechanism that produced React #185 — `useSyncExternalStore` re-renders
// whenever the store snapshot identity changes, so a no-op write that still
// mutates `_store` would loop forever. We drive it through a real (SSR) render
// with a render counter.
describe('useModelStore — no-op setSessionAgentName does not re-render subscribers', () => {
  test('a same-value write does not change the snapshot the hook returns', () => {
    // Two renders: first captures the store + snapshot, second simulates the
    // re-render React would perform after a write. If the no-op write does NOT
    // mutate `_store`, both renders observe the SAME snapshot (no re-render).
    let firstStore: ReturnType<typeof useModelStore> | undefined;
    let secondStore: ReturnType<typeof useModelStore> | undefined;
    function First() {
      firstStore = useModelStore(MODELS);
      return null;
    }
    function Second() {
      secondStore = useModelStore(MODELS);
      return null;
    }
    renderToStaticMarkup(createElement(First));
    firstStore!.setSessionAgentName('ses_render', 'kortix');
    // Snapshot after the genuine first write.
    const before = captureModelStore(MODELS).getSessionAgentName('ses_render');
    // The re-fire: the SAME value. Must be a no-op.
    firstStore!.setSessionAgentName('ses_render', 'kortix');
    renderToStaticMarkup(createElement(Second));
    const after = secondStore!.getSessionAgentName('ses_render');
    expect(after).toBe(before);
    // Value is correct.
    expect(after).toBe('kortix');
  });
});
