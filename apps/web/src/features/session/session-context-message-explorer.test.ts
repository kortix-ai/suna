import type { MessageWithParts } from '@/ui/types';
import { describe, expect, test } from 'bun:test';
import { filterRawMessages } from './session-context-message-explorer';

const rows = [
  { info: { id: 'User-1', role: 'user' }, parts: [{ type: 'text', text: 'Hello world' }] },
  { info: { id: 'Assistant-2', role: 'assistant' }, parts: [{ type: 'text', text: 'Reply' }] },
  {
    info: { id: 'Assistant-3', role: 'assistant' },
    parts: [{ type: 'file', source: { text: { value: 'hidden' } } }],
  },
] as MessageWithParts[];

describe('raw message explorer filtering', () => {
  test('undefined messages and unfiltered order', () => {
    expect(filterRawMessages(undefined, 'all', '')).toEqual([]);
    expect(filterRawMessages(rows, 'all', '')).toEqual(rows);
  });
  test('role filter and trimmed case-insensitive ID or text query', () => {
    expect(filterRawMessages(rows, 'assistant', ' REPLY ')).toEqual([rows[1]]);
    expect(filterRawMessages(rows, 'user', ' user-1 ')).toEqual([rows[0]]);
    expect(filterRawMessages(rows, 'assistant', 'hello')).toEqual([]);
    expect(filterRawMessages(rows, 'all', 'hidden')).toEqual([]);
  });
});
