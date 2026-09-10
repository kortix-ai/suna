import { beforeEach, expect, test } from 'bun:test';
import type { Event, Message } from '@opencode-ai/sdk/v2/client';
import { useSyncStore } from '../../browser/stores/sync-store';
import { claimSessionCacheOwnership, getSessionCacheOwnership, resetSessionCacheOwnership } from '../../browser/session-sync/session-cache-ownership';
import { sessionsNeedingRehydrate } from './rehydrate-targets';

beforeEach(() => {
  useSyncStore.getState().reset();
  resetSessionCacheOwnership();
});

test('gap rehydrate selects this stream roots and children, skipping foreign and owner-less ids', () => {
  const owners: Record<string, string> = { a: 'a', b: 'b', child: 'b' };
  expect(sessionsNeedingRehydrate(['a', 'b', 'child', 'unknown', 'b'], {
    currentScope: 'b', ownerOf: (id) => owners[id],
  })).toEqual(['b', 'child']);
  expect(sessionsNeedingRehydrate(['a', 'unknown'])).toEqual([]);
});

test('runtime and mirror hydration stamp runtime ownership without replacing authoritative Kortix ownership', () => {
  claimSessionCacheOwnership('same', 'kortix:project/session');
  useSyncStore.getState().hydrate('same', [], { runtimeScope: 'runtime-a', source: 'cache' });
  expect(useSyncStore.getState().sessionRuntime.same).toBe('runtime-a');
  useSyncStore.getState().hydrate('same', [], { runtimeScope: 'runtime-b' });
  expect(useSyncStore.getState().sessionRuntime.same).toBe('runtime-b');
  expect(getSessionCacheOwnership('same')).toBe('kortix:project/session');
  useSyncStore.getState().clearSession('same');
  expect(useSyncStore.getState().sessionRuntime.same).toBeUndefined();
});

test('live upserts stamp their producing stream scope', () => {
  useSyncStore.getState().upsertMessage('child', { id: 'm', sessionID: 'child', role: 'user' } as Message, 'runtime-a');
  expect(useSyncStore.getState().sessionRuntime.child).toBe('runtime-a');
});

test('session.deleted drops messages, parts, retained ids, detached state, status, and both ownership records', () => {
  const state = useSyncStore.getState();
  claimSessionCacheOwnership('gone', 'kortix:p/s');
  const release = state.retainSession('gone');
  state.hydrate('gone', [{ info: { id: 'm', sessionID: 'gone', role: 'user' } as Message, parts: [] }], { runtimeScope: 'runtime-a' });
  state.upsertPart('m', { id: 'part', sessionID: 'gone', messageID: 'm', type: 'text', text: 'hello' });
  release();
  state.applyEvent({ type: 'session.deleted', properties: { info: { id: 'gone' } } } as Event, 'runtime-a');
  const after = useSyncStore.getState();
  expect('gone' in after.messages).toBe(false);
  expect('m' in after.parts).toBe(false);
  expect(after.sessionRuntime.gone).toBeUndefined();
  expect(after.sessionStatus.gone).toBeUndefined();
  expect(getSessionCacheOwnership('gone')).toBeNull();
  expect(after.wasTranscriptEvicted('gone')).toBe(false);
  // Reuse the id; stale detached state must not evict it on later navigation.
  after.hydrate('gone', []);
  for (let i = 0; i < 5; i++) after.retainSession(`next-${i}`)();
  expect('gone' in useSyncStore.getState().messages).toBe(true);
});

test('a deleted session consumer cannot release a new consumer that reuses its id', () => {
  const state = useSyncStore.getState();
  const releaseDeleted = state.retainSession('reused');
  state.applyEvent({ type: 'session.deleted', properties: { info: { id: 'reused' } } } as Event);
  const releaseCurrent = state.retainSession('reused');
  state.hydrate('reused', []);
  releaseDeleted();
  for (let i = 0; i < 5; i++) state.retainSession(`next-${i}`)();
  expect('reused' in useSyncStore.getState().messages).toBe(true);
  releaseCurrent();
});
