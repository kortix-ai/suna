import { describe, expect, test } from 'bun:test';
import type { SessionPrompt } from '@kortix/sdk';
import { projectQueueRows } from './queue-projection';

function prompt(overrides: Partial<SessionPrompt> = {}): SessionPrompt {
  return {
    prompt_id: 'cmd-1',
    client_message_id: 'q_1',
    message_id: 'msg_a',
    state: 'queued',
    reason: null,
    text: 'say hi',
    attempts: 0,
    last_error: null,
    created_at: '2026-08-18T00:00:00.000Z',
    available_at: '2026-08-18T00:00:00.000Z',
    ...overrides,
  };
}

describe('projectQueueRows', () => {
  test('server rows land in the queue, and a delivering one is locked', () => {
    const projection = projectQueueRows({
      prompts: [
        prompt({ prompt_id: 'a' }),
        prompt({ prompt_id: 'b', state: 'delivering' }),
        prompt({ prompt_id: 'c', state: 'failed', last_error: 'delivery outcome: failed' }),
      ],
    });

    expect(projection.queued.map((r) => r.id)).toEqual(['a']);
    expect(projection.inFlightIds).toEqual(['b']);
    expect(projection.failed).toEqual([
      { id: 'c', text: 'say hi', lastError: 'delivery outcome: failed' },
    ]);
  });

  test('a `waiting` row is still a queued row — waiting is WHY, not a lane', () => {
    const projection = projectQueueRows({
      prompts: [prompt({ state: 'waiting', reason: 'turn_active' })],
    });

    expect(projection.queued).toHaveLength(1);
    expect(projection.held).toBe(false);
  });

  test('a HELD row reports the hold, so the strip can say the queue is stopped', () => {
    const projection = projectQueueRows({
      prompts: [prompt({ state: 'waiting', reason: 'held' })],
    });

    expect(projection.held).toBe(true);
  });

  test('the order the server listed them in is the order rendered', () => {
    // The inbox delivers oldest row first, so the strip must not re-sort: a
    // list that disagrees with delivery order is a list that lies about what
    // runs next.
    const projection = projectQueueRows({
      prompts: [prompt({ prompt_id: 'first' }), prompt({ prompt_id: 'second' })],
    });

    expect(projection.queued.map((r) => r.id)).toEqual(['first', 'second']);
  });

  test('an empty inbox projects an empty strip, not a held one', () => {
    expect(projectQueueRows({ prompts: [] })).toEqual({
      queued: [],
      failed: [],
      inFlightIds: [],
      held: false,
    });
  });

  test('there is no local lane left to render', () => {
    // REWRITTEN with the browser queue's deletion. `projectQueueRows` used to
    // merge a second, tab-local list and tag every row with its origin, so a
    // remove/retry/send-now could address the store that held it. One list
    // means one holder: every row id is a server `prompt_id`.
    const projection = projectQueueRows({ prompts: [prompt({ prompt_id: 'server-1' })] });

    expect(Object.keys(projection).sort()).toEqual(['failed', 'held', 'inFlightIds', 'queued']);
    expect(projection.queued[0]).toEqual({ id: 'server-1', text: 'say hi' });
  });
});
