import { describe, expect, test } from 'bun:test';

import { serializeInboxItem } from './inbox-items';

type Row = Parameters<typeof serializeInboxItem>[0];

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: 'itm_1',
    accountId: 'acc_1',
    projectId: 'proj_1',
    sessionId: 'sess_1',
    userId: 'user_1',
    kind: 'run_completed',
    title: 'Nightly backup',
    source: 'schedule',
    metadata: { error: null },
    dedupKey: 'run_completed:sess_1:1',
    readAt: null,
    createdAt: new Date('2026-07-06T09:00:00.000Z'),
    ...overrides,
  } as Row;
}

describe('serializeInboxItem', () => {
  test('maps a row to the API shape and marks unread when read_at is null', () => {
    expect(serializeInboxItem(row())).toEqual({
      id: 'itm_1',
      project_id: 'proj_1',
      session_id: 'sess_1',
      kind: 'run_completed',
      title: 'Nightly backup',
      source: 'schedule',
      metadata: { error: null },
      read: false,
      read_at: null,
      created_at: '2026-07-06T09:00:00.000Z',
    });
  });

  test('reports read with an ISO read_at when set', () => {
    const out = serializeInboxItem(row({ readAt: new Date('2026-07-06T10:00:00.000Z') }));
    expect(out.read).toBe(true);
    expect(out.read_at).toBe('2026-07-06T10:00:00.000Z');
  });

  test('defaults null metadata to an empty object', () => {
    expect(serializeInboxItem(row({ metadata: null })).metadata).toEqual({});
  });
});
