import { describe, expect, test } from 'bun:test';

import { DEV_ARG_MAX_CHARS, RELEASE_ARG_MAX_CHARS, formatArgs } from './logger';

describe('formatArgs', () => {
  test('keeps primitives unchanged', () => {
    expect(formatArgs(['msg', 3, true, null, undefined], DEV_ARG_MAX_CHARS)).toEqual([
      'msg',
      3,
      true,
      null,
      undefined,
    ]);
  });

  test('maps an Error to name and message', () => {
    expect(formatArgs([new Error('socket hang up')], DEV_ARG_MAX_CHARS)).toEqual([
      'Error: socket hang up',
    ]);
    expect(formatArgs([new TypeError('x is undefined')], DEV_ARG_MAX_CHARS)).toEqual([
      'TypeError: x is undefined',
    ]);
  });

  test('serialises plain objects', () => {
    expect(formatArgs([{ status: 404 }], DEV_ARG_MAX_CHARS)).toEqual(['{"status":404}']);
  });

  test('truncates a long string argument to the limit', () => {
    const [out] = formatArgs(['a'.repeat(5_000)], RELEASE_ARG_MAX_CHARS) as string[];
    expect(out.length).toBeLessThanOrEqual(RELEASE_ARG_MAX_CHARS + 1);
    expect(out.startsWith('a'.repeat(RELEASE_ARG_MAX_CHARS))).toBe(true);
    expect(out.endsWith('…')).toBe(true);
  });

  test('truncates a long serialised object to the limit', () => {
    const big = { body: 'x'.repeat(10_000) };
    const [dev] = formatArgs([big], DEV_ARG_MAX_CHARS) as string[];
    const [release] = formatArgs([big], RELEASE_ARG_MAX_CHARS) as string[];
    expect(dev.length).toBe(DEV_ARG_MAX_CHARS + 1);
    expect(release.length).toBe(RELEASE_ARG_MAX_CHARS + 1);
  });

  test('truncates a long Error message', () => {
    const [out] = formatArgs([new Error('e'.repeat(3_000))], RELEASE_ARG_MAX_CHARS) as string[];
    expect(out.length).toBe(RELEASE_ARG_MAX_CHARS + 1);
  });

  test('survives a cyclic object', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;
    const [out] = formatArgs([cyclic], DEV_ARG_MAX_CHARS) as string[];
    expect(typeof out).toBe('string');
  });

  test('uses 2 000 characters in development and 500 in release', () => {
    expect(DEV_ARG_MAX_CHARS).toBe(2_000);
    expect(RELEASE_ARG_MAX_CHARS).toBe(500);
  });
});
