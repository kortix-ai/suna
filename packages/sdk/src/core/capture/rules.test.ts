import { describe, expect, test } from 'bun:test';

import {
  CAPTURE_EXCLUSION_GROUPS,
  CAPTURE_LAYERS,
  CAPTURE_RETENTION_LIMITS,
  normalizeCaptureAppId,
  normalizeCaptureDomain,
} from './rules';

describe('Capture rules shared by the API, the web and the CLI', () => {
  test('the layers and exclusion categories, in display order', () => {
    expect(CAPTURE_LAYERS).toEqual(['screen', 'actions', 'audio']);
    expect(CAPTURE_EXCLUSION_GROUPS).toEqual(['password_managers', 'messaging', 'banking']);
    expect(CAPTURE_RETENTION_LIMITS).toEqual({ localHours: 24 * 365, remoteDays: 3650 });
  });

  test.each([
    ['example.com', 'example.com'],
    ['  Example.COM ', 'example.com'],
    ['https://www.Bank.example.com/login?x=1', 'bank.example.com'],
    ['example.com:8080', 'example.com'],
    ['example.com.', 'example.com'],
    ['http://user@host.example.org/', 'host.example.org'],
    ['sub.domain.co.uk', 'sub.domain.co.uk'],
  ])('domain %p → %p', (input, expected) => {
    expect(normalizeCaptureDomain(input)).toBe(expected);
  });

  test.each(['', '   ', 'notadomain', 'not a domain', 'http://', 'exa mple.com', '-bad-.com', 'localhost'])(
    'not a website: %p',
    (input) => {
      expect(normalizeCaptureDomain(input)).toBeNull();
    },
  );

  test.each([
    ['com.apple.keychainaccess', 'com.apple.keychainaccess'],
    ['  1password.exe ', '1password.exe'],
    ['proton pass.exe', 'proton pass.exe'],
  ])('app id %p → %p', (input, expected) => {
    expect(normalizeCaptureAppId(input)).toBe(expected);
  });

  test.each(['', '   ', '--frontmost', '-x', 'two words', 'a\u0000b', 'x'.repeat(256)])('not an app id: %p', (input) => {
    expect(normalizeCaptureAppId(input)).toBeNull();
  });
});
