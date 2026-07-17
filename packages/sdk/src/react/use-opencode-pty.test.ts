import { describe, expect, test } from 'bun:test';
import { ptyMutationOverrides } from './use-opencode-pty';

describe('ptyMutationOverrides', () => {
  test('returns no onError key when options are omitted, so the host default applies', () => {
    expect(ptyMutationOverrides()).toEqual({});
    expect(ptyMutationOverrides({})).toEqual({});
    expect('onError' in ptyMutationOverrides()).toBe(false);
  });

  test('passes the caller onError through so it replaces the host default', () => {
    const seen: unknown[] = [];
    const overrides = ptyMutationOverrides({ onError: (e) => seen.push(e) });
    overrides.onError?.('boom');
    expect(seen).toEqual(['boom']);
  });
});
