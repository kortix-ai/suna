import { describe, expect, test } from 'bun:test';
import { chooseReleaseProvider } from './volumes';

const base = { platinumEnabled: true, platformDefault: 'daytona' };

describe('chooseReleaseProvider', () => {
  test('a release with mounts and no named provider takes platinum, not the platform default', () => {
    expect(chooseReleaseProvider({ ...base, hasMounts: true })).toEqual({ ok: true, provider: 'platinum' });
  });

  test('a release with mounts keeps platinum over a daytona previous release', () => {
    expect(chooseReleaseProvider({ ...base, hasMounts: true, previous: 'daytona' })).toEqual({ ok: true, provider: 'platinum' });
  });

  test('a named provider wins; mounts on it still need platinum', () => {
    expect(chooseReleaseProvider({ ...base, hasMounts: false, requested: 'e2b' })).toEqual({ ok: true, provider: 'e2b' });
    expect(chooseReleaseProvider({ ...base, hasMounts: true, requested: 'daytona' })).toEqual({ ok: false, provider: 'daytona' });
  });

  test('mounts with platinum not configured are refused naming the default', () => {
    expect(chooseReleaseProvider({ ...base, platinumEnabled: false, hasMounts: true })).toEqual({ ok: false, provider: 'daytona' });
  });

  test('no mounts: a new App and a daytona App both take platinum when it is configured', () => {
    expect(chooseReleaseProvider({ ...base, hasMounts: false })).toEqual({ ok: true, provider: 'platinum' });
    expect(chooseReleaseProvider({ ...base, hasMounts: false, previous: 'daytona' })).toEqual({ ok: true, provider: 'platinum' });
  });

  test('platinum not configured: an existing App keeps its provider, a new App gets the platform default (null)', () => {
    const off = { ...base, platinumEnabled: false, hasMounts: false };
    expect(chooseReleaseProvider({ ...off, previous: 'e2b' })).toEqual({ ok: true, provider: 'e2b' });
    expect(chooseReleaseProvider(off)).toEqual({ ok: true, provider: null });
  });
});
