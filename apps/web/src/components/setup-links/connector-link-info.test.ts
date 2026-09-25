import { describe, expect, test } from 'bun:test';

import type { ConnectorSetupLinkInfo } from '@kortix/sdk';

import { connectorHeadline, createConnectorLinkInfoCache } from './connector-link-info';

const INFO: ConnectorSetupLinkInfo = {
  project_name: 'Project 1',
  slug: 'miro',
  app: 'miro',
  name: 'Miro',
  icon_url: 'https://cdn.example.test/miro.svg',
  expires_at: '2026-10-01T00:00:00.000Z',
};

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

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}

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
    await createConnectorLinkInfoCache(async () => ({ ...INFO, expires_at: '2020-01-01T00:00:00.000Z' }), {
      storage,
    }).load('ksl_a');
    expect(createConnectorLinkInfoCache(async () => INFO, { storage }).peek('ksl_a')).toBeUndefined();
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
});
