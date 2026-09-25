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
