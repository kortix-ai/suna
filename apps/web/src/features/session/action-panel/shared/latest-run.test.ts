import { describe, expect, test } from 'bun:test';
import type { MessageWithParts } from '@/ui';
import { latestRunCallIds, latestRunMessages } from './latest-run';

function msg(role: 'user' | 'assistant', callIds: string[] = []): MessageWithParts {
  return {
    info: { role },
    parts: callIds.map((callID) => ({ type: 'tool', callID, tool: 'read', state: { status: 'completed', input: {} } })),
  } as unknown as MessageWithParts;
}

describe('latestRunMessages', () => {
  test('empty and undefined stay empty', () => {
    expect(latestRunMessages(undefined)).toEqual([]);
    expect(latestRunMessages([])).toEqual([]);
  });

  test('slices from the LAST user message', () => {
    const m = [msg('user'), msg('assistant', ['a']), msg('user'), msg('assistant', ['b'])];
    expect(latestRunMessages(m)).toEqual(m.slice(2));
  });

  test("no user message at all → the whole list is the run", () => {
    const m = [msg('assistant', ['a'])];
    expect(latestRunMessages(m)).toEqual(m);
  });
});

describe('latestRunCallIds', () => {
  test("only the latest run's callIDs are in the set", () => {
    const m = [msg('user'), msg('assistant', ['a']), msg('user'), msg('assistant', ['b', 'c'])];
    const ids = latestRunCallIds(m);
    expect(ids.has('a')).toBe(false);
    expect(ids.has('b')).toBe(true);
    expect(ids.has('c')).toBe(true);
  });
});
