import type { QueuedDraft } from '@/stores/queued-draft-store';
import type { RemovedSessionPrompt, SessionPrompt } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';
import { optimisticSessionPrompt } from '@kortix/sdk/react';
import type { AttachedFile } from './composer/types';
import {
  cleanPromptText,
  draftClientMessageId,
  draftMessageId,
  isDraftRowId,
  paintedMessageIdsOf,
  projectQueueRows,
  promptIdForClientMessage,
  promptRowRemovable,
  quickQueueRemove,
  rowsToRemoveOnRewind,
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

function draft(clientMessageId: string, over: Partial<QueuedDraft> = {}): QueuedDraft {
  return {
    clientMessageId,
    messageId: `wire_${clientMessageId}`,
    text: `typed ${clientMessageId}`,
    files: [],
    createdAtMs: 1_000,
    posted: true,
    ...over,
  };
}

const remoteFile: AttachedFile = {
  kind: 'remote',
  url: 'https://files.test/a.png',
  filename: 'a.png',
  mime: 'image/png',
  isImage: true,
};

describe('projectQueueRows', () => {
  test('conversation placement stays out of the composer list, including uploads', () => {
    const { rows, heldCount } = projectQueueRows({
      prompts: [
        prompt({ placement: 'transcript', reason: 'held' }),
        prompt({ prompt_id: 'composer', placement: 'composer' }),
      ],
      drafts: [draft('upload', { placement: 'transcript', posted: false })],
    });
    expect(rows.map((row) => row.id)).toEqual(['composer']);
    expect(heldCount).toBe(1);
  });

  test('a composer entry uses full accepted text after reload', () => {
    const text = '  const result = await run();\n'.repeat(120).trim();
    expect(
      projectQueueRows({ prompts: [prompt({ full_text: text, text: text.slice(0, 2000) })] })
        .rows[0].text,
    ).toBe(text);
  });

  test('the order the server listed them in is the order rendered', () => {
    // The inbox delivers oldest first. A list that re-sorts lies about what
    // runs next.
    const { rows } = projectQueueRows({
      prompts: [prompt({ prompt_id: 'first' }), prompt({ prompt_id: 'second' })],
    });
    expect(rows.map((r) => r.id)).toEqual(['first', 'second']);
  });

  test('each state carries the controls the server will honour', () => {
    const { rows } = projectQueueRows({
      prompts: [
        prompt({ prompt_id: 'queued' }),
        prompt({ prompt_id: 'waiting', state: 'waiting', reason: 'turn_active' }),
        prompt({ prompt_id: 'delivering', state: 'delivering' }),
        prompt({ prompt_id: 'failed', state: 'failed', last_error: 'delivery outcome: failed' }),
        prompt({ prompt_id: 'optimistic:q_9', client_message_id: 'q_9' }),
      ],
    });
    expect(
      rows.map((r) => [r.id, r.state, r.removable, r.takeBackEligible, r.lastError ?? null]),
    ).toEqual([
      ['queued', 'queued', true, true, null],
      // `waiting` is WHY a row has not gone out, not a lane of its own.
      ['waiting', 'queued', true, true, null],
      // Its turn is starting: the server refuses a DELETE with 409.
      ['delivering', 'delivering', false, false, null],
      ['failed', 'failed', true, false, 'delivery outcome: failed'],
      // No server id yet: nothing to remove or take back.
      ['optimistic:q_9', 'sending', false, false, null],
    ]);
  });

  test('a row already on screen in the transcript is not a queued entry — by any of its ids', () => {
    const { rows } = projectQueueRows({
      prompts: [
        prompt({ prompt_id: 'by-message', message_id: 'msg_m' }),
        prompt({ prompt_id: 'by-wire', message_id: 'msg_reminted', wire_message_id: 'msg_w' }),
        prompt({ prompt_id: 'by-client', client_message_id: 'q_stable', message_id: 'msg_x' }),
        prompt({ prompt_id: 'unpainted', message_id: 'msg_u' }),
      ],
      transcriptMessageIds: new Set(['msg_m', 'msg_w', 'q_stable']),
    });
    expect(rows.map((r) => r.id)).toEqual(['unpainted']);
  });

  test('a row with no wire id yet is never matched against the transcript', () => {
    const { rows } = projectQueueRows({
      prompts: [prompt({ message_id: '' })],
      transcriptMessageIds: new Set(['']),
    });
    expect(rows).toHaveLength(1);
  });

  test("the session's first prompt stays with the transcript, never the list", () => {
    // `startSessionWithPrompt` mints `start_…`. That prompt IS the turn about
    // to run, and `OptimisticTurn` draws it in the transcript.
    // The API's `create.pending_prompt` mints `pending:<session>` for the same job.
    const { rows } = projectQueueRows({
      prompts: [
        prompt({ prompt_id: 'first', client_message_id: 'start_abc' }),
        prompt({ prompt_id: 'server-first', client_message_id: 'pending:ses_1' }),
        prompt(),
      ],
    });
    expect(rows.map((r) => r.id)).toEqual(['cmd-1']);
  });

  test('heldCount counts every held row — including one the transcript is showing', () => {
    // Resume has to be reachable whenever the server holds anything, wherever
    // the held message happens to be drawn.
    const projection = projectQueueRows({
      prompts: [
        prompt({ prompt_id: 'a', state: 'waiting', reason: 'held', message_id: 'msg_a' }),
        prompt({ prompt_id: 'b', state: 'waiting', reason: 'held', message_id: 'msg_b' }),
        prompt({ prompt_id: 'c', state: 'failed', reason: 'held', message_id: 'msg_c' }),
      ],
      transcriptMessageIds: new Set(['msg_a']),
    });
    expect(projection.heldCount).toBe(2);
    expect(projection.rows.map((r) => r.id)).toEqual(['b', 'c']);
  });

  test('heldCount counts a restored row from the click, before its POST answers', () => {
    // Undo after Stop. The optimistic row the SDK paints already reads `held`,
    // so "Queue paused — N" is right in the same frame instead of one round
    // trip later, and the row is never counted as work in flight in between.
    const projection = projectQueueRows({
      prompts: [
        optimisticSessionPrompt(
          {
            clientMessageId: 'q_undo',
            messageId: 'msg_undo',
            parts: [{ type: 'text', text: 'put this back' }],
            restore: true,
            held: true,
          },
          1_000,
        ),
      ],
    });
    expect(projection.heldCount).toBe(1);
    expect(projection.rows.map((r) => r.state)).toEqual(['sending']);
  });

  test('an empty inbox projects nothing', () => {
    expect(projectQueueRows({ prompts: [] })).toEqual({ rows: [], heldCount: 0 });
  });

  test("the list shows a row's words, not the transport blocks the send appended", () => {
    const { rows } = projectQueueRows({
      prompts: [
        prompt({
          text:
            '<reply_context>earlier answer</reply_context>\n\nfix the parser\n\n' +
            '<file path="/workspace/uploads/a.png" mime="image/png" filename="a.png"></file>',
        }),
      ],
    });
    expect(rows[0]?.text).toBe('fix the parser');
    expect(rows[0]?.attachmentCount).toBe(1);
  });

  test("this tab's draft supplies the text as typed and its file count", () => {
    const { rows } = projectQueueRows({
      prompts: [prompt({ client_message_id: 'q_1', text: 'server preview' })],
      drafts: [draft('q_1', { text: 'as typed', files: [remoteFile, remoteFile] })],
    });
    expect(rows[0]).toMatchObject({ text: 'as typed', attachmentCount: 2, takeBackEligible: true });
  });

  test('a row with files and no draft cannot be taken back — its files would be lost', () => {
    const { rows } = projectQueueRows({
      prompts: [
        prompt({
          prompt_id: 'files',
          attachments: [{ filename: 'a.pdf', mime: 'application/pdf' }],
        }),
        prompt({ prompt_id: 'text' }),
      ],
    });
    expect(rows.map((r) => [r.id, r.takeBackEligible])).toEqual([
      ['files', false],
      ['text', true],
    ]);
  });

  test('a draft still uploading has a row before the inbox does, after the server rows', () => {
    const { rows } = projectQueueRows({
      prompts: [prompt({ prompt_id: 'server', client_message_id: 'q_server' })],
      drafts: [
        draft('q_uploading', { posted: false, text: 'with a big file', files: [remoteFile] }),
        // Posted and no longer listed: delivered. It must not come back.
        draft('q_delivered'),
      ],
    });
    expect(rows.map((r) => [r.id, r.state, r.attachmentCount])).toEqual([
      ['server', 'queued', 0],
      ['draft:q_uploading', 'sending', 1],
    ]);
  });

  test('a draft whose POST is in flight renders once, as its optimistic row', () => {
    const { rows } = projectQueueRows({
      prompts: [prompt({ prompt_id: 'optimistic:q_1', client_message_id: 'q_1' })],
      drafts: [draft('q_1', { posted: false })],
    });
    expect(rows.map((r) => r.id)).toEqual(['optimistic:q_1']);
  });

  test('a row whose remove or retry is in flight says which action it is', () => {
    // The row keeps its buttons visible while the request runs. What it must
    // not do is accept a second one — `acceptRowAction` reads this field.
    const { rows } = projectQueueRows({
      prompts: [
        prompt({ prompt_id: 'cmd-1', client_message_id: 'q_1' }),
        prompt({ prompt_id: 'cmd-2', client_message_id: 'q_2', state: 'failed' }),
        prompt({ prompt_id: 'cmd-3', client_message_id: 'q_3' }),
      ],
      pendingActions: { 'cmd-1': 'remove', 'cmd-2': 'retry' },
    });
    expect(rows.map((r) => [r.id, r.pendingAction])).toEqual([
      ['cmd-1', 'remove'],
      ['cmd-2', 'retry'],
      ['cmd-3', undefined],
    ]);
  });

  test('no pending actions at all leaves every row free', () => {
    const { rows } = projectQueueRows({ prompts: [prompt()] });
    expect(rows[0].pendingAction).toBeUndefined();
  });

  test('a draft with no server row yet can carry no pending action', () => {
    // Its id is `draft:<clientMessageId>`, which is not a `prompt_id`, so a
    // same-named entry must not reach it.
    const { rows } = projectQueueRows({
      prompts: [],
      drafts: [draft('q_1', { posted: false })],
      pendingActions: { 'draft:q_1': 'remove', q_1: 'remove' },
    });
    expect(rows[0].pendingAction).toBeUndefined();
  });

  test("a failed server row carries the server's code and whether Retry can help", () => {
    const { rows } = projectQueueRows({
      prompts: [
        prompt({
          prompt_id: 'credits',
          state: 'failed',
          last_error: 'Out of credits. Top up to continue.',
          failure_code: 'out_of_credits',
        }),
        prompt({ prompt_id: 'gone', state: 'failed', failure_code: 'session_gone' }),
        prompt({ prompt_id: 'old', state: 'failed', last_error: 'admission check failed' }),
        prompt({ prompt_id: 'live' }),
      ],
    });
    expect(rows.map((r) => [r.id, r.failureCode ?? null, r.retryable])).toEqual([
      ['credits', 'out_of_credits', true],
      // The session is gone: sending it again can only fail the same way.
      ['gone', 'session_gone', false],
      // A row written before the server recorded codes.
      ['old', null, true],
      // Not failed: there is nothing to retry.
      ['live', null, false],
    ]);
  });

  test('a Queue List send that failed before the server had a row is a failed row', () => {
    // The failure lives in the held-send store, keyed by the wire id
    // `handleSend` minted — the ONE source of failure truth. The projection
    // mints the same id from the same pair.
    const files = [remoteFile];
    const { rows } = projectQueueRows({
      prompts: [],
      drafts: [draft('q_up', { posted: false, text: 'summarise the report', files })],
      heldSendFailures: {
        wire_q_up: { message: "a.png didn't upload", code: 'upload_failed' },
      },
    });
    expect(rows).toEqual([
      {
        id: 'draft:q_up',
        clientMessageId: 'q_up',
        text: 'summarise the report',
        attachmentCount: 1,
        state: 'failed',
        lastError: "a.png didn't upload",
        failureCode: 'upload_failed',
        removable: true,
        retryable: true,
        takeBackEligible: false,
        // No server row yet: nothing to send now.
        canSendNow: false,
      },
    ]);
  });

  test('a draft whose send is still on the wire stays `sending`, with nothing to click', () => {
    const { rows } = projectQueueRows({
      prompts: [],
      drafts: [draft('q_wire', { posted: false })],
      heldSendFailures: { wire_q_other: { message: 'x' } },
    });
    expect(rows[0]).toMatchObject({
      state: 'sending',
      removable: false,
      retryable: false,
      takeBackEligible: false,
    });
    expect(rows[0].lastError).toBeUndefined();
  });

  test('the failure key is the id the draft CARRIES, never one re-derived here', () => {
    // `mintSessionWireMessageId` memoizes in a module Map capped at 256 pairs
    // and evicts the oldest, so a re-derived key is a different key once a
    // long-lived tab has minted past the cap — and the failed row would
    // silently go back to `sending` with no Retry and no Remove. The draft
    // holds the id its own send was minted under, so nothing can evict it.
    const { rows } = projectQueueRows({
      prompts: [],
      drafts: [draft('q_lru', { posted: false, messageId: 'msg_minted_long_ago' })],
      heldSendFailures: { msg_minted_long_ago: { message: 'nope', code: 'network' } },
    });
    expect(rows[0]).toMatchObject({ state: 'failed', failureCode: 'network', retryable: true });
  });

  test('a draft kept by a producer that holds no send stays `sending`', () => {
    // The boot shell builds its rows from its own send state and has no wire
    // id to give. It must not crash, and must not claim a failure.
    const { messageId: _omitted, ...noWireId } = draft('q_shell', { posted: false });
    const { rows } = projectQueueRows({
      prompts: [],
      drafts: [noWireId],
      heldSendFailures: { wire_q_shell: { message: 'x' } },
    });
    expect(rows[0]).toMatchObject({ state: 'sending', removable: false, retryable: false });
  });

  test('a failure with no code of its own still shows its reason', () => {
    const { rows } = projectQueueRows({
      prompts: [],
      drafts: [draft('q_net', { posted: false })],
      heldSendFailures: { wire_q_net: { message: 'Failed to fetch' } },
    });
    expect(rows[0]).toMatchObject({ state: 'failed', lastError: 'Failed to fetch' });
    expect(rows[0].failureCode).toBeUndefined();
  });
});

describe('draft row ids', () => {
  test('a draft row names its draft, and a server row never does', () => {
    expect(isDraftRowId('draft:q_1')).toBe(true);
    expect(isDraftRowId('cmd-1')).toBe(false);
    expect(draftClientMessageId('draft:q_1')).toBe('q_1');
    expect(draftClientMessageId('cmd-1')).toBeNull();
  });

  test('a client message id containing the separator survives the round trip', () => {
    const { rows } = projectQueueRows({
      prompts: [],
      drafts: [draft('pending:ses_1', { posted: false })],
    });
    expect(draftClientMessageId(rows[0].id)).toBe('pending:ses_1');
  });
});

describe('draftMessageId', () => {
  // The two draft handlers need the wire id the send was minted under. Reading
  // it off the draft keeps them on the same key the projection reads.
  test('hands back the id the draft was sent under', () => {
    expect(draftMessageId([draft('a'), draft('b')], 'b')).toBe('wire_b');
  });

  test('no draft, or a draft with no wire id, has nothing to hand back', () => {
    expect(draftMessageId([draft('a')], 'missing')).toBeNull();
    const { messageId: _omitted, ...noWireId } = draft('c');
    expect(draftMessageId([noWireId], 'c')).toBeNull();
  });
});

describe('promptIdForClientMessage', () => {
  // A DELETE matches `prompt_id`. A send that failed before its response
  // arrived holds only its `client_message_id`, so the row a lost POST created
  // is found by that.
  test('finds the row a lost POST created', () => {
    const rows = [
      prompt({ prompt_id: 'cmd-1', client_message_id: 'q_1' }),
      prompt({ prompt_id: 'cmd-2', client_message_id: 'q_2' }),
    ];
    expect(promptIdForClientMessage(rows, 'q_2')).toBe('cmd-2');
  });

  test('no row means nothing to remove', () => {
    expect(promptIdForClientMessage([], 'q_1')).toBeNull();
    expect(promptIdForClientMessage([prompt({ client_message_id: 'q_9' })], 'q_1')).toBeNull();
  });
});

describe('cleanPromptText', () => {
  test('strips every block the send path appends', () => {
    const text =
      'look at @notes\n\nReferenced sessions (use the session_context tool to fetch details when needed):\n' +
      '<session_ref id="ses_1" title="Intro" />\n\n<file_ref path="notes.md" name="notes.md" />\n\n<agent_ref name="coder" />';
    expect(cleanPromptText(text)).toEqual({ text: 'look at @notes', fileCount: 0 });
  });
});

describe('rowsToRemoveOnRewind', () => {
  // A rewind stages `session.revert` and the NEXT delivered prompt commits it,
  // so every queued row has to go before the replacement prompt is sent. The
  // selection is read AFTER the rewind await, and it must not re-DELETE a row
  // the user removed during that await, nor a row whose own action is still on
  // the wire — both would spend a request on an outcome that already happened.
  test('a row already gone from the list is not in the result', () => {
    const stillQueued = prompt({ prompt_id: 'cmd-2', client_message_id: 'q_2' });
    expect(rowsToRemoveOnRewind({ prompts: [stillQueued] })).toEqual([stillQueued]);
    // The removed row is simply absent from `prompts` — the SDK filters it out
    // of the cache on the click — so the loop never sees it.
    expect(rowsToRemoveOnRewind({ prompts: [] })).toEqual([]);
  });

  test('a row whose remove or retry is in flight is not in the result', () => {
    const removing = prompt({ prompt_id: 'cmd-2', client_message_id: 'q_2' });
    const retrying = prompt({ prompt_id: 'cmd-3', client_message_id: 'q_3', state: 'failed' });
    const free = prompt({ prompt_id: 'cmd-4', client_message_id: 'q_4' });
    expect(
      rowsToRemoveOnRewind({
        prompts: [removing, retrying, free],
        pendingActions: { 'cmd-2': 'remove', 'cmd-3': 'retry' },
      }),
    ).toEqual([free]);
  });

  test('a row already handed to the runtime is not in the result: the server refuses it', () => {
    const delivering = prompt({ prompt_id: 'cmd-5', state: 'delivering' });
    const queued = prompt({ prompt_id: 'cmd-6' });
    expect(rowsToRemoveOnRewind({ prompts: [delivering, queued] })).toEqual([queued]);
  });

  test('no pending actions at all leaves every removable row in the result', () => {
    const rows = [prompt({ prompt_id: 'cmd-7' }), prompt({ prompt_id: 'cmd-8', state: 'failed' })];
    expect(rowsToRemoveOnRewind({ prompts: rows, pendingActions: {} })).toEqual(rows);
  });
});

describe('the Send now field on a projected row', () => {
  test('a queued row can be sent now', () => {
    const [row] = projectQueueRows({ prompts: [prompt({ placement: 'composer' })] }).rows;
    expect(row.canSendNow).toBe(true);
  });

  test('delivering and failed rows cannot', () => {
    const rows = projectQueueRows({
      prompts: [
        prompt({ prompt_id: 'd', client_message_id: 'q_d', state: 'delivering' }),
        prompt({ prompt_id: 'f', client_message_id: 'q_f', state: 'failed' }),
      ],
    }).rows;
    expect(rows.map((r) => r.canSendNow)).toEqual([false, false]);
  });
});

describe('promptRowRemovable — one removal rule for both lanes', () => {
  const cases: Array<[string, Partial<SessionPrompt>, boolean]> = [
    ['queued', {}, true],
    ['waiting behind the running turn', { state: 'waiting', reason: 'turn_active' }, true],
    ['waiting behind an older prompt', { state: 'waiting', reason: 'older_prompt_pending' }, true],
    ['waiting, held by Stop', { state: 'waiting', reason: 'held' }, true],
    ['failed', { state: 'failed', last_error: 'delivery outcome: failed' }, true],
    // Its turn is starting: the server refuses a DELETE with 409.
    ['delivering', { state: 'delivering' }, false],
    // No server id yet: there is nothing to DELETE.
    ['not yet confirmed by the server', { prompt_id: 'optimistic:q_9' }, false],
  ];
  for (const [name, overrides, removable] of cases) {
    test(`${name} → ${removable ? 'removable' : 'not removable'}`, () => {
      expect(promptRowRemovable(prompt(overrides))).toBe(removable);
    });
  }

  test('the Queue List row reads the same rule', () => {
    for (const [, overrides] of cases) {
      const row = prompt({ placement: 'composer', ...overrides });
      expect(projectQueueRows({ prompts: [row] }).rows[0].removable).toBe(promptRowRemovable(row));
    }
  });
});

describe('quickQueueRemove — what a waiting Quick Queue bubble offers', () => {
  const quick = (overrides: Partial<SessionPrompt> = {}) =>
    prompt({ placement: 'transcript', ...overrides });

  test('a waiting prompt offers Remove, under the row the inbox lists', () => {
    expect(quickQueueRemove({ prompt: quick() })).toEqual({ promptId: 'cmd-1' });
    for (const reason of ['turn_active', 'older_prompt_pending', 'held'] as const) {
      expect(quickQueueRemove({ prompt: quick({ state: 'waiting', reason }) })).toEqual({
        promptId: 'cmd-1',
      });
    }
  });

  test('a bubble the inbox does not list offers nothing', () => {
    // Delivered, removed elsewhere, or a Stop-interrupted message the runtime
    // already holds: there is no row left to DELETE.
    expect(quickQueueRemove({ prompt: undefined })).toBeNull();
  });

  test('a prompt the server will not remove offers nothing', () => {
    expect(quickQueueRemove({ prompt: quick({ state: 'delivering' }) })).toBeNull();
    expect(quickQueueRemove({ prompt: quick({ prompt_id: 'optimistic:q_9' }) })).toBeNull();
  });

  test('a failed prompt keeps its one Remove on the failure line', () => {
    expect(quickQueueRemove({ prompt: quick({ state: 'failed' }) })).toBeNull();
  });

  test("the session's first prompt is the turn about to run, not a queue entry", () => {
    expect(quickQueueRemove({ prompt: quick({ client_message_id: 'start_abc' }) })).toBeNull();
    expect(quickQueueRemove({ prompt: quick({ client_message_id: 'pending:ses_1' }) })).toBeNull();
    // A re-mint claim can name the first turn without the row saying so.
    expect(quickQueueRemove({ prompt: quick(), firstPrompt: true })).toBeNull();
  });

  test('an action in flight stays on the control, so it refuses a second one', () => {
    for (const pendingAction of ['remove', 'retry'] as const) {
      expect(quickQueueRemove({ prompt: quick(), pendingAction })).toEqual({
        promptId: 'cmd-1',
        pendingAction,
      });
    }
    // An action in flight never makes a row removable that was not.
    expect(
      quickQueueRemove({ prompt: quick({ state: 'delivering' }), pendingAction: 'retry' }),
    ).toBeNull();
  });
});

describe('paintedMessageIdsOf — the bubble leaves on the click, with its row', () => {
  test('every transcript id the row can be painted under, once each', () => {
    const prompts = [
      prompt({ prompt_id: 'same', message_id: 'msg_a', wire_message_id: 'msg_a' }),
      prompt({ prompt_id: 'reminted', message_id: 'msg_new', wire_message_id: 'msg_wire' }),
      prompt({ prompt_id: 'unplaced', message_id: '' }),
    ];
    expect(paintedMessageIdsOf({ prompts, pendingActions: {} }, 'same')).toEqual(['msg_a']);
    expect(paintedMessageIdsOf({ prompts, pendingActions: {} }, 'reminted')).toEqual([
      'msg_new',
      'msg_wire',
    ]);
    expect(paintedMessageIdsOf({ prompts, pendingActions: {} }, 'unplaced')).toEqual([]);
  });

  test('a row the inbox no longer lists names nothing', () => {
    expect(paintedMessageIdsOf({ prompts: [prompt()], pendingActions: {} }, 'gone')).toEqual([]);
  });

  test('a row with an action in flight names nothing: the SDK sends no DELETE for it', () => {
    // `promptInbox.remove` rejects with `prompt_action_pending` and the row
    // stays listed. Taking the bubble down would be a removal nobody made.
    expect(
      paintedMessageIdsOf({ prompts: [prompt()], pendingActions: { 'cmd-1': 'retry' } }, 'cmd-1'),
    ).toEqual([]);
  });
});
