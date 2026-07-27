import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { isAccountGitAdmin } from './github-setup-required-panel';

const source = readFileSync(new URL('./github-setup-required-panel.tsx', import.meta.url), 'utf8');

describe('isAccountGitAdmin', () => {
  test('owner can manage Git settings', () => {
    expect(isAccountGitAdmin('owner')).toBe(true);
  });

  test('admin can manage Git settings', () => {
    expect(isAccountGitAdmin('admin')).toBe(true);
  });

  test('a plain member cannot', () => {
    expect(isAccountGitAdmin('member')).toBe(false);
  });

  test('an unresolved role is treated as non-admin', () => {
    expect(isAccountGitAdmin(undefined)).toBe(false);
    expect(isAccountGitAdmin(null)).toBe(false);
  });

  test('can open Nango Connect without leaving project creation', () => {
    expect(source).toContain('onConnect?: () => void');
    expect(source).toContain("onClick={onConnect ?? openGitSettings}");
    expect(source).toContain("onConnect ? 'Connect GitHub' : 'Set up GitHub'");
    expect(source).toContain('GitHub organization owner');
  });
});
