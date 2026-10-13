import { describe, expect, test } from 'bun:test';
import { sessionLogOfV1Rows } from '@kortix/sdk';
import { filterRawMessages, rawExplorerData } from './session-context-message-explorer';

const rows = [
  { info: { id: 'User-1', role: 'user', time: { created: 1_700_000_000_000 } }, parts: [{ type: 'text', text: 'Hello world' }] },
  { info: { id: 'Assistant-2', role: 'assistant', time: { created: 1_700_000_001_000 } }, parts: [{ type: 'text', text: 'Reply' }] },
  {
    info: { id: 'Assistant-3', role: 'assistant', time: { created: 1_700_000_002_000 } },
    parts: [{ type: 'file', source: { text: { value: 'hidden' } } }],
  },
];

const records = sessionLogOfV1Rows('s', 'ses_root', rows as never).threads[0]!.messages;
const ids = (list: { id: string }[]) => list.map((r) => r.id);

describe('raw explorer source switch', () => {
  test('v1 lists the rows: each row JSON and the copy text are what the explorer showed before', () => {
    for (const source of ['v1', undefined] as const) {
      const data = rawExplorerData(source, records, rows);
      expect(ids(data.rows)).toEqual(['User-1', 'Assistant-2', 'Assistant-3']);
      data.rows.forEach((row, i) => {
        expect(JSON.stringify(row.value, null, 2)).toBe(JSON.stringify({ message: rows[i]!.info, parts: rows[i]!.parts }, null, 2));
        expect(row.role).toBe(rows[i]!.info.role);
        expect(row.created).toBe(rows[i]!.info.time.created);
      });
      expect(JSON.stringify(data.copy, null, 2)).toBe(JSON.stringify(rows, null, 2));
    }
    expect(JSON.stringify(rawExplorerData('v1', undefined, undefined).copy, null, 2)).toBe('[]');
  });

  test('v2 lists the session-log records and copies them', () => {
    const data = rawExplorerData('v2', records, rows);
    expect(ids(data.rows)).toEqual(records.map((m) => m.message_id));
    data.rows.forEach((row, i) => {
      expect(row.value).toBe(records[i]);
      expect(row.role).toBe(records[i]!.role);
      expect(row.created).toBe(Date.parse(records[i]!.created_at));
    });
    expect(JSON.stringify(data.copy, null, 2)).toBe(JSON.stringify(records, null, 2));
    expect(rawExplorerData('v2', undefined, rows).rows).toEqual([]);
  });
});

describe('raw message explorer filtering', () => {
  for (const source of ['v1', 'v2'] as const) {
    const list = rawExplorerData(source, records, rows).rows;
    test(`${source}: unfiltered order`, () => {
      expect(filterRawMessages(undefined, 'all', '')).toEqual([]);
      expect(filterRawMessages(list, 'all', '')).toEqual(list);
    });
    test(`${source}: role filter and trimmed case-insensitive ID or text query`, () => {
      expect(ids(filterRawMessages(list, 'assistant', ' REPLY '))).toEqual(['Assistant-2']);
      expect(ids(filterRawMessages(list, 'user', ' user-1 '))).toEqual(['User-1']);
      expect(filterRawMessages(list, 'assistant', 'hello')).toEqual([]);
      expect(filterRawMessages(list, 'all', 'hidden')).toEqual([]);
    });
  }

  test('v2 searches reasoning text and skips tool output', () => {
    const [m] = records;
    const reasoning = { ...m!, message_id: 'R-1', blocks: [{ id: 'b', type: 'reasoning', text: 'Deep THOUGHT' }] };
    const list = rawExplorerData('v2', [reasoning] as never, undefined).rows;
    expect(ids(filterRawMessages(list, 'all', 'thought'))).toEqual(['R-1']);
  });
});
