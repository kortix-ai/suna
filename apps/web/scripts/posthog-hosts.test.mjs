import { describe, expect, test } from 'bun:test';

import { DEFAULT_POSTHOG_HOST, posthogApiHost, posthogHosts } from './posthog-hosts.mjs';

describe('posthogHosts', () => {
  test('defaults to the EU region', () => {
    expect(DEFAULT_POSTHOG_HOST).toBe('https://eu.i.posthog.com');
    expect(posthogHosts(undefined)).toEqual({
      ingest: 'https://eu.i.posthog.com',
      assets: 'https://eu-assets.i.posthog.com',
      ui: 'https://eu.posthog.com',
    });
  });

  test('derives the assets and ui hosts for another region, trailing slash tolerated', () => {
    expect(posthogHosts('https://us.i.posthog.com/')).toEqual({
      ingest: 'https://us.i.posthog.com',
      assets: 'https://us-assets.i.posthog.com',
      ui: 'https://us.posthog.com',
    });
  });

  test('proxies through /ingest only when the runtime host matches the build host', () => {
    expect(posthogApiHost(undefined, undefined)).toBe('/ingest');
    expect(posthogApiHost('https://us.i.posthog.com', 'https://us.i.posthog.com/')).toBe('/ingest');
    expect(posthogApiHost('https://us.i.posthog.com', undefined)).toBe('https://us.i.posthog.com');
  });
});
