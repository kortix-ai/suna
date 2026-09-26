import { describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';

import {
  PERSISTED_QUERY_GC_TIME_MS,
  applyPersistedQueryDefaults,
  isPersistedQueryKey,
} from './persisted-queries';

describe('isPersistedQueryKey: what a user navigates by, nothing large or sensitive', () => {
  test.each([
    [['accounts']],
    [['projects', 'acc-1']],
    [['project', 'p-1']],
    [['project-sessions', 'p-1', 'paged']],
  ])('keeps %j', (key) => {
    expect(isPersistedQueryKey(key)).toBe(true);
  });

  test.each([
    // The flat first page: a lookup copy of the paged list's page one.
    [['project-sessions', 'p-1']],
    // The config summary carries the repository's whole file listing.
    [['project-detail', 'p-1']],
    [['project-secrets', 'p-1']],
    [['project-files', 'p-1', 'main']],
    [['project-file-content', 'p-1', 'README.md', 'main']],
    [['session-public-shares', 'p-1', 's-1']],
    [['project-model-picker', 'p-1']],
    [['account-state']],
    // A disabled query's key: no id yet.
    [['projects', null]],
    [['project', undefined]],
    [['project', '']],
    [['project-sessions', null, 'paged']],
    [['accounts', 'extra']],
    [[]],
  ])('does not keep %j', (key) => {
    expect(isPersistedQueryKey(key)).toBe(false);
  });
});

describe('applyPersistedQueryDefaults', () => {
  // React Native's default. Under `bun test` (no `window`) TanStack defaults
  // to Infinity, the server value, so the test states the device's.
  const DEVICE_GC_TIME_MS = 5 * 60 * 1000;
  const deviceClient = () =>
    new QueryClient({ defaultOptions: { queries: { gcTime: DEVICE_GC_TIME_MS } } });
  const gcTimeOf = (client: QueryClient, queryKey: readonly unknown[]) =>
    client.getQueryCache().find({ queryKey, exact: true })?.gcTime;

  test('a restored entry of a kept family outlives the 5-minute default until its screen mounts', () => {
    const client = deviceClient();
    applyPersistedQueryDefaults(client);
    // `setQueryData` is how the persisted cache restores an entry.
    client.setQueryData(['project-sessions', 'p-1', 'paged'], { pages: [], pageParams: [] });
    client.setQueryData(['projects', 'acc-1'], []);
    client.setQueryData(['project', 'p-1'], { project_id: 'p-1' });
    client.setQueryData(['accounts'], []);

    expect(gcTimeOf(client, ['project-sessions', 'p-1', 'paged'])).toBe(PERSISTED_QUERY_GC_TIME_MS);
    expect(gcTimeOf(client, ['projects', 'acc-1'])).toBe(PERSISTED_QUERY_GC_TIME_MS);
    expect(gcTimeOf(client, ['project', 'p-1'])).toBe(PERSISTED_QUERY_GC_TIME_MS);
    expect(gcTimeOf(client, ['accounts'])).toBe(PERSISTED_QUERY_GC_TIME_MS);
    client.clear();
  });

  test('other families keep the default gc time', () => {
    const client = deviceClient();
    applyPersistedQueryDefaults(client);
    client.setQueryData(['project-detail', 'p-1'], { files: [] });
    client.setQueryData(['project-secrets', 'p-1'], []);

    expect(gcTimeOf(client, ['project-detail', 'p-1'])).toBe(DEVICE_GC_TIME_MS);
    expect(gcTimeOf(client, ['project-secrets', 'p-1'])).toBe(DEVICE_GC_TIME_MS);
    client.clear();
  });
});
