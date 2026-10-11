import type { QueuedDraft } from '@/stores/queued-draft-store';
import type { SessionPrompt } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';
import type { AttachedFile } from './composer/types';
import { serializePromptWithPastes } from '@kortix/shared';
import { cleanPromptText, composerSendDelivery, projectQueueRows } from './queue-projection';

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

  // A queued prompt runs as its author. The API answers 403 not_prompt_author
  // to anyone else's edit, Stop and send or retry, so none is offered.
  test("another member's rows offer no edit, Stop and send or retry", () => {
    const prompts = [
      prompt({ prompt_id: 'theirs', author_user_id: 'user-b' }),
      prompt({ prompt_id: 'theirs-failed', state: 'failed', author_user_id: 'user-b' }),
      prompt({ prompt_id: 'mine', author_user_id: 'user-a' }),
      prompt({ prompt_id: 'mine-failed', state: 'failed', author_user_id: 'user-a' }),
    ];
    const controls = (managesSession: boolean) =>
      projectQueueRows({ prompts, viewer: { userId: 'user-a', managesSession } }).rows.map((r) => [
        r.id,
        r.takeBackEligible,
        r.interruptible,
        r.retryable,
        r.removable,
        r.fromAnotherMember ?? false,
      ]);
    expect(controls(false)).toEqual([
      ['theirs', false, false, false, false, true],
      ['theirs-failed', false, false, false, false, true],
      ['mine', true, true, false, true, false],
      ['mine-failed', false, false, true, true, false],
    ]);
    // A session manager may remove another member's row, and nothing else.
    expect(controls(true)).toEqual([
      ['theirs', false, false, false, true, true],
      ['theirs-failed', false, false, false, true, true],
      ['mine', true, true, false, true, false],
      ['mine-failed', false, false, true, true, false],
    ]);
  });

  test('without a viewer every row keeps its controls (an older API lists no author)', () => {
    const { rows } = projectQueueRows({ prompts: [prompt({ prompt_id: 'old' })] });
    expect(rows[0]).toMatchObject({ takeBackEligible: true, interruptible: true, removable: true });
    expect(rows[0]?.fromAnotherMember).toBeUndefined();
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

  test('a row with several inline quotes shows only its reply text', () => {
    const { rows } = projectQueueRows({
      prompts: [
        prompt({
          text:
            '<reply_context>quoted alpha</reply_context>\nreply to alpha\n' +
            '<reply_context>quoted bravo</reply_context>\nreply to bravo',
        }),
      ],
    });
    expect(rows[0]?.text).toBe('reply to alpha\nreply to bravo');
  });

  test("this tab's draft supplies the text as typed and its file count", () => {
    const { rows } = projectQueueRows({
      prompts: [prompt({ client_message_id: 'q_1', text: 'server preview' })],
      drafts: [draft('q_1', { text: 'as typed', files: [remoteFile, remoteFile] })],
    });
    expect(rows[0]).toMatchObject({ text: 'as typed', attachmentCount: 2, takeBackEligible: true });
  });

  test('a row with files is still editable: an edit changes its text, the files stay on the row', () => {
    const { rows } = projectQueueRows({
      prompts: [
        prompt({
          prompt_id: 'files',
          attachments: [{ filename: 'a.pdf', mime: 'application/pdf' }],
        }),
      ],
    });
    expect(rows[0]).toMatchObject({ takeBackEligible: true, editText: 'say hi' });
  });

  test('an edit swaps only the words the user sees: a quote around them survives', () => {
    const raw = '<reply_context>quoted</reply_context>\nmy reply';
    const { rows } = projectQueueRows({ prompts: [prompt({ full_text: raw, text: raw })] });
    expect(rows[0]).toMatchObject({ text: 'my reply', editText: 'my reply', rawText: raw });
  });

  test('words that are not one run of the raw text cannot be edited in place', () => {
    const raw =
      '<reply_context>a</reply_context>\nreply to a\n<reply_context>b</reply_context>\nreply to b';
    const { rows } = projectQueueRows({ prompts: [prompt({ full_text: raw, text: raw })] });
    expect(rows[0]).toMatchObject({ editText: null, takeBackEligible: false });
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
});

describe('steering rows', () => {
  test('a steer row is listed with its caption flag; a Quick Queue row is not listed', () => {
    const { rows } = projectQueueRows({
      prompts: [
        prompt({ prompt_id: 'steer', placement: 'composer', delivery: 'steer' }),
        prompt({ prompt_id: 'quick', placement: 'transcript', delivery: 'interrupt' }),
        prompt({ prompt_id: 'queue', placement: 'composer', delivery: 'queue' }),
      ],
    });
    expect(rows.map((row) => [row.id, row.steer ?? false])).toEqual([
      ['steer', true],
      ['queue', false],
    ]);
  });

  test('a steer row on the wire is unread, so it can still be removed', () => {
    const { rows } = projectQueueRows({
      prompts: [
        prompt({ prompt_id: 'steering', delivery: 'steer', state: 'delivering' }),
        prompt({ prompt_id: 'queued-turn', delivery: 'queue', state: 'delivering' }),
      ],
    });
    expect(rows.map((row) => [row.id, row.removable])).toEqual([
      ['steering', true],
      ['queued-turn', false],
    ]);
  });

  test('a fallen-back steer row carries the reason it waits', () => {
    const { rows } = projectQueueRows({
      prompts: [prompt({ delivery: 'queue', steer_fallback: 'not_prompter', reason: 'turn_active' })],
    });
    expect(rows[0].steer).toBeUndefined();
    expect(rows[0].steerFallback).toBe('not_prompter');
  });

  test('Stop and send is offered only on a waiting row the server holds', () => {
    const { rows } = projectQueueRows({
      prompts: [
        prompt({ prompt_id: 'queued' }),
        prompt({ prompt_id: 'waiting', state: 'waiting', reason: 'turn_active' }),
        prompt({ prompt_id: 'delivering', state: 'delivering' }),
        prompt({ prompt_id: 'failed', state: 'failed' }),
        prompt({ prompt_id: 'optimistic:q_9', client_message_id: 'q_9' }),
      ],
      drafts: [draft('upload', { posted: false, delivery: 'steer' })],
    });
    expect(rows.map((row) => [row.id, row.interruptible])).toEqual([
      ['queued', true],
      ['waiting', true],
      ['delivering', false],
      ['failed', false],
      ['optimistic:q_9', false],
      ['draft:upload', false],
    ]);
    // The upload window already shows that the message steers.
    expect(rows.at(-1)?.steer).toBe(true);
  });
});

describe('composerSendDelivery', () => {
  test('Enter while a turn runs steers, and waits in the composer list', () => {
    expect(composerSendDelivery('transcript', true)).toEqual({
      placement: 'composer',
      delivery: 'steer',
    });
  });

  test('Cmd/Ctrl+Enter is Queue List, busy or idle', () => {
    expect(composerSendDelivery('composer', true)).toEqual({ placement: 'composer', delivery: 'queue' });
    expect(composerSendDelivery('composer', false)).toEqual({ placement: 'composer', delivery: 'queue' });
  });

  test('Enter while idle is unchanged: a transcript send with no delivery mode', () => {
    expect(composerSendDelivery('transcript', false)).toEqual({ placement: 'transcript' });
  });
});

describe('cleanPromptText', () => {
  test('strips every block the send path appends', () => {
    const text =
      'look at @notes\n\nReferenced sessions (use the session_context tool to fetch details when needed):\n' +
      '<session_ref id="ses_1" title="Intro" />\n\n<file_ref path="notes.md" name="notes.md" />\n\n<agent_ref name="coder" />';
    expect(cleanPromptText(text)).toEqual({ text: 'look at @notes', fileCount: 0 });
  });

  test('a paste block is not the visible words; a paste-only prompt reads "Pasted text"', () => {
    const block = serializePromptWithPastes('', [{ id: 'abcd1234', text: 'pasted body' }]);
    expect(cleanPromptText(`${block}\n\nsummarize`)).toEqual({ text: 'summarize', fileCount: 0, pasteCount: 1 });
    const [row] = projectQueueRows({ prompts: [prompt({ text: block })] }).rows;
    expect(row.text).toBe('Pasted text');
    // No visible words: nothing for the composer to edit in place.
    expect(row.editText).toBeNull();
    const [typed] = projectQueueRows({
      prompts: [prompt({ text: `${block}\n\nsummarize` })],
    }).rows;
    expect(typed.text).toBe('summarize');
  });

  test('a queued prompt with a typed <pasted_content> tag stays editable, and shows the tag as typed', () => {
    const typed = 'see <pasted_content id="abcd1234" chars="3">abc</pasted_content> now';
    const [row] = projectQueueRows({ prompts: [prompt({ text: serializePromptWithPastes(typed, []) })] }).rows;
    expect(row.text).toBe(typed);
    expect(row.editText).toBe(typed);
    expect(row.takeBackEligible).toBe(true);
  });

  test('a draft row still uploading shows the typed words, not the paste XML', () => {
    const block = serializePromptWithPastes('summarize', [{ id: 'abcd1234', text: 'pasted body' }]);
    const { rows } = projectQueueRows({
      prompts: [],
      drafts: [draft('q_9', { text: block, posted: false, placement: 'composer' })],
    });
    expect(rows[0].text).toBe('summarize');
  });
});
