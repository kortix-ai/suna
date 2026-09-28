import { describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';

import { refreshAfterShare } from './share-session-cache';

// On dev (2026-09-28) a share switched the session's ChatGPT selection to the
// project's connection, but the Provider keys panel kept its cached pre-share
// selection and showed it as "unavailable". Saving that stale view would have
// stored an empty selection and stopped the session's model.

const POOLS = 'session-provider-secret-pools';

function seeded() {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  // The reader is `useSessionProviderSecretPools` (@kortix/sdk/react).
  client.setQueryData([POOLS, 'p1', 's1'], { pools: [{ provider_id: 'codex', configured: true, secret_ids: ['own-key'] }] });
  client.setQueryData([POOLS, 'p1', 's2'], { pools: [] });
  client.setQueryData([POOLS, 'p2', 's1'], { pools: [] });
  return client;
}

const stale = (client: QueryClient, key: string[]) => client.getQueryState(key)?.isInvalidated;

describe('refreshAfterShare', () => {
  test('the shared session`s key selection is read again', async () => {
    const client = seeded();
    await refreshAfterShare(client, 'p1', 's1');
    expect(stale(client, [POOLS, 'p1', 's1'])).toBe(true);
  });

  test('no other session`s selection is touched', async () => {
    const client = seeded();
    await refreshAfterShare(client, 'p1', 's1');
    expect(stale(client, [POOLS, 'p1', 's2'])).toBe(false);
    expect(stale(client, [POOLS, 'p2', 's1'])).toBe(false);
  });
});
