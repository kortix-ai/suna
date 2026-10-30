import { describe, expect, test } from 'bun:test';
import { fromV1, toV1, type SessionLog, type V1Row } from '@kortix/api-contract/session-log';
import { withKeptToolInputs } from './session-log-read';

const root = 'ses_strippedroot0000000001';
const at = 1_791_681_474_000;
const output = 'total 8\n-rw-r--r--  1 kortix  staff  42 bundle.min.js\n';

/** A turn the old v1 mirror saved before 2026-09-28: the bash call keeps only its title (the command) and metadata (the output). */
const rows = (state: Record<string, unknown>) =>
  [
    {
      runtime_session_id: root,
      info: { id: 'msg_s2', sessionID: root, role: 'assistant', time: { created: at + 1, completed: at + 2 }, finish: 'stop' },
      parts: [{ id: 'prt_s2', sessionID: root, messageID: 'msg_s2', type: 'tool', tool: 'bash', callID: 'call_s2', state }],
    },
  ] as unknown as V1Row[];

function served(state: Record<string, unknown>) {
  const { threads, ...session } = fromV1({ session_id: 'session', root_id: root, rows: rows(state) }, { harness: 'opencode' });
  const { messages, ...thread } = threads[0]!;
  const message = withKeptToolInputs(session, thread, messages[0]!);
  const v1 = toV1({ ...session, threads: [{ ...thread, messages: [message] }] } as SessionLog);
  return { message, original: messages[0]!, part: v1.rows[0]!.parts[0] as unknown as { state: Record<string, unknown> } };
}

describe('GET …/log serves a stripped tool call with what it kept', () => {
  test('the block gets the command and its output, and toV1 of it is the part the v1 window serves', () => {
    const { message, part } = served({
      status: 'completed',
      title: 'ls -la dist',
      metadata: { output, exit: 0, truncated: false },
      time: { start: at + 1, end: at + 2 },
    });
    expect(message.blocks[0]).toMatchObject({ type: 'tool_call', input: { command: 'ls -la dist' }, result: { content: [{ type: 'text', text: output }] } });
    expect(part.state).toMatchObject({ input: { command: 'ls -la dist' }, output, title: 'ls -la dist' });
  });

  test('a call with its input passes as is', () => {
    const { message, original } = served({
      status: 'completed',
      input: { command: 'ls' },
      output: 'a\n',
      title: 'ls',
      metadata: { exit: 0 },
      time: { start: at + 1, end: at + 2 },
    });
    expect(message).toBe(original);
  });
});
