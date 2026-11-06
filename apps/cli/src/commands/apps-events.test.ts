import { expect, test } from 'bun:test';
import { printable } from './apps-events.ts';

test('an App-written event id cannot carry terminal escapes or bidi overrides into the table', () => {
  expect(printable('ok-id_1.2')).toBe('ok-id_1.2');
  expect(printable('\u001b]0;pwned\u0007id')).toBe('?]0;pwned?id');
  expect(printable('a\u001b[2Jb\rc\nd')).toBe('a?[2Jb?c?d');
  expect(printable('\u009b31m')).toBe('?31m');
  expect(printable('evil‮gnp.exe')).toBe('evil?gnp.exe');
  expect(printable('Grüße – ok')).toBe('Grüße – ok');
});
