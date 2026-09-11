import { describe, expect, test } from 'bun:test';

import { DEFAULT_POSTHOG_HOST, posthogApiHost, posthogHosts } from './posthog-hosts.mjs';

describe('posthogHosts', () => {
  test('defaults to the US region, where every Kortix deployment reports', () => {
    expect(DEFAULT_POSTHOG_HOST).toBe('https://us.i.posthog.com');
    expect(posthogHosts(undefined)).toEqual({
      ingest: 'https://us.i.posthog.com',
      assets: 'https://us-assets.i.posthog.com',
      ui: 'https://us.posthog.com',
    });
  });

  test('derives the assets and ui hosts for another region, trailing slash tolerated', () => {
    expect(posthogHosts('https://eu.i.posthog.com/')).toEqual({
      ingest: 'https://eu.i.posthog.com',
      assets: 'https://eu-assets.i.posthog.com',
      ui: 'https://eu.posthog.com',
    });
  });

  test('proxies through /ingest only when the runtime host matches the build host', () => {
    expect(posthogApiHost(undefined, undefined)).toBe('/ingest');
    expect(posthogApiHost('https://us.i.posthog.com', 'https://us.i.posthog.com/')).toBe('/ingest');
    // A runtime host in another region than the build: the proxy only forwards
    // to the baked target, so the client goes direct instead.
    expect(posthogApiHost('https://eu.i.posthog.com', undefined)).toBe('https://eu.i.posthog.com');
  });
});
