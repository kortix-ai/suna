// A CELL CANNOT ANSWER A REQUEST THAT NAMES NO SESSION.
import { describe, expect, test } from 'bun:test';
import { addressCellSession } from './address-cell';

const base = 'https://8080-abc.sbx-dev.example';

describe('addressing the cell', () => {
  test('names the session the proxy already resolved', () => {
    expect(addressCellSession(`${base}/global/event`, 's1')).toBe(`${base}/global/event?c=s1`);
  });

  test('keeps the query the caller sent', () => {
    expect(addressCellSession(`${base}/session?limit=10000`, 's1'))
      .toBe(`${base}/session?limit=10000&c=s1`);
  });

  test("an explicit ?c= from the caller wins — nothing that already addresses a cell changes", () => {
    expect(addressCellSession(`${base}/session?c=chosen`, 's1')).toBe(`${base}/session?c=chosen`);
  });

  test('with no session known, the URL is untouched', () => {
    expect(addressCellSession(`${base}/session`, null)).toBe(`${base}/session`);
    expect(addressCellSession(`${base}/session`, '   ')).toBe(`${base}/session`);
  });

  test('escapes the id rather than splicing it in', () => {
    expect(addressCellSession(`${base}/x`, 'a b&c')).toBe(`${base}/x?c=a+b%26c`);
  });

  test('a URL it cannot parse is returned unchanged, never mangled', () => {
    expect(addressCellSession('not a url', 's1')).toBe('not a url');
  });
});
