import { describe, expect, test } from 'bun:test';
import { deriveSessionBoard, plainExcerpt } from './session-board';

const row = (metadata: Record<string, unknown> = {}, status = 'stopped') => ({ sessionId: 's1', status, metadata }) as never;
const working = { state: 'working' as const, since: '2026-10-30T10:00:00.000Z', turn_token: 't', pending_delivery: false };
const ended = (endReason: string | null, errorName: string | null = null) => ({ endReason, errorName, endedAt: new Date('2026-10-30T09:00:00Z') });

describe('deriveSessionBoard', () => {
  test('attention wins over a running turn; a running turn is working', () => {
    expect(deriveSessionBoard({ row: row(), working, attention: 'question', lastEnded: undefined }).board_state).toBe('needs_input');
    expect(deriveSessionBoard({ row: row(), working, attention: null, lastEnded: undefined })).toMatchObject({
      board_state: 'working', last_activity_at: '2026-10-30T10:00:00.000Z',
    });
  });

  test('the newest ended turn decides the rest: requested stop, death, completed with an answer, else idle', () => {
    const at = (lastEnded: ReturnType<typeof ended>, meta: Record<string, unknown> = {}, status = 'stopped') =>
      deriveSessionBoard({ row: row(meta, status), working: undefined, attention: null, lastEnded }).board_state;
    expect(at(ended('failed', 'UserStop'))).toBe('stopped');
    expect(at(ended('failed', 'APIError'))).toBe('failed');
    expect(at(ended('runtime_gone'))).toBe('failed');
    expect(at(ended('completed'), { result_excerpt: 'Done.' })).toBe('completed');
    expect(at(ended('completed'))).toBe('idle');
    expect(at(ended('completed'), { result_excerpt: 'Done.' }, 'failed')).toBe('failed');
  });

  test('metadata fields: handle, lead, inbound (accept unless a known value), excerpt capped at 280', () => {
    const board = deriveSessionBoard({
      row: row({ agent_handle: 'reviewer', team_lead: 'lead-1', inbound: 'hold', result_excerpt: 'x'.repeat(400), last_activity_at: '2026-10-30T11:00:00.000Z' }),
      working: undefined, attention: null, lastEnded: ended('completed'),
    });
    expect(board).toMatchObject({ agent_handle: 'reviewer', team_lead_session_id: 'lead-1', inbound: 'hold', last_activity_at: '2026-10-30T11:00:00.000Z' });
    expect(board.result_excerpt).toHaveLength(280);
    expect(deriveSessionBoard({ row: row({ inbound: 'whatever' }), working: undefined, attention: null, lastEnded: undefined }).inbound).toBe('accept');
  });
});

describe('plainExcerpt', () => {
  test('a board row reads words, not markdown', () => {
    expect(plainExcerpt('Saved to `/workspace/out/t.md`. **Option 1** We built *Kortix*:\n\n## Next\n- one [agent](https://example.com) runs\n```js\ncode\n```\nsnake_case_name stays'))
      .toBe('Saved to /workspace/out/t.md. Option 1 We built Kortix: Next one agent runs snake_case_name stays');
  });
});
