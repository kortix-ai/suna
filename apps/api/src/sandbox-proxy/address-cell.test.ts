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

import { sessionNamedByUrl } from './address-cell';

describe('whether the URL named the session', () => {
  const record = { sandboxId: 'sess-1', sessionId: 'sess-1', externalId: 'sbx_shared' };

  test('a per-session base URL names it exactly — however many sessions share the box', () => {
    expect(sessionNamedByUrl('sess-1', record)).toBe('sess-1');
  });

  test('a box-shaped URL names nothing — the row was picked by ordering, not by the viewer', () => {
    // This is the shared-runner case that served one user another's stream.
    expect(sessionNamedByUrl('sbx_shared', record)).toBeNull();
  });

  test('an id that is BOTH the session and the box is treated as the box — ambiguity goes to the stricter rule', () => {
    expect(sessionNamedByUrl('same', { sandboxId: 'same', externalId: 'same', sessionId: 'sess-1' })).toBeNull();
  });

  test('a row with no session cannot be named by anything', () => {
    expect(sessionNamedByUrl('sess-1', { sandboxId: 'sess-1', sessionId: null })).toBeNull();
    expect(sessionNamedByUrl('sess-1', null)).toBeNull();
  });

  test('an empty id is not a name', () => {
    expect(sessionNamedByUrl('', record)).toBeNull();
    expect(sessionNamedByUrl('  ', record)).toBeNull();
    expect(sessionNamedByUrl(undefined, record)).toBeNull();
  });
});

import { ownRowForCaller } from './address-cell';

describe("a caller that names its session, on a box that holds many", () => {
  const box = 'sbx_shared';
  const s1 = { sandboxId: 's1', sessionId: 's1', externalId: box };
  const s2 = { sandboxId: 's2', sessionId: 's2', externalId: box };

  test('gets ITS row, not the one the ordering preferred', () => {
    // The API delivered s2's prompt by box; the box resolved to s1.
    expect(ownRowForCaller(s1, s2, 's2')).toBe(s2);
  });

  test('when the resolved row already is the caller, nothing changes', () => {
    expect(ownRowForCaller(s2, s2, 's2')).toBe(s2);
    expect(ownRowForCaller(s2, null, 's2')).toBe(s2);
  });

  test('never redirects to a DIFFERENT box — the URL named the box', () => {
    const elsewhere = { sandboxId: 's2', sessionId: 's2', externalId: 'sbx_other' };
    expect(ownRowForCaller(s1, elsewhere, 's2')).toBe(s1);
  });

  test("a row that is not the caller's is not the caller's, whatever was passed", () => {
    expect(ownRowForCaller(s1, s2, 's3')).toBe(s1);
  });

  test('with no caller session there is nothing to prefer — the browser path is untouched', () => {
    expect(ownRowForCaller(s1, s2, null)).toBe(s1);
    expect(ownRowForCaller(s1, s2, '')).toBe(s1);
  });
});

