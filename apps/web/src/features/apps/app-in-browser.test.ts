import { describe, expect, test } from 'bun:test';
import type { App } from '@kortix/sdk';

import { appForUrl, withAppAccessToken, withoutAppAccessToken } from './app-in-browser';

const crm = {
  app_id: 'a1',
  name: 'CRM',
  slug: 'crm',
  url: 'https://dev-crm-0123456789abcdef.apps.kortix.com',
  services: [
    { name: 'http', url: 'https://dev-crm-0123456789abcdef.apps.kortix.com' },
    { name: 'api', url: 'https://dev-crm-0123456789abcdef--api.apps.kortix.com' },
    { name: 'db', url: null },
  ],
} as unknown as App;

describe('appForUrl', () => {
  test('matches the App by its own host, at any path', () => {
    expect(appForUrl([crm], 'https://dev-crm-0123456789abcdef.apps.kortix.com/deals/42')?.app_id).toBe('a1');
  });

  test("matches a service's host to its App", () => {
    expect(appForUrl([crm], 'https://dev-crm-0123456789abcdef--api.apps.kortix.com/v1')?.app_id).toBe('a1');
  });

  test('no match for another App host, a non-App URL, or no Apps', () => {
    expect(appForUrl([crm], 'https://dev-crm-ffffffffffffffff.apps.kortix.com/')).toBeNull();
    expect(appForUrl([crm], 'http://localhost:3000/')).toBeNull();
    expect(appForUrl(undefined, crm.url)).toBeNull();
  });
});

describe('access token', () => {
  const session = 'https://dev-crm-0123456789abcdef.apps.kortix.com/?__kortix_access=tok';

  test("moves the session's token onto a deep link and keeps its path and query", () => {
    expect(withAppAccessToken('https://dev-crm-0123456789abcdef.apps.kortix.com/deals?id=4', session)).toBe(
      'https://dev-crm-0123456789abcdef.apps.kortix.com/deals?id=4&__kortix_access=tok',
    );
  });

  test('a session URL without a token leaves the link unchanged', () => {
    expect(withAppAccessToken(crm.url, crm.url)).toBe(crm.url);
  });

  test('the copyable form drops the token and nothing else', () => {
    expect(withoutAppAccessToken('https://dev-crm-0123456789abcdef.apps.kortix.com/deals?id=4&__kortix_access=tok')).toBe(
      'https://dev-crm-0123456789abcdef.apps.kortix.com/deals?id=4',
    );
    expect(withoutAppAccessToken(crm.url)).toBe(crm.url);
  });
});
