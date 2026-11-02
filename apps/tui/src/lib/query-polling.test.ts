import { describe, expect, test } from 'bun:test';

import { QueryClient, QueryObserver } from '@tanstack/react-query';

import { pollDueQueries } from './query-polling.ts';

/** A query with one observer, as a mounted hook makes it. */
function observe(
  client: QueryClient,
  key: string,
  options: { refetchInterval?: number | false; enabled?: boolean },
) {
  let calls = 0;
  const observer = new QueryObserver(client, {
    queryKey: [key],
    queryFn: async () => {
      calls += 1;
      return calls;
    },
    ...options,
  });
  const stop = observer.subscribe(() => {});
  return { calls: () => calls, stop };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('pollDueQueries: refetchInterval where TanStack sees a server (no `window` in Bun)', () => {
  test('a query whose interval passed is fetched again; one inside its interval is not', async () => {
    const client = new QueryClient();
    const polled = observe(client, 'children', { refetchInterval: 5_000 });
    await settle();
    expect(polled.calls()).toBe(1);
    const fetchedAt = client.getQueryState(['children'])!.dataUpdatedAt;

    pollDueQueries(client, fetchedAt + 4_000);
    await settle();
    expect(polled.calls()).toBe(1);

    pollDueQueries(client, fetchedAt + 5_000);
    await settle();
    expect(polled.calls()).toBe(2);
    polled.stop();
  });

  test('no interval, a disabled observer, or no observer at all: never fetched', async () => {
    const client = new QueryClient();
    const plain = observe(client, 'plain', {});
    const disabled = observe(client, 'disabled', { refetchInterval: 1_000, enabled: false });
    const gone = observe(client, 'gone', { refetchInterval: 1_000 });
    await settle();
    gone.stop();
    const later = Date.now() + 60_000;
    pollDueQueries(client, later);
    await settle();
    expect(plain.calls()).toBe(1);
    expect(disabled.calls()).toBe(0);
    expect(gone.calls()).toBe(1);
    plain.stop();
    disabled.stop();
  });
});
