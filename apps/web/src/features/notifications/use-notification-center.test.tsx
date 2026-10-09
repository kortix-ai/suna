import { afterEach, describe, expect, test } from 'bun:test';
import { qk } from '@kortix/sdk/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import {
  anyCachedNotificationCenter,
  cachedNotificationCenter,
  useNotificationCenter,
} from './use-notification-center';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

/**
 * The `notification_center` gate (KRTX-1742) against a real query cache. It
 * reads cached project rows only: every test asserts that the cache was read,
 * never fetched.
 */

const flagged = (on: boolean) => ({ experimental: { notification_center: on } });

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

let renderer: ReturnType<typeof create> | null = null;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
});

/** Mounts the hook and returns a reader for its latest answer. */
async function mountHook(queryClient: QueryClient, projectId?: string | null) {
  let answer: boolean | undefined;
  function Probe() {
    answer = useNotificationCenter(projectId);
    return null;
  }
  await act(async () => {
    renderer = create(createElement(QueryClientProvider, { client: queryClient }, createElement(Probe)));
  });
  return () => answer;
}

describe('cache readers', () => {
  test('one project: exactly true in its cached detail, else false', () => {
    const queryClient = client();
    expect(cachedNotificationCenter(queryClient, 'p1')).toBe(false);
    expect(cachedNotificationCenter(null, 'p1')).toBe(false);
    expect(cachedNotificationCenter(queryClient, null)).toBe(false);
    queryClient.setQueryData(qk.project.detail('p1'), { project: flagged(true) });
    queryClient.setQueryData(qk.project.detail('p2'), { project: flagged(false) });
    queryClient.setQueryData(qk.project.detail('p3'), { project: { experimental: { notification_center: 'true' } } });
    expect(cachedNotificationCenter(queryClient, 'p1')).toBe(true);
    expect(cachedNotificationCenter(queryClient, 'p2')).toBe(false);
    expect(cachedNotificationCenter(queryClient, 'p3')).toBe(false);
  });

  test('any project: a cached detail or a cached project list', () => {
    const lists = client();
    expect(anyCachedNotificationCenter(lists)).toBe(false);
    lists.setQueryData(qk.projects.list('acc-1'), [flagged(false), flagged(false)]);
    expect(anyCachedNotificationCenter(lists)).toBe(false);
    lists.setQueryData(qk.projects.list('acc-2'), [flagged(false), flagged(true)]);
    expect(anyCachedNotificationCenter(lists)).toBe(true);

    const details = client();
    details.setQueryData(qk.project.detail('p1'), { project: flagged(true) });
    expect(anyCachedNotificationCenter(details)).toBe(true);
  });

  test('a sub-entry of a detail key does not count', () => {
    const queryClient = client();
    queryClient.setQueryData([...qk.project.detail('p1'), 'agents'], { project: flagged(true) });
    expect(anyCachedNotificationCenter(queryClient)).toBe(false);
  });
});

describe('useNotificationCenter', () => {
  test('with a project id: that project only', async () => {
    const queryClient = client();
    queryClient.setQueryData(qk.project.detail('p1'), { project: flagged(false) });
    queryClient.setQueryData(qk.projects.list('acc-1'), [flagged(true)]);
    const answer = await mountHook(queryClient, 'p1');
    expect(answer()).toBe(false);
    await act(async () => {
      queryClient.setQueryData(qk.project.detail('p1'), { project: flagged(true) });
      // The query observer reports on the next tick.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(answer()).toBe(true);
    expect(queryClient.isFetching()).toBe(0);
  });

  test('without one: any cached project, and it follows the cache', async () => {
    const queryClient = client();
    const answer = await mountHook(queryClient, null);
    expect(answer()).toBe(false);
    await act(async () => {
      queryClient.setQueryData(qk.projects.list('acc-1'), [flagged(false), flagged(true)]);
    });
    expect(answer()).toBe(true);
    await act(async () => {
      queryClient.setQueryData(qk.projects.list('acc-1'), [flagged(false)]);
    });
    expect(answer()).toBe(false);
    // No project id: the scan sent no request.
    expect(queryClient.isFetching()).toBe(0);
  });
});
