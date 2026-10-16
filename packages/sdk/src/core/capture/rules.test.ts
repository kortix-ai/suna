import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CAPTURE_DEVICE_DEFAULTS,
  CAPTURE_EXCLUSION_GROUPS,
  CAPTURE_FRAME_INTERVALS_MS,
  CAPTURE_LAYERS,
  CAPTURE_MAX_HEIGHTS,
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

  test('the frame interval and resolution an organization can set, and what a device does without one', () => {
    expect(CAPTURE_FRAME_INTERVALS_MS).toEqual([500, 1000, 2000, 5000, 10000]);
    expect(CAPTURE_MAX_HEIGHTS).toEqual([720, 1080, 1440, 2160]);
    expect(CAPTURE_DEVICE_DEFAULTS).toEqual({ intervalMs: 2000, maxHeight: 1440 });
    expect(CAPTURE_FRAME_INTERVALS_MS).toContain(CAPTURE_DEVICE_DEFAULTS.intervalMs);
    expect(CAPTURE_MAX_HEIGHTS).toContain(CAPTURE_DEVICE_DEFAULTS.maxHeight);
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

  // The engine owns the domain rule; its vectors are vendored into suna (apps/capture/fixtures/capture-format-v2).
  const vectors = JSON.parse(
    readFileSync(join(import.meta.dir, '../../../../../apps/capture/fixtures/capture-format-v2/domains.json'), 'utf8'),
  ) as { patterns: Array<{ input: string; pattern: string | null }> };
  test.each(vectors.patterns.map((v) => [v.input, v.pattern] as const))(
    'the engine vector %p normalizes to %p',
    (input, pattern) => {
      expect(normalizeCaptureDomain(input)).toBe(pattern);
    },
  );
});
