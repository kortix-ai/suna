import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';

import { contract, qk } from '@kortix/sdk/react';

import { projectDetailQuery } from './project-detail-query';

const PROJECT_DETAIL_STALE_MS = contract('config').staleTime;

describe('projectDetailQuery', () => {
  test('reads through the shared qk.project.detail key on the config contract', () => {
    const options = projectDetailQuery('project-1');

    expect(options.queryKey).toEqual(qk.project.detail('project-1'));
    expect(options.staleTime).toBe(PROJECT_DETAIL_STALE_MS);
    // refetchOnMount is false everywhere on purpose (contract('config')):
    // explicit invalidation is the freshness channel, not a component mount.
    expect(options.refetchOnMount).toBe(false);
  });

  test('two observers mounting on stale cached data share it without a background refetch', () => {
    const cached = { value: 'cached' };
    let fetchCount = 0;
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const options = {
      ...projectDetailQuery('project-1'),
      queryFn: () => {
        fetchCount += 1;
        return Promise.resolve({ value: 'fresh' });
      },
    };
    queryClient.setQueryData(options.queryKey, cached, {
      updatedAt: Date.now() - PROJECT_DETAIL_STALE_MS - 1,
    });
    const first = new QueryObserver(queryClient, options);
    const second = new QueryObserver(queryClient, options);
    const unsubscribeFirst = first.subscribe(() => {});
    const unsubscribeSecond = second.subscribe(() => {});

    expect(first.getCurrentResult().data).toEqual(cached);
    expect(second.getCurrentResult().data).toEqual(cached);
    expect(fetchCount).toBe(0);

    unsubscribeFirst();
    unsubscribeSecond();
  });

  test('does not refresh data inside the freshness window', () => {
    let fetchCount = 0;
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnMount: false } },
    });
    const options = {
      ...projectDetailQuery('project-1'),
      queryFn: async () => {
        fetchCount += 1;
        return { value: 'fresh' };
      },
    };
    queryClient.setQueryData(options.queryKey, { value: 'cached' });
    const observer = new QueryObserver(queryClient, options);
    const unsubscribe = observer.subscribe(() => {});

    expect(observer.getCurrentResult().data).toEqual({ value: 'cached' });
    expect(fetchCount).toBe(0);

    unsubscribe();
  });
});
