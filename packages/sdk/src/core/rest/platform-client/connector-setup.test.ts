/**
 * The connector setup-link lifecycle policy, moved from
 * `apps/web/src/components/setup-links/` (KRTX-1012): one link-info cache with
 * injected storage, one start-outcome rule, one bounded finalize poll schedule.
 * The tests are the host suite, moved with the code.
 */
import { describe, expect, test } from 'bun:test';

import type { ConnectorSetupLinkInfo } from './host-boundary';

import {
  CONNECTOR_POLL_FIRST_DELAY_MS,
  CONNECTOR_POLL_INTERVAL_MS,
  CONNECTOR_POLL_WINDOW_MS,
  connectorHeadline,
  createConnectorLinkInfoCache,
  nextConnectorPollDelay,
  resolveConnectorStart,
} from './connector-setup';

const INFO: ConnectorSetupLinkInfo = {
  project_name: 'Project 1',
  slug: 'miro',
  app: 'miro',
  name: 'Miro',
  icon_url: 'https://cdn.example.test/miro.svg',
  expires_at: '2099-01-01T00:00:00.000Z', // far future: a fixed near date expired on 2026-10-01 and broke the suite
};

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}

describe('createConnectorLinkInfoCache', () => {
  test('cards for the same link share one request', async () => {
    let calls = 0;
    const cache = createConnectorLinkInfoCache(async () => {
      calls += 1;
      return INFO;
    });

    const [a, b] = await Promise.all([cache.load('ksl_a'), cache.load('ksl_a')]);
    expect(a).toBe(b);
    expect(calls).toBe(1);
    await cache.load('ksl_b');
    expect(calls).toBe(2);
  });

  test('a failed request is forgotten, so the next card retries instead of caching the error', async () => {
    let calls = 0;
    const cache = createConnectorLinkInfoCache(async () => {
      calls += 1;
      if (calls === 1) throw new Error('offline');
      return INFO;
    });

    await expect(cache.load('ksl_a')).rejects.toThrow('offline');
    await expect(cache.load('ksl_a')).resolves.toEqual(INFO);
    expect(calls).toBe(2);
  });
});

describe('connectorHeadline', () => {
  test('names the app and the project once both are known', () => {
    expect(connectorHeadline(INFO)).toEqual({ app: 'Miro', project: 'Project 1' });
  });

  test('falls back from display name to the provider app, then the slug', () => {
    expect(connectorHeadline({ ...INFO, name: null }).app).toBe('miro');
    expect(connectorHeadline({ ...INFO, name: undefined, app: null }).app).toBe('miro');
  });

  test('an older server without project_name leaves the project out', () => {
    expect(connectorHeadline({ ...INFO, project_name: '' }).project).toBeNull();
  });
});

describe('createConnectorLinkInfoCache — instant reads', () => {
  test('peek answers synchronously once a load has settled, so the modal opens with the logo', async () => {
    const cache = createConnectorLinkInfoCache(async () => INFO);
    expect(cache.peek('ksl_a')).toBeUndefined();
    await cache.load('ksl_a');
    expect(cache.peek('ksl_a')).toEqual(INFO);
  });

  test('a settled load persists, so a fresh page (hard refresh) peeks it before any request', async () => {
    const storage = memoryStorage();
    await createConnectorLinkInfoCache(async () => INFO, { storage }).load('ksl_a');

    let calls = 0;
    const afterRefresh = createConnectorLinkInfoCache(
      async () => {
        calls += 1;
        return INFO;
      },
      { storage },
    );
    expect(afterRefresh.peek('ksl_a')).toEqual(INFO);
    expect(calls).toBe(0);
  });

  test('the raw token is never written to storage — it is a live capability', async () => {
    const storage = memoryStorage();
    await createConnectorLinkInfoCache(async () => INFO, { storage }).load('ksl_secretcapability');
    for (const [key, value] of storage.data) {
      expect(key).not.toContain('ksl_secretcapability');
      expect(value).not.toContain('ksl_secretcapability');
    }
  });

  test('an expired link is not served from storage', async () => {
    const storage = memoryStorage();
    await createConnectorLinkInfoCache(
      async () => ({ ...INFO, expires_at: '2020-01-01T00:00:00.000Z' }),
      { storage },
    ).load('ksl_a');
    expect(
      createConnectorLinkInfoCache(async () => INFO, { storage }).peek('ksl_a'),
    ).toBeUndefined();
  });

  test('storage that throws (private mode, blocked) degrades to memory only', async () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {},
    };
    const cache = createConnectorLinkInfoCache(async () => INFO, { storage: broken });
    await expect(cache.load('ksl_a')).resolves.toEqual(INFO);
    expect(cache.peek('ksl_a')).toEqual(INFO);
  });

  test('no storage at all is memory only', async () => {
    const cache = createConnectorLinkInfoCache(async () => INFO, { storage: null });
    await expect(cache.load('ksl_a')).resolves.toEqual(INFO);
    expect(cache.peek('ksl_a')).toEqual(INFO);
  });
});

