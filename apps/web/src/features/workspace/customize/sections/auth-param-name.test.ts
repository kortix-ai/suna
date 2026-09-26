import { describe, expect, test } from 'bun:test';

import { parameterNameLooksLikeSecret } from './auth-param-name';

describe('parameterNameLooksLikeSecret', () => {
  test('the incident value — a PostHog key pasted as the parameter name', () => {
    expect(parameterNameLooksLikeSecret('phx_32hWeFPgQboVVirsxPXfzfmaAQcafWNyts75s')).toBe(true);
  });

  test('vendor-prefixed keys are caught regardless of length', () => {
    for (const key of ['sk-abc', 'ghp_x1', 'xoxb-1234', 'glpat-zz', 'github_pat_a']) {
      expect(parameterNameLooksLikeSecret(key)).toBe(true);
    }
  });

  test('real parameter names never trip it', () => {
    for (const name of [
      'Authorization',
      'X-Api-Key',
      'api_key',
      'x-goog-api-key',
      'apikey',
      'X-Amz-Security-Token',
      '',
      '  ',
    ]) {
      expect(parameterNameLooksLikeSecret(name)).toBe(false);
    }
  });

  test('long digit-carrying tokens are keys; long words alone are not', () => {
    expect(parameterNameLooksLikeSecret('a1b2c3d4e5f6a7b8c9d0e1f2')).toBe(true);
    expect(parameterNameLooksLikeSecret('averylongheadernamewithoutdigits')).toBe(false);
  });
});
