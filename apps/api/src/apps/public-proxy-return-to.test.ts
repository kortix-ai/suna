import { describe, expect, test } from 'bun:test';
import { safeAppReturnTo } from './public-proxy-access';

// Pentest: `/\evil.example` passed the old `//` check and browsers open it as `//evil.example`.
describe('safeAppReturnTo', () => {
  test.each(['/\\evil.example', '/\t/evil.example', '/\n/evil.example', '//evil.example', 'https://evil.example', 'evil'])(
    'refuses %j',
    (value) => expect(safeAppReturnTo(value)).toBe('/'),
  );

  test('keeps a same-origin path, query and hash in canonical form', () => {
    expect(safeAppReturnTo('/a/../b?x=1#h')).toBe('/b?x=1#h');
  });
});