describe('resolveConnectorStart', () => {
  function finalizeReturning(body: { connected: boolean; connected_as?: string | null }) {
    const calls: number[] = [];
    return {
      calls,
      finalize: async () => {
        calls.push(1);
        return body;
      },
    };
  }

  test('a hosted url opens the popup and does not finalize yet', async () => {
    const { calls, finalize } = finalizeReturning({ connected: false });
    const outcome = await resolveConnectorStart({
      start: async () => ({ connect_url: 'https://composio.test/connect' }),
      finalize,
    });
    expect(outcome).toEqual({ kind: 'popup', url: 'https://composio.test/connect' });
    expect(calls).toHaveLength(0);
  });

  test('an already-connected slot is success: finalize once and name the identity', async () => {
    const { calls, finalize } = finalizeReturning({
      connected: true,
      connected_as: 'ops@example.test',
    });
    const outcome = await resolveConnectorStart({
      start: async () => ({ connect_url: null, connected: true, already_connected: true }),
      finalize,
    });
    expect(outcome).toEqual({
      kind: 'connected',
      alreadyConnected: true,
      connectedAs: 'ops@example.test',
    });
    expect(calls).toHaveLength(1);
  });

  test('a no-auth toolkit is success without claiming a prior account', async () => {
    const { finalize } = finalizeReturning({ connected: true, connected_as: null });
    const outcome = await resolveConnectorStart({
      start: async () => ({ connect_url: null, connected: true, already_connected: false }),
      finalize,
    });
    expect(outcome).toEqual({ kind: 'connected', alreadyConnected: false, connectedAs: null });
  });

  test('an older server without already_connected still reads as connected', async () => {
    const { finalize } = finalizeReturning({ connected: true });
    const outcome = await resolveConnectorStart({
      start: async () => ({ connect_url: null, connected: true }),
      finalize,
    });
    expect(outcome).toEqual({ kind: 'connected', alreadyConnected: false, connectedAs: null });
  });

  test('a failing finalize still shows the connected state, without an identity', async () => {
    const outcome = await resolveConnectorStart({
      start: async () => ({ connect_url: null, connected: true, already_connected: true }),
      finalize: async () => {
        throw new Error('offline');
      },
    });
    expect(outcome).toEqual({ kind: 'connected', alreadyConnected: true, connectedAs: null });
  });

  test('no url and not connected is the only error', async () => {
    const { calls, finalize } = finalizeReturning({ connected: false });
    const outcome = await resolveConnectorStart({
      start: async () => ({ connect_url: null }),
      finalize,
    });
    expect(outcome).toEqual({ kind: 'error', message: 'Could not start the connect flow.' });
    expect(calls).toHaveLength(0);
  });

  test('a start that throws surfaces its message', async () => {
    const { finalize } = finalizeReturning({ connected: false });
    const outcome = await resolveConnectorStart({
      start: async () => {
        throw new Error('The provider did not return a connect URL');
      },
      finalize,
    });
    expect(outcome).toEqual({
      kind: 'error',
      message: 'The provider did not return a connect URL',
    });
  });
});

describe('nextConnectorPollDelay', () => {
  test('the first poll waits longer than the rest', () => {
    expect(nextConnectorPollDelay(0, 0)).toBe(CONNECTOR_POLL_FIRST_DELAY_MS);
    expect(nextConnectorPollDelay(1, CONNECTOR_POLL_FIRST_DELAY_MS)).toBe(
      CONNECTOR_POLL_INTERVAL_MS,
    );
    expect(nextConnectorPollDelay(9, 60_000)).toBe(CONNECTOR_POLL_INTERVAL_MS);
  });

  test('stops once the next poll would fall outside the window', () => {
    expect(nextConnectorPollDelay(5, CONNECTOR_POLL_WINDOW_MS - CONNECTOR_POLL_INTERVAL_MS)).toBe(
      CONNECTOR_POLL_INTERVAL_MS,
    );
    expect(
      nextConnectorPollDelay(5, CONNECTOR_POLL_WINDOW_MS - CONNECTOR_POLL_INTERVAL_MS + 1),
    ).toBeNull();
    expect(nextConnectorPollDelay(99, CONNECTOR_POLL_WINDOW_MS)).toBeNull();
  });

  test('the schedule fits ~60 polls into the 5-minute window', () => {
    let elapsed = 0;
    let attempt = 0;
    for (;;) {
      const delay = nextConnectorPollDelay(attempt, elapsed);
      if (delay === null) break;
      elapsed += delay;
      attempt += 1;
      if (attempt > 1000) throw new Error('poll schedule never terminates');
    }
    expect(attempt).toBe(60);
    expect(elapsed).toBeLessThanOrEqual(CONNECTOR_POLL_WINDOW_MS);
  });
});
