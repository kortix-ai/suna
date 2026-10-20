import { describe, expect, mock, test } from 'bun:test';
import type { SessionTurnStatus } from '@kortix/api-contract';
import * as realInbox from '../session-lifecycle/inbox-rows';
import * as realTurns from './session-turn-read';
import { promptState, type PromptRow } from './session-prompt-view';
const requested: string[][] = [];
let promptRows: PromptRow[] = [];
mock.module('./session-turn-read', () => ({
  ...realTurns,
  readSessionTurnStates: async (ids: string[]) => {
    requested.push(ids);
    return new Map<string, SessionTurnStatus>(ids.map(id => [id, { turns: [] }]));
  },
}));
mock.module('../session-lifecycle/inbox-rows', () => ({
  ...realInbox,
  listInboxPromptsForSessions: async (ids: string[]) => { requested.push(ids); return promptRows.map(row => ({ sessionId: row.sessionId, ...promptState(row), client_sent_at_ms: typeof row.payload.clientSentAtMs === 'number' ? row.payload.clientSentAtMs : null })); },
}));
const { readSessionsWorking } = await import('./session-working-read');
describe('session inventory working reader', () => {
  test('batches exactly the visible page once and reports awake but idle sessions idle', async () => {
    const result = await readSessionsWorking(['visible-a', 'visible-b']);
    expect(requested).toEqual([['visible-a', 'visible-b'], ['visible-a', 'visible-b']]);
    expect([...result.values()]).toEqual(Array(2).fill({ state: 'idle', since: null, turn_token: null, pending_delivery: false }));
  });
  test('live inbox uses canonical queued, held, failed and forwarded wire semantics per session', async () => {
    const row: PromptRow = {
      commandId: 'prompt', sessionId: 'visible-a', projectId: 'project', accountId: 'account',
      actorUserId: 'user', commandType: 'continue_session', source: 'user', status: 'queued', idempotencyKey: null,
      payload: { clientMessageId: 'message', clientSentAtMs: 1000 }, result: {},
      attempts: 0, lastError: null, availableAt: new Date(0),
      createdAt: new Date(0), updatedAt: new Date(0),
      lockedBy: null, lockedUntil: null,
    };
    promptRows = [row];
    expect((await readSessionsWorking(['visible-a', 'visible-b'])).get('visible-a')).toMatchObject({ state: 'working', pending_delivery: true, since: '1970-01-01T00:00:01.000Z' });
    expect((await readSessionsWorking(['visible-b'])).get('visible-b')?.state).toBe('idle');
    promptRows = [{ ...row, result: { held: true } }];
    expect((await readSessionsWorking(['visible-a'])).get('visible-a')?.state).toBe('idle');
    promptRows = [{ ...row, status: 'succeeded', result: { status: 'forwarded' } }];
    expect((await readSessionsWorking(['visible-a'])).get('visible-a')?.pending_delivery).toBe(true);
    promptRows = [{ ...row, status: 'failed' }];
    expect((await readSessionsWorking(['visible-a'])).get('visible-a')?.state).toBe('idle');
    promptRows = [];
  });
  test('empty pages perform no reads', async () => {
    requested.length = 0;
    expect((await readSessionsWorking([])).size).toBe(0);
    expect(requested).toEqual([]);
  });
});
