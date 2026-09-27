import { afterAll, describe, expect, test } from 'bun:test';

import { registerQueryClient } from '@/lib/query-client-singleton';
import { createPersistedQueryCache, currentSavedCopyStore } from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';
import { QueryClient } from '@tanstack/react-query';

import { adoptDeviceCaches, clearDeviceCaches } from './device-caches';

const entries = new Map<string, string>();
const storage = {
  getItem: (key: string) => entries.get(key) ?? null,
  setItem: (key: string, value: string) => void entries.set(key, value),
  removeItem: (key: string) => void entries.delete(key),
};
const pageWindow = new EventTarget();
const pageDocument = Object.assign(new EventTarget(), { visibilityState: 'visible' });
const originals = {
  localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
  window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
  document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
};
for (const [name, value] of Object.entries({
  localStorage: storage,
  window: pageWindow,
  document: pageDocument,
})) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
afterAll(() => {
  for (const [name, descriptor] of Object.entries(originals)) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
});

const USER = 'user-a';
const STORAGE_KEY = `kortix.query-cache:${USER}`;
const gateKey = ['project-access-boundary', 'project-1', USER];
const listKey = qk.project.sessionsPaged('project-1');
const messagesKey = qk.project.messages('project-1', 'session-1');
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('device caches', () => {
  const client = new QueryClient();

  test('a reload restores the user’s queries, and each one refetches on first read', async () => {
    // What the previous page load left behind, including a key that must not survive.
    const previous = new QueryClient();
    previous.setQueryData(gateKey, { project_id: 'project-1' });
    previous.setQueryData(listKey, {
      pages: [{ items: [], next_cursor: null }],
      pageParams: [null],
    });
    previous.setQueryData(messagesKey, ['a message']);
    const writer = createPersistedQueryCache({ storage, userId: USER, shouldPersist: () => true });
    writer.persist(previous);
    await writer.flush();

    registerQueryClient(client);
    adoptDeviceCaches(USER);

    expect(client.getQueryData(gateKey)).toEqual({ project_id: 'project-1' });
    expect(client.getQueryData(listKey)).toEqual({
      pages: [{ items: [], next_cursor: null }],
      pageParams: [null],
    });
    expect(client.getQueryData(messagesKey)).toBeUndefined();
    expect(client.getQueryState(gateKey)?.isInvalidated).toBe(true);
    expect(currentSavedCopyStore()).not.toBeNull();
  });

  test('leaving the page writes the latest state without waiting for the throttle', async () => {
    client.setQueryData(gateKey, { project_id: 'project-1', name: 'renamed' });
    pageWindow.dispatchEvent(new Event('pagehide'));
    await settle();
    expect(entries.get(STORAGE_KEY)).toContain('renamed');
  });

  test('a sign-out stops the writer at once and forgets the user', async () => {
    await clearDeviceCaches();
    expect(currentSavedCopyStore()).toBeNull();
    expect(entries.has(STORAGE_KEY)).toBe(false);

    // The next user's first query must not land under the previous user's key.
    client.setQueryData(qk.project.summary('project-2'), { project_id: 'project-2' });
    pageWindow.dispatchEvent(new Event('pagehide'));
    await settle();
    expect(entries.has(STORAGE_KEY)).toBe(false);
  });
});
