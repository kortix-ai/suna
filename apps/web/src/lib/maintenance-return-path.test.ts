import { describe, expect, test } from 'bun:test';

import { maintenanceReturnPath } from './maintenance-return-path';

describe('maintenanceReturnPath', () => {
  test('returns the visitor to the same-origin page they came from', () => {
    expect(maintenanceReturnPath('/invites/abc')).toBe('/invites/abc');
    expect(maintenanceReturnPath('/settings?tab=billing')).toBe('/settings?tab=billing');
  });

  test('falls back to / for a missing or absolute value', () => {
    expect(maintenanceReturnPath(undefined)).toBe('/');
    expect(maintenanceReturnPath('')).toBe('/');
    expect(maintenanceReturnPath('https://evil.example')).toBe('/');
    expect(maintenanceReturnPath('//evil.example')).toBe('/');
  });

  // Browsers remove tab, CR and LF from a URL and treat `\` as `/`, so each of
  // these navigates to another origin if it reaches the Location header.
  for (const from of [
    '/\t/evil.example',
    '/\n/evil.example',
    '/\r/evil.example',
    '/\\evil.example',
    '/x\\..\\..\\evil.example',
    '/%09/evil.example',
    '/%5C%5Cevil.example',
  ]) {
    test(`never leaves the origin for ${JSON.stringify(from)}`, () => {
      const target = maintenanceReturnPath(from);
      expect(new URL(target, 'https://kortix.example').origin).toBe('https://kortix.example');
      expect(target).not.toMatch(/[\u0000-\u001f\u007f\\]/);
    });
  }
});
