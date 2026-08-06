import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';

import { PROJECT_DETAIL_STALE_MS, projectDetailQuery } from './project-detail-query';

describe('projectDetailQuery', () => {
  test('refreshes stale cached data when a capability page remounts', () => {
    const options = projectDetailQuery('project-1');

    expect(options.staleTime).toBe(PROJECT_DETAIL_STALE_MS);
    expect(options.refetchOnMount).toBe(true);
  });

  test('keeps stale data visible while concurrent observers share one refresh', async () => {
    const cached = { value: 'cached' };
    const fresh = { value: 'fresh' };
    let fetchCount = 0;
    let resolveFetch: (value: typeof fresh) => void = () => {};
    const fetchResult = new Promise<typeof fresh>((resolve) => {
      resolveFetch = resolve;
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnMount: false } },
    });
    const options = {
      ...projectDetailQuery('project-1'),
      queryFn: () => {
        fetchCount += 1;
        return fetchResult;
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
    expect(fetchCount).toBe(1);

    resolveFetch(fresh);
    await fetchResult;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(first.getCurrentResult().data).toEqual(fresh);
    expect(second.getCurrentResult().data).toEqual(fresh);

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
