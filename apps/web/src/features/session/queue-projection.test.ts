import type { SessionPrompt } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';
import {
  countHaltableInboxPrompts,
  projectQueueRows,
  promptIsOnScreen,
} from './queue-projection';

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

  test('a row whose WIRE id is in the transcript leaves the strip, even after the server re-minted it', () => {
    // The drain re-mints a mid-turn prompt above the live turn's ids and the
    // row's `message_id` moves to the new id BEFORE the runtime echoes it —
    // the echo is what lets the store alias the new id back to the bubble.
    // For that window (~0.4 s, every mid-turn send) the bubble this tab
    // painted is on screen under the ORIGINAL wire id and the row, matched
    // on `message_id` only, was drawn beside it: a second dimmed copy that
    // then vanished.
    const projection = projectQueueRows({
      prompts: [
        prompt({
          prompt_id: 'reminted',
          message_id: 'msg_reminted',
          wire_message_id: 'msg_original',
          state: 'delivering',
        }),
      ],
      transcriptMessageIds: new Set(['msg_original']),
    });
    expect(projection.queued).toEqual([]);
  });

  test('a row whose CLIENT id is in the transcript leaves the strip — the id that survives re-mint AND reload', () => {
    // `client_message_id` is the ONE id the host never re-mints and the reload
    // preserves: `message_id` and `wire_message_id` are both OpenCode wire ids
    // that the drain can re-mint out from under a stuck row, and across a hard
    // refresh the store's in-memory `message_id`->bubble alias is gone. When a
    // divergence leaves the transcript showing the answer under an id the row
    // no longer reports, the client id is the stable anchor that still hides
    // the row so the badge does not survive the refresh.
    const projection = projectQueueRows({
      prompts: [
        prompt({
          prompt_id: 'diverged',
          client_message_id: 'q_stable',
          message_id: 'msg_reminted_again',
          wire_message_id: 'msg_first_remint',
          state: 'delivering',
        }),
      ],
      transcriptMessageIds: new Set(['q_stable']),
    });
    expect(projection.queued).toEqual([]);
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

// A warm box mounts the transcript within seconds, and until the runtime
// echoes the prompt the queued row is the ONLY thing on screen for it. Drawn
// text-only it read as a send of no files (2026-09-04, browser-measured).
test('a queued row carries its attachment names and an uploading status', () => {
  const { queued } = projectQueueRows({
    prompts: [
      {
        prompt_id: 'p1',
        client_message_id: 'c1',
        message_id: 'msg_1',
        state: 'queued',
        reason: null,
        text: 'YO BRO',
        attempts: 0,
        last_error: null,
        created_at: '2026-09-04T15:06:47.900Z',
        available_at: '2026-09-04T15:06:47.900Z',
        attachments: [
          { filename: 'a.jpg', mime: 'image/jpeg' },
          { filename: 'b.pdf', mime: 'application/pdf' },
        ],
      },
    ],
  });
  expect(queued[0]?.attachments).toEqual([
    { filename: 'a.jpg', mime: 'image/jpeg' },
    { filename: 'b.pdf', mime: 'application/pdf' },
  ]);
  expect(queued[0]?.uploadStatus).toEqual({ state: 'uploading' });
});

test('a failed row names the failure on its attachments', () => {
  const { failed } = projectQueueRows({
    prompts: [
      {
        prompt_id: 'p2',
        client_message_id: 'c2',
        message_id: 'msg_2',
        state: 'failed',
        reason: null,
        text: 'x',
        attempts: 3,
        last_error: 'photo.jpg — upload failed (503)',
        created_at: '2026-09-04T15:06:47.900Z',
        available_at: '2026-09-04T15:06:47.900Z',
        attachments: [{ filename: 'photo.jpg', mime: 'image/jpeg' }],
      },
    ],
  });
  expect(failed[0]?.uploadStatus).toEqual({ state: 'failed', message: 'photo.jpg — upload failed (503)' });
});

test('a text-only row carries no attachment fields at all', () => {
  const { queued } = projectQueueRows({
    prompts: [
      {
        prompt_id: 'p3',
        client_message_id: 'c3',
        message_id: 'msg_3',
        state: 'queued',
        reason: null,
        text: 'plain',
        attempts: 0,
        last_error: null,
        created_at: '2026-09-04T15:06:47.900Z',
        available_at: '2026-09-04T15:06:47.900Z',
        attachments: [],
      },
    ],
  });
  expect('attachments' in (queued[0] ?? {})).toBe(false);
  expect('uploadStatus' in (queued[0] ?? {})).toBe(false);
});

// The API writes `last_error` on rows it keeps `queued` and retries, and never
// clears it on success. Read as a failure, every transient retry said "upload
// failed" (review finding, 2026-09-05).
test('a queued row with a stale last_error is still uploading, not failed', () => {
  const { queued } = projectQueueRows({
    prompts: [
      {
        prompt_id: 'p4',
        client_message_id: 'c4',
        message_id: 'msg_4',
        state: 'queued',
        reason: null,
        text: 'retrying',
        attempts: 1,
        last_error: 'delivery outcome: unreachable',
        created_at: '2026-09-04T15:06:47.900Z',
        available_at: '2026-09-04T15:06:47.900Z',
        attachments: [{ filename: 'a.jpg', mime: 'image/jpeg' }],
      },
    ],
  });
  expect(queued[0]?.uploadStatus).toEqual({ state: 'uploading' });
});

/**
 * ONE RULE FOR "IS THIS ROW ALREADY ON SCREEN", shared by both readers.
 *
 * The question was answered in two places with two different answers.
 * `projectQueueRows` matched `message_id`, `wire_message_id` AND
 * `client_message_id`; `queuedSyntheticMessages` (session-chat.tsx) — the
 * reader that actually paints the bubbles — matched only the first two. So the
 * exact case the client-id clause was added for (a re-minted wire id surviving
 * a reload, where the stable client id is the only handle left that both sides
 * still know) produced a synthetic turn BESIDE the message it duplicates.
 *
 * The predicate lives here, once, and both readers call it.
 */
describe('promptIsOnScreen', () => {
  const base = {
    prompt_id: 'p1',
    client_message_id: 'cli_1',
    message_id: 'msg_server',
    state: 'queued' as const,
    reason: null,
    text: 'hi',
    attempts: 0,
    last_error: null,
    created_at: '2026-09-08T00:00:00.000Z',
    available_at: '2026-09-08T00:00:00.000Z',
  };

  test('the id the drain re-minted it under counts', () => {
    expect(promptIsOnScreen(base, new Set(['msg_server']))).toBe(true);
  });

  test('the id this tab painted its bubble under counts', () => {
    expect(promptIsOnScreen({ ...base, wire_message_id: 'msg_client' }, new Set(['msg_client']))).toBe(
      true,
    );
  });

  /**
   * The one that survives BOTH a re-mint and a reload. Without it the row
   * renders a second bubble beside its own answer, and the "Queued" badge
   * outlives a refresh.
   */
  test('the stable client id counts — it is what survives a re-mint AND a reload', () => {
    expect(promptIsOnScreen(base, new Set(['cli_1']))).toBe(true);
  });

  test('a row the transcript has never heard of is not on screen', () => {
    expect(promptIsOnScreen(base, new Set(['msg_someone_else']))).toBe(false);
    expect(promptIsOnScreen(base, undefined)).toBe(false);
  });
});

/**
 * A PARKED ROW IS HELD, AND THAT IS NOT THE STOP BUTTON.
 *
 * Cmd/Ctrl+Enter parks a prompt by holding it server-side — the same `held`
 * mechanism the Stop button uses, because "not due, and only the user releases
 * it" is exactly what parking means. So a parked row arrives with
 * `reason: 'held'` and is indistinguishable from a stop-paused one by that
 * field alone.
 *
 * `queued_by_user` is what tells them apart. Without this the first Cmd+Enter
 * on an idle session lit the "Queue paused — press Resume" banner and dimmed
 * the whole list, telling the user their agent had been stopped when nothing
 * had stopped.
 */
describe('parked rows versus a stopped queue', () => {
  const base = {
    client_message_id: 'cli_1',
    message_id: 'msg_1',
    state: 'waiting' as const,
    reason: 'held',
    text: 'hi',
    attempts: 0,
    last_error: null,
    created_at: '2026-09-09T00:00:00.000Z',
    available_at: '2026-09-10T00:00:00.000Z',
  };

  test('a row the USER parked does not report the queue as stopped', () => {
    const projection = projectQueueRows({
      prompts: [{ ...base, prompt_id: 'p1', queued_by_user: true }],
    });
    expect(projection.held).toBe(false);
  });

  test('a row the STOP button held still does', () => {
    const projection = projectQueueRows({
      prompts: [{ ...base, prompt_id: 'p1', queued_by_user: false }],
    });
    expect(projection.held).toBe(true);
  });

  test('one stopped row among parked ones is still a stopped queue', () => {
    const projection = projectQueueRows({
      prompts: [
        { ...base, prompt_id: 'p1', queued_by_user: true },
        { ...base, prompt_id: 'p2', queued_by_user: false },
      ],
    });
    expect(projection.held).toBe(true);
  });

  test('STOP on a queue of nothing but parked rows IS a stopped queue', () => {
    // The other half of the rule, and the half `queued_by_user` alone got
    // wrong. A parked-only queue is this feature's normal state: park two
    // prompts, then press Stop. Every row is `queued_by_user`, so the clause
    // above excluded all of them — `paused` never lit, no Resume was offered,
    // and the header went on saying "runs after this turn" for a session the
    // user had just stopped. `stop_held` is the server naming WHICH hold this
    // is: written only by the stop button, cleared by every release.
    const projection = projectQueueRows({
      prompts: [
        { ...base, prompt_id: 'p1', queued_by_user: true, stop_held: true },
        { ...base, prompt_id: 'p2', queued_by_user: true, stop_held: true },
      ],
    });
    expect(projection.held).toBe(true);
  });

  test('a parked row on an idle session carries no stop flag, so nothing reads stopped', () => {
    // The direction the earlier fix protects, restated against the new field:
    // parking must never, on its own, report the session as stopped.
    const projection = projectQueueRows({
      prompts: [{ ...base, prompt_id: 'p1', queued_by_user: true, stop_held: false }],
    });
    expect(projection.held).toBe(false);
  });
});

/**
 * THE ERROR HALT COUNTS ROWS, NOT LANES.
 *
 * A failed turn holds the inbox so the next prompt cannot be answered by the
 * same broken session. The gate read the PARKED lane only, so a failure with
 * ordinary Enter-queued rows behind it held nothing and they drained into the
 * failure — the server does not stop them either
 * (`turnCompletionAllowsQueuePromotion` passes on `closed`, and an errored turn
 * is closed).
 */
describe('countHaltableInboxPrompts', () => {
  test('counts an ENTER-queued row — the lane the halt used to miss entirely', () => {
    expect(
      countHaltableInboxPrompts([prompt({ prompt_id: 'a', queued_by_user: false })]),
    ).toBe(1);
  });

  test('counts a parked row too — both lanes are the same durable rows', () => {
    expect(
      countHaltableInboxPrompts([
        prompt({ prompt_id: 'a', queued_by_user: false }),
        prompt({ prompt_id: 'b', queued_by_user: true, state: 'waiting', reason: 'held' }),
        prompt({ prompt_id: 'c', state: 'delivering' }),
      ]),
    ).toBe(3);
  });

  test('a failed row is not counted — it has given up and carries its own retry', () => {
    expect(
      countHaltableInboxPrompts([
        prompt({ prompt_id: 'a', state: 'failed', last_error: 'boom' }),
      ]),
    ).toBe(0);
  });

  test('an empty inbox protects nothing, so the halt never fires on it', () => {
    expect(countHaltableInboxPrompts([])).toBe(0);
  });
});
