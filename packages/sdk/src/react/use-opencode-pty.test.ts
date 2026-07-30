import { describe, expect, test } from 'bun:test';
import { ptyMutationOverrides } from './use-opencode-pty';
import { isPtyQueryEnabled, resolvePtyServerUrl } from './pty-query-state';

describe('PTY runtime independence', () => {
  test('enables the daemon PTY query as soon as its server URL exists', () => {
    expect(isPtyQueryEnabled('https://api.example.test/v1/p/session/8000')).toBe(true);
    expect(isPtyQueryEnabled('https://api.example.test/v1/p/session/8000', false)).toBe(false);
    expect(isPtyQueryEnabled('')).toBe(false);
  });

  test('keeps mutations pinned to the terminal server URL', () => {
    expect(resolvePtyServerUrl('https://terminal.example.test', 'https://active.example.test')).toBe(
      'https://terminal.example.test',
    );
    expect(resolvePtyServerUrl(undefined, 'https://active.example.test')).toBe(
      'https://active.example.test',
    );
    expect(resolvePtyServerUrl('', 'https://active.example.test')).toBe(
      'https://active.example.test',
    );
  });
});

describe('ptyMutationOverrides', () => {
  test('returns no onError key when options are omitted, so the host default applies', () => {
    expect(ptyMutationOverrides()).toEqual({});
    expect(ptyMutationOverrides({})).toEqual({});
    expect('onError' in ptyMutationOverrides()).toBe(false);
  });

  test('does not pass the server URL into TanStack mutation options', () => {
    expect(ptyMutationOverrides({ serverUrl: 'https://terminal.example.test' })).toEqual({});
  });

  test('passes the caller onError through so it replaces the host default', () => {
    const seen: unknown[] = [];
    const overrides = ptyMutationOverrides({ onError: (e) => seen.push(e) });
    overrides.onError?.('boom');
    expect(seen).toEqual(['boom']);
  });
});
