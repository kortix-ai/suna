import { afterEach, describe, expect, test } from 'bun:test';
import { qk } from '@kortix/sdk/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import {
  anyCachedNotificationCenter,
  cachedNotificationCenter,
  cachedNotificationCenterAnswer,
  useNotificationCenter,
  useNotificationHostGate,
} from './use-notification-center';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

/**
 * The `notification_center` gate (KRTX-1742) against a real query cache. It
 * reads cached project rows only: every test asserts that the cache was read,
 * never fetched.
 */

const flagged = (on: boolean) => ({ experimental: { notification_center: on } });
/** A project row of a cached project list. */
const listed = (projectId: string, on: boolean) => ({ project_id: projectId, ...flagged(on) });
/** The query observer reports on the next tick. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Starts a detail fetch that never settles: the project's detail is loading. */
function loading(queryClient: QueryClient, projectId: string) {
  void queryClient.prefetchQuery({ queryKey: qk.project.detail(projectId), queryFn: () => new Promise(() => {}) });
}

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

  test('one project: a cached project list answers when its detail is not cached; the detail wins', () => {
    const queryClient = client();
    queryClient.setQueryData(qk.projects.list('acc-1'), [listed('p1', true), listed('p2', false)]);
    queryClient.setQueryData(qk.projects.list(), [listed('p3', true)]);
    expect(cachedNotificationCenter(queryClient, 'p1')).toBe(true);
    expect(cachedNotificationCenter(queryClient, 'p2')).toBe(false);
    expect(cachedNotificationCenter(queryClient, 'p3')).toBe(true);
    expect(cachedNotificationCenter(queryClient, 'p4')).toBe(false);
    queryClient.setQueryData(qk.project.detail('p1'), { project: flagged(false) });
    expect(cachedNotificationCenter(queryClient, 'p1')).toBe(false);
  });

  test('the answer is undefined when no cached detail or list holds the project', () => {
    const queryClient = client();
    queryClient.setQueryData(qk.projects.list('acc-1'), [listed('p1', false)]);
    expect(cachedNotificationCenterAnswer(queryClient, 'p1')).toBe(false);
    expect(cachedNotificationCenterAnswer(queryClient, 'p2')).toBeUndefined();
    expect(cachedNotificationCenterAnswer(queryClient, null)).toBeUndefined();
    expect(cachedNotificationCenterAnswer(null, 'p1')).toBeUndefined();
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

/** Mounts the host gate on `projectId`; `go` moves it to another page. */
async function mountGate(queryClient: QueryClient, projectId: string | null) {
  let current = projectId;
  let answer: boolean | undefined;
  function Probe() {
    answer = useNotificationHostGate(current);
    return null;
  }
  const tree = () => createElement(QueryClientProvider, { client: queryClient }, createElement(Probe));
  await act(async () => {
    renderer = create(tree());
  });
  return {
    answer: () => answer,
    go: async (next: string | null) => {
      current = next;
      await act(async () => renderer?.update(tree()));
    },
  };
}

/**
 * KRTX-1742 review: the gate of `NotificationHost`. While a project's detail
 * loads, an answer from before must not unmount the host, or entering a
 * flag-on project subscribes Web Push again.
 */
describe('useNotificationHostGate', () => {
  test('while a project detail loads, the previous answer stays; a resolved false turns it off', async () => {
    const queryClient = client();
    queryClient.setQueryData(qk.project.detail('p1'), { project: flagged(true) });
    const gate = await mountGate(queryClient, null);
    expect(gate.answer()).toBe(true);

    loading(queryClient, 'p2');
    await gate.go('p2');
    expect(gate.answer()).toBe(true);

    await act(async () => {
      queryClient.setQueryData(qk.project.detail('p2'), { project: flagged(false) });
      await tick();
    });
    expect(gate.answer()).toBe(false);
  });

  test('while a project detail loads, a cached project list answers', async () => {
    const queryClient = client();
    queryClient.setQueryData(qk.projects.list('acc-1'), [listed('p1', true), listed('p2', false)]);
    loading(queryClient, 'p1');
    loading(queryClient, 'p2');
    const gate = await mountGate(queryClient, null);
    expect(gate.answer()).toBe(true);
    await gate.go('p1');
    expect(gate.answer()).toBe(true);
    await gate.go('p2');
    expect(gate.answer()).toBe(false);
  });

  test('a cold load of a project page reads off until its detail says on', async () => {
    const queryClient = client();
    loading(queryClient, 'p1');
    const gate = await mountGate(queryClient, 'p1');
    expect(gate.answer()).toBe(false);
    await act(async () => {
      queryClient.setQueryData(qk.project.detail('p1'), { project: flagged(true) });
      await tick();
    });
    expect(gate.answer()).toBe(true);
  });

  test('a cached detail answers at once, without a request', async () => {
    const queryClient = client();
    queryClient.setQueryData(qk.project.detail('p1'), { project: flagged(true) });
    queryClient.setQueryData(qk.project.detail('p2'), { project: flagged(false) });
    const gate = await mountGate(queryClient, 'p1');
    expect(gate.answer()).toBe(true);
    await gate.go('p2');
    expect(gate.answer()).toBe(false);
    expect(queryClient.isFetching()).toBe(0);
  });
});
