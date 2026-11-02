import { describe, expect, test } from 'bun:test';

import { EMPTY_SESSION_LOG_STATE, type SessionLogState } from '../../core/session-log/store';
import { logSessionRows } from './log-sessions';

const V = { schema: 'kortix.session/2' as const, v: 1 };
const head = (thread_id: string, parent: string | null, title: string | null, created_at: string) => ({
  ...V, thread_id, parent_thread_id: parent, spawned_by: null, agent: parent ? 'reviewer' : null, title, created_at,
});
const message = (thread_id: string, seq: number, at: string) => ({
  ...V, message_id: `${thread_id}-${seq}`, thread_id, seq, role: 'assistant' as const, kind: 'turn' as const, status: 'complete' as const,
  in_context: true, model: null, usage: null, finish: null, error: null, created_at: at, completed_at: at,
  producer: { harness: 'pi', harness_version: '1', adapter_version: '1' }, blocks: [],
});

describe('logSessionRows: the held logs\' threads as Session rows', () => {
  test('the root takes the session title, a child its own head and its parent; newest activity first', () => {
    const log: SessionLogState = {
      ...EMPTY_SESSION_LOG_STATE,
      session: { title: 'Release notes' },
      threads: {
        ses_root: head('ses_root', null, null, '2026-10-30T10:00:00.000Z') as never,
        ses_child: head('ses_child', 'ses_root', 'Review the diff', '2026-10-30T10:05:00.000Z') as never,
      },
      messages: {
        ses_root: [message('ses_root', 1, '2026-10-30T10:01:00.000Z')] as never,
        ses_child: [message('ses_child', 1, '2026-10-30T10:06:00.000Z')] as never,
      },
    };
    const rows = logSessionRows({ kses_1: log });
    expect(rows.map((r) => [r.id, r.title, r.parentID ?? null, r.agent ?? null])).toEqual([
      ['ses_child', 'Review the diff', 'ses_root', 'reviewer'],
      ['ses_root', 'Release notes', null, null],
    ]);
    expect(rows[1]!.time).toEqual({ created: Date.parse('2026-10-30T10:00:00.000Z'), updated: Date.parse('2026-10-30T10:01:00.000Z') });
  });

  test('no held log: no rows', () => {
    expect(logSessionRows({ kses_1: undefined })).toEqual([]);
  });
});
