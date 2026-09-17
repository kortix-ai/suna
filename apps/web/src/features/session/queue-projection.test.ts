import type { QueuedDraft } from '@/stores/queued-draft-store';
import type { RemovedSessionPrompt, SessionPrompt } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';
import type { AttachedFile } from './composer/types';
import { cleanPromptText, composeTakeBack, projectQueueRows } from './queue-projection';

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
});

describe('cleanPromptText', () => {
  test('strips every block the send path appends', () => {
    const text =
      'look at @notes\n\nReferenced sessions (use the session_context tool to fetch details when needed):\n' +
      '<session_ref id="ses_1" title="Intro" />\n\n<file_ref path="notes.md" name="notes.md" />\n\n<agent_ref name="coder" />';
    expect(cleanPromptText(text)).toEqual({ text: 'look at @notes', fileCount: 0 });
  });
});

describe('composeTakeBack', () => {
  const removed = (
    clientMessageId: string,
    parts: RemovedSessionPrompt['parts'],
  ): RemovedSessionPrompt => ({
    prompt_id: `p-${clientMessageId}`,
    client_message_id: clientMessageId,
    message_id: `msg-${clientMessageId}`,
    parts,
    overrides: null,
  });

  test('one entry per line, in queue order, drafts exactly as typed with their files', () => {
    const result = composeTakeBack({
      removed: [
        removed('q_1', [{ type: 'text', text: 'server copy of one' }]),
        removed('q_2', [{ type: 'text', text: 'two, from another tab' }]),
      ],
      drafts: [draft('q_1', { text: 'one, as typed', files: [remoteFile] })],
    });
    expect(result).toEqual({
      text: 'one, as typed\ntwo, from another tab',
      files: [remoteFile],
      requeue: [],
    });
  });

  test('a prompt with no draft that carries files goes back to the queue, never into the composer half-empty', () => {
    const withUpload = removed('q_3', [
      {
        type: 'text',
        text: 'see file\n\n<file path="/workspace/uploads/a.png" mime="image/png" filename="a.png"></file>',
      },
    ]);
    const withFilePart = removed('q_4', [
      { type: 'text', text: 'see url' },
      { type: 'file', mime: 'image/png', url: 'https://files.test/b.png' },
    ]);
    const result = composeTakeBack({ removed: [withUpload, withFilePart], drafts: [] });
    expect(result.text).toBe('');
    expect(result.requeue).toEqual([withUpload, withFilePart]);
  });
});
