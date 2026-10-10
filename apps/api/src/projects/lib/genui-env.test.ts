import { describe, expect, test } from 'bun:test';

import { GENUI_ENV_NAME, genuiEnvValue } from './genui-env';

const on = { experimental: { genui: true } };
const off = { experimental: { genui: false } };

describe('genuiEnvValue', () => {
  test('flag on and kill switch open => 1', () => {
    expect(genuiEnvValue(on, true)).toBe('1');
  });
  test('flag off => 0', () => {
    expect(genuiEnvValue(off, true)).toBe('0');
  });
  test('no flag set => platform default (off) => 0', () => {
    expect(genuiEnvValue({}, true)).toBe('0');
    expect(genuiEnvValue(null, true)).toBe('0');
  });
  test('kill switch closed => 0 even with the flag on', () => {
    expect(genuiEnvValue(on, false)).toBe('0');
  });
  test('env name is the one kortixd reads', () => {
    expect(GENUI_ENV_NAME).toBe('KORTIX_GENUI');
  });
});
