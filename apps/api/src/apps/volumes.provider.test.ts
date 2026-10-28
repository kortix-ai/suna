import { describe, expect, test } from 'bun:test';
import { chooseReleaseProvider } from './volumes';

// The choice is provider-agnostic; `other` is a synthetic provider without volumes.
const base = { platinumEnabled: true, platformDefault: 'other' };

describe('chooseReleaseProvider', () => {
  test('a release with mounts and no named provider takes platinum, not the platform default', () => {
    expect(chooseReleaseProvider({ ...base, hasMounts: true })).toEqual({ ok: true, provider: 'platinum' });
  });

  test('a release with mounts keeps platinum over a previous release elsewhere', () => {
    expect(chooseReleaseProvider({ ...base, hasMounts: true, previous: 'other' })).toEqual({ ok: true, provider: 'platinum' });
  });

  test('a named provider wins; mounts on it still need platinum', () => {
    expect(chooseReleaseProvider({ ...base, hasMounts: false, requested: 'other' })).toEqual({ ok: true, provider: 'other' });
    expect(chooseReleaseProvider({ ...base, hasMounts: true, requested: 'other' })).toEqual({ ok: false, provider: 'other' });
  });

  test('mounts with platinum not configured are refused naming the default', () => {
    expect(chooseReleaseProvider({ ...base, platinumEnabled: false, hasMounts: true })).toEqual({ ok: false, provider: 'other' });
  });

  test('no mounts: a new App and an App elsewhere both take platinum when it is configured', () => {
    expect(chooseReleaseProvider({ ...base, hasMounts: false })).toEqual({ ok: true, provider: 'platinum' });
    expect(chooseReleaseProvider({ ...base, hasMounts: false, previous: 'other' })).toEqual({ ok: true, provider: 'platinum' });
  });

  test('platinum not configured: an existing App keeps its provider, a new App gets the platform default (null)', () => {
    const off = { ...base, platinumEnabled: false, hasMounts: false };
    expect(chooseReleaseProvider({ ...off, previous: 'other' })).toEqual({ ok: true, provider: 'other' });
    expect(chooseReleaseProvider(off)).toEqual({ ok: true, provider: null });
  });
});
