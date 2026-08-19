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
  test('a delivering row is RENDERED, and locked — not dropped from the strip', () => {
    // A prompt typed mid-turn is forwarded within seconds and reads
    // `delivering` for the whole of the turn in front of it. It is not painted
    // into the transcript either (`willWaitInInbox`), so leaving it out of the
    // strip is the user's message vanishing from the screen entirely until
    // OpenCode persists and syncs it.
    //
    // It stays in `inFlightIds` because it is on the wire: not editable, not
    // removable, not reorderable.
    const projection = projectQueueRows({
      prompts: [
        prompt({ prompt_id: 'a' }),
        prompt({ prompt_id: 'b', state: 'delivering' }),
        prompt({ prompt_id: 'c', state: 'failed', last_error: 'delivery outcome: failed' }),
      ],
    });

    expect(projection.queued.map((r) => r.id)).toEqual(['a', 'b']);
    expect(projection.inFlightIds).toEqual(['b']);
    expect(projection.failed).toEqual([
      { id: 'c', text: 'say hi', lastError: 'delivery outcome: failed' },
    ]);
  });

  test('a row whose message is ALREADY IN THE TRANSCRIPT leaves the strip', () => {
    // The other half of rendering `delivering` rows. "Not painted into the
    // transcript" holds for the OPTIMISTIC bubble — `willWaitInInbox` decides
    // that — but not for the server message: an idle send paints the bubble
    // immediately, and a mid-turn one arrives over SSE once OpenCode persists
    // it. From that moment the same text is on screen twice, once as the
    // answer being streamed and once as a pending queue row.
    //
    // The transcript is the authority: a message that is in it is not queued.
    const projection = projectQueueRows({
      prompts: [
        prompt({ prompt_id: 'painted', message_id: 'msg_painted', state: 'delivering' }),
        prompt({ prompt_id: 'unpainted', message_id: 'msg_unpainted', state: 'delivering' }),
      ],
      transcriptMessageIds: new Set(['msg_painted']),
    });

    expect(projection.queued.map((r) => r.id)).toEqual(['unpainted']);
    expect(projection.inFlightIds).toEqual(['unpainted']);
  });

  test('a HELD row in the transcript is NOT a queue row — the bubble carries its controls, but the hold is still reported', () => {
    // A stop-paused prompt IS in the transcript, unanswered and parked. Its
    // remove and "send now" live in the bubble's own meta row now
    // (`QueuedPromptControls`), so drawing it here too would be the same
    // message twice. `held` still surfaces so the pending bubble can offer
    // "send now".
    const projection = projectQueueRows({
      prompts: [prompt({ state: 'waiting', reason: 'held', message_id: 'msg_a' })],
      transcriptMessageIds: new Set(['msg_a']),
    });

    expect(projection.queued).toHaveLength(0);
    expect(projection.held).toBe(true);
  });

  test('a row with no wire id yet is never matched against the transcript', () => {
    // An automation-shaped or not-yet-minted row carries an empty `message_id`,
    // and an empty string must not match an empty transcript entry.
    const projection = projectQueueRows({
      prompts: [prompt({ message_id: '' })],
      transcriptMessageIds: new Set(['']),
    });

    expect(projection.queued).toHaveLength(1);
  });

  test('a `waiting` row is still a queued row — waiting is WHY, not a lane', () => {
    const projection = projectQueueRows({
      prompts: [prompt({ state: 'waiting', reason: 'older_prompt_pending' })],
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
