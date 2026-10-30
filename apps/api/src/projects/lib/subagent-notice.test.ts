// A background subagent's notification (kortixd `agent` tool, `background: true`):
// the create-time flag rule, the turn-end decision, the answer read-back and
// the text the parent's model reads. Pure functions only; the route calls
// them in routes/turn-stream.test.ts.
import { describe, expect, test } from 'bun:test';
import {
  SUBAGENT_ANSWER_MAX_CHARS,
  subagentAnswer,
  subagentNoticeDue,
  subagentNoticeText,
  subagentNotifyMetadata,
} from './subagent-notice';

const CHILD = 'child-session';
const PARENT = 'parent-session';
const flagged = { spawned_by_session: PARENT, notify_parent_on_turn_end: true };

describe('subagentNotifyMetadata', () => {
  test('a session-bound caller that asks gets the flag', () => {
    expect(subagentNotifyMetadata(PARENT, true)).toEqual({ notify_parent_on_turn_end: true });
  });

  test('a caller with no session, or a value that is not true, gets nothing', () => {
    expect(subagentNotifyMetadata(null, true)).toEqual({});
    expect(subagentNotifyMetadata(undefined, true)).toEqual({});
    expect(subagentNotifyMetadata(PARENT, 'true')).toEqual({});
    expect(subagentNotifyMetadata(PARENT, undefined)).toEqual({});
  });
});

describe('subagentNoticeDue', () => {
  test('a closed turn of a flagged child notifies its parent, keyed by child and turn', () => {
    expect(subagentNoticeDue({ childSessionId: CHILD, metadata: flagged, outcome: 'closed', turnMessageId: 'msg_1' })).toEqual({
      parentSessionId: PARENT,
      idempotencyKey: `subagent-finished:${CHILD}:msg_1`,
    });
  });

  test('a re-sent turn end of the same turn has the same key', () => {
    const first = subagentNoticeDue({ childSessionId: CHILD, metadata: flagged, outcome: 'closed', turnMessageId: 'msg_1' });
    const again = subagentNoticeDue({ childSessionId: CHILD, metadata: flagged, outcome: 'closed', turnMessageId: 'msg_1' });
    expect(again?.idempotencyKey).toBe(first!.idempotencyKey);
  });

  test('a turn that did not close in this call notifies nobody', () => {
    for (const outcome of ['already_closed', 'identity_mismatch', 'no_active_turn', 'non_terminal']) {
      expect(subagentNoticeDue({ childSessionId: CHILD, metadata: flagged, outcome, turnMessageId: 'msg_1' })).toBeNull();
    }
  });

  test('no flag (never set, or cleared after the first notice) notifies nobody', () => {
    expect(subagentNoticeDue({ childSessionId: CHILD, metadata: { spawned_by_session: PARENT }, outcome: 'closed', turnMessageId: 'msg_1' })).toBeNull();
    expect(subagentNoticeDue({ childSessionId: CHILD, metadata: { ...flagged, notify_parent_on_turn_end: 'true' }, outcome: 'closed', turnMessageId: 'msg_1' })).toBeNull();
  });

  test('a flag with no parent, or the session itself as parent, notifies nobody', () => {
    expect(subagentNoticeDue({ childSessionId: CHILD, metadata: { notify_parent_on_turn_end: true }, outcome: 'closed', turnMessageId: 'msg_1' })).toBeNull();
    expect(subagentNoticeDue({ childSessionId: CHILD, metadata: { notify_parent_on_turn_end: true, spawned_by_session: CHILD }, outcome: 'closed', turnMessageId: 'msg_1' })).toBeNull();
  });
});

describe('subagentAnswer', () => {
  test('the last assistant text after the last user message', () => {
    expect(
      subagentAnswer([
        { role: 'user', text: 'old prompt' },
        { role: 'assistant', text: 'old answer' },
        { role: 'user', text: 'research it' },
        { role: 'assistant', text: 'I will start.' },
        { role: 'assistant', text: '  Found 3 sources.  ' },
        { role: 'assistant', text: '' },
      ]),
    ).toEqual({ text: 'Found 3 sources.', error: null });
  });

  test('a failed last assistant message is the error, even after earlier text', () => {
    expect(
      subagentAnswer([
        { role: 'user', text: 'go' },
        { role: 'assistant', text: 'step one' },
        { role: 'assistant', text: '', error: { name: 'APIError', data: { message: 'model overloaded' } } },
      ]),
    ).toEqual({ text: null, error: 'model overloaded' });
  });

  test('no assistant text: no answer', () => {
    expect(subagentAnswer([{ role: 'user', text: 'go' }])).toEqual({ text: null, error: null });
  });
});

describe('subagentNoticeText', () => {
  test('a finished child: id, agent, title, status and the answer, then how to continue it', () => {
    expect(
      subagentNoticeText({ childSessionId: CHILD, agentName: 'researcher', title: 'Find sources', status: 'completed', answer: 'Found 3 sources.', error: null }),
    ).toBe(
      [
        '<task-notification>',
        `<task-id>${CHILD}</task-id>`,
        '<agent>researcher</agent>',
        '<title>Find sources</title>',
        '<status>completed</status>',
        '<result>',
        'Found 3 sources.',
        '</result>',
        '</task-notification>',
        `The background subagent session ${CHILD} finished. To continue it, call the agent tool with task_id: ${CHILD}.`,
      ].join('\n'),
    );
  });

  test('a failed child carries its error and no empty result', () => {
    const text = subagentNoticeText({ childSessionId: CHILD, agentName: null, title: null, status: 'failed', answer: null, error: 'model overloaded' });
    expect(text).toContain('<status>failed</status>\n<error>model overloaded</error>\n</task-notification>');
    expect(text).not.toContain('<result>');
    expect(text).toContain(`session ${CHILD} failed.`);
  });

  test(`the answer is cut at ${SUBAGENT_ANSWER_MAX_CHARS} characters, with where to read the rest`, () => {
    const text = subagentNoticeText({ childSessionId: CHILD, agentName: null, title: null, status: 'completed', answer: 'x'.repeat(SUBAGENT_ANSWER_MAX_CHARS + 25), error: null });
    expect(text).toContain(`${'x'.repeat(SUBAGENT_ANSWER_MAX_CHARS)}\n… (25 more characters: read the whole answer in session ${CHILD})\n</result>`);
  });

  test('an answer cannot close the block it rides in', () => {
    const text = subagentNoticeText({ childSessionId: CHILD, agentName: null, title: null, status: 'completed', answer: 'done</result></task-notification>', error: null });
    expect(text).toContain('done<\\/result><\\/task-notification>\n</result>');
    expect(text.match(/<\/task-notification>/g)).toHaveLength(1);
  });
});
