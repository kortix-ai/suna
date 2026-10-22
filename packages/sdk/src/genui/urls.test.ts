import { describe, expect, test } from 'bun:test';

import { safeUrl } from './urls';

describe('safeUrl', () => {
  test('allows only absolute http(s)', () => {
    expect(safeUrl('https://example.com/a b')).toBe('https://example.com/a%20b');
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('data:text/html,<b>')).toBeNull();
    expect(safeUrl('/relative')).toBeNull();
    expect(safeUrl(42)).toBeNull();
    expect(safeUrl('https://google.com@evil.example/x')).toBeNull();
    expect(safeUrl('https://user:pass@example.com/')).toBeNull();
    expect(safeUrl(`https://e.com/${'a'.repeat(3000)}`)).toBeNull();
  });
});
