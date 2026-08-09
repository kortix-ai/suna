import { describe, expect, test } from 'bun:test';

import { vercelWebDomain } from './detach-vercel-web-domain.mjs';

describe('vercelWebDomain', () => {
  test('selects only the Dev frontend hostname', () => {
    expect(vercelWebDomain('dev')).toBe('dev.kortix.com');
  });

  test('rejects staging and production detachments', () => {
    expect(() => vercelWebDomain('staging')).toThrow('only the Dev Vercel detachment is enabled');
    expect(() => vercelWebDomain('prod')).toThrow('only the Dev Vercel detachment is enabled');
  });
});
