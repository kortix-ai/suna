import { describe, expect, test } from 'bun:test';
import { listSessionRow, listSessionsQuery } from './index';

describe('list_sessions', () => {
  test('defaults to top-level sessions', () => {
    expect(listSessionsQuery({})).toEqual({ limit: 20, parent: 'root' });
  });
  test('passes started_by and query through', () => {
    expect(listSessionsQuery({ started_by: 'automated', query: ' nightly ', limit: 500 })).toEqual({
      limit: 200,
      parent: 'root',
      started_by: 'automated',
      q: 'nightly',
    });
  });
  test('parent_session_id lists children', () => {
    expect(listSessionsQuery({ parent_session_id: 'abc' }).parent).toBe('abc');
  });
  test('rejects a bad starter and an oversized query', () => {
    expect(() => listSessionsQuery({ started_by: 'robots' })).toThrow('started_by');
    expect(() => listSessionsQuery({ query: 'x'.repeat(201) })).toThrow('200');
  });
  test('row carries started_by, parent and child count', () => {
    const row = listSessionRow({
      session_id: 's1', name: 'n', status: 'running', agent_name: 'default', origin: 'ui', updated_at: 't',
      initiator: { type: 'trigger', id: 'nightly', label: 'nightly' }, child_count: 3, search_match: 'child',
    });
    expect(row).toMatchObject({ started_by: 'nightly', parent_session_id: null, child_count: 3, search_match: 'child' });
    expect(listSessionRow({ session_id: 's2' })).toMatchObject({ started_by: null, child_count: 0 });
  });
});
