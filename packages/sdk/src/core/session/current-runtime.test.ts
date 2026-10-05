import { test, expect, beforeEach, afterEach } from 'bun:test';
import {
  currentRuntimeStore,
  getCurrentRuntimeDbSandboxId,
  getCurrentRuntimeSandboxId,
  getCurrentRuntimeUrl,
  setCurrentRuntime,
} from './current-runtime';

// This is a process-wide singleton (`state` is module-level) — several OTHER
// files exercise real session-start flows that call the real
// `setCurrentRuntime` too (e.g. `kortix.test.ts`, `session/session.test.ts`,
// `files/client.test.ts`), so this module's state is NOT guaranteed to be
// untouched by the time this file's tests run, and `version` is a
// process-cumulative counter with no reset-to-zero — never assert an absolute
// "pristine" value here, only reset-then-observe or relative deltas. Reset
// before AND after every test in this file so neither direction leaks.
beforeEach(() => {
  setCurrentRuntime(null);
});
afterEach(() => {
  setCurrentRuntime(null);
});

test('after clearing, url/sandboxId/dbSandboxId all read back null', () => {
  expect(getCurrentRuntimeUrl()).toBeNull();
  expect(getCurrentRuntimeSandboxId()).toBeNull();
  expect(getCurrentRuntimeDbSandboxId()).toBeNull();
});

test('setCurrentRuntime sets url + sandboxId + dbSandboxId, all readable via the getters', () => {
  setCurrentRuntime('http://backend.local/p/sb-1/8000', 'sb-1', 'db-sb-1');

  expect(getCurrentRuntimeUrl()).toBe('http://backend.local/p/sb-1/8000');
  expect(getCurrentRuntimeSandboxId()).toBe('sb-1');
  expect(getCurrentRuntimeDbSandboxId()).toBe('db-sb-1');
});

test('setCurrentRuntime defaults sandboxId/dbSandboxId to null when omitted', () => {
  setCurrentRuntime('http://backend.local/p/sb-1/8000');

  expect(getCurrentRuntimeUrl()).toBe('http://backend.local/p/sb-1/8000');
  expect(getCurrentRuntimeSandboxId()).toBeNull();
  expect(getCurrentRuntimeDbSandboxId()).toBeNull();
});

test('setCurrentRuntime(null) clears the runtime back to the empty state', () => {
  setCurrentRuntime('http://backend.local/p/sb-1/8000', 'sb-1', 'db-sb-1');
  setCurrentRuntime(null);

  expect(getCurrentRuntimeUrl()).toBeNull();
  expect(getCurrentRuntimeSandboxId()).toBeNull();
  expect(getCurrentRuntimeDbSandboxId()).toBeNull();
});

test('version increments on every actual change', () => {
  const v0 = currentRuntimeStore.getState().version;
  setCurrentRuntime('http://a.local', 'sb-a');
  const v1 = currentRuntimeStore.getState().version;
  expect(v1).toBe(v0 + 1);

  setCurrentRuntime('http://b.local', 'sb-b');
  const v2 = currentRuntimeStore.getState().version;
  expect(v2).toBe(v1 + 1);
});

test('setting an identical (url, sandboxId, dbSandboxId) triple is a no-op — version does not bump', () => {
  setCurrentRuntime('http://a.local', 'sb-a', 'db-a');
  const vAfterFirst = currentRuntimeStore.getState().version;

  setCurrentRuntime('http://a.local', 'sb-a', 'db-a');
  expect(currentRuntimeStore.getState().version).toBe(vAfterFirst);
});

test('changing only the sandboxId (same url) still bumps version — not a pure url comparison', () => {
  setCurrentRuntime('http://a.local', 'sb-a', 'db-a');
  const v1 = currentRuntimeStore.getState().version;

  setCurrentRuntime('http://a.local', 'sb-b', 'db-a');
  expect(currentRuntimeStore.getState().version).toBe(v1 + 1);
  expect(getCurrentRuntimeSandboxId()).toBe('sb-b');
});

test('changing only the dbSandboxId (same url + sandboxId) still bumps version', () => {
  setCurrentRuntime('http://a.local', 'sb-a', 'db-a');
  const v1 = currentRuntimeStore.getState().version;

  setCurrentRuntime('http://a.local', 'sb-a', 'db-b');
  expect(currentRuntimeStore.getState().version).toBe(v1 + 1);
  expect(getCurrentRuntimeDbSandboxId()).toBe('db-b');
});

test('subscribe notifies listeners on change and the unsubscribe function stops further notifications', () => {
  let notifications = 0;
  const unsubscribe = currentRuntimeStore.subscribe(() => {
    notifications++;
  });

  setCurrentRuntime('http://a.local', 'sb-a');
  expect(notifications).toBe(1);

  setCurrentRuntime('http://a.local', 'sb-a'); // no-op change — no notification
  expect(notifications).toBe(1);

  setCurrentRuntime('http://b.local', 'sb-b');
  expect(notifications).toBe(2);

  unsubscribe();
  setCurrentRuntime('http://c.local', 'sb-c');
  expect(notifications).toBe(2);
});

test('multiple listeners are all notified independently', () => {
  const seen: string[] = [];
  const unsubA = currentRuntimeStore.subscribe(() => seen.push('a'));
  const unsubB = currentRuntimeStore.subscribe(() => seen.push('b'));

  setCurrentRuntime('http://a.local', 'sb-a');
  expect(seen).toEqual(['a', 'b']);

  unsubA();
  setCurrentRuntime('http://b.local', 'sb-b');
  expect(seen).toEqual(['a', 'b', 'b']);

  unsubB();
});

test('getState returns the same live state object shape used by the getters', () => {
  setCurrentRuntime('http://a.local', 'sb-a', 'db-a');
  const state = currentRuntimeStore.getState();

  expect(state.url).toBe(getCurrentRuntimeUrl());
  expect(state.sandboxId).toBe(getCurrentRuntimeSandboxId());
  expect(state.dbSandboxId).toBe(getCurrentRuntimeDbSandboxId());
});
