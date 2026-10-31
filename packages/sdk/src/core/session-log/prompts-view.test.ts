import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionPrompt, SessionSentPrompt } from '../rest/projects-client/sessions';
import { sessionLogMessageDelivery, sessionLogThreadWithPrompts } from './prompts-view';
import type { SessionLog } from './types';

const golden: SessionLog = JSON.parse(readFileSync(join(import.meta.dir, '../../../../api-contract/src/__tests__/fixtures/session-log/golden21.v2.json'), 'utf8'));
const thread = golden.threads[0]!;
const lastSeq = thread.messages.at(-1)!.seq;

const prompt = (over: Partial<SessionPrompt> & { prompt_id: string; message_id: string }): SessionPrompt => ({
  client_message_id: over.prompt_id,
  wire_message_id: over.message_id,
  state: 'queued',
  reason: null,
  text: 'queued words',
  full_text: 'queued words',
  attempts: 0,
  last_error: null,
  attachments: [],
  created_at: '2030-01-01T00:00:05.000Z',
  available_at: '2030-01-01T00:00:05.000Z',
  ...over,
});
const sent = (over: Partial<SessionSentPrompt> & { message_id: string }): SessionSentPrompt => ({
  prompt_id: null,
  text: 'first words',
  attachments: [],
  author_user_id: null,
  created_at: '2030-01-01T00:00:01.000Z',
  ...over,
});

describe('sessionLogThreadWithPrompts: the prompts the log does not hold yet, as provisional user messages', () => {
  test('nothing to add: the thread itself', () => {
    expect(sessionLogThreadWithPrompts('ses', thread, [], [])).toBe(thread);
  });

  test('no thread yet (a booting session): its initial prompt is the first message of a new root thread', () => {
    const out = sessionLogThreadWithPrompts('ses', null, [], [sent({ message_id: 'msg_initial', attachments: [{ filename: 'plan.pdf', mime: 'application/pdf' }] })])!;
    expect(out.parent_thread_id).toBeNull();
    expect(out.messages).toHaveLength(1);
    const [message] = out.messages;
    expect(message!.message_id).toBe('msg_initial');
    expect(message!.role).toBe('user');
    expect(message!.blocks.map((b) => b.type)).toEqual(['text', 'attachment']);
    expect(message!.blocks[0]).toMatchObject({ type: 'text', text: 'first words' });
    expect(message!.blocks[1]).toMatchObject({ type: 'attachment', name: 'plan.pdf', mime: 'application/pdf' });
    expect(sessionLogMessageDelivery(message!)).toEqual({ delivery: 'sent', prompt_id: null });
  });

  test('sent prompts, then the inbox in its order, after the log; a failed row stays out', () => {
    const out = sessionLogThreadWithPrompts(
      'ses',
      thread,
      [
        prompt({ prompt_id: 'p2', message_id: 'msg_q2', state: 'waiting' }),
        prompt({ prompt_id: 'p3', message_id: 'msg_q3', state: 'delivering' }),
        prompt({ prompt_id: 'p4', message_id: 'msg_q4', state: 'failed' }),
      ],
      [sent({ message_id: 'msg_s1', prompt_id: 'p1' })],
    )!;
    const added = out.messages.slice(thread.messages.length);
    expect(added.map((m) => [m.message_id, m.seq, sessionLogMessageDelivery(m)?.delivery])).toEqual([
      ['msg_s1', lastSeq + 1, 'sent'],
      ['msg_q2', lastSeq + 2, 'queued'],
      ['msg_q3', lastSeq + 3, 'delivering'],
    ]);
    expect(out.messages.slice(0, thread.messages.length)).toEqual(thread.messages);
  });

  test('the log holding the id (or a tombstone, or the id the row was sent under) retires it: by id only, never by text', () => {
    const held = thread.messages.find((m) => m.role === 'user')!;
    const out = sessionLogThreadWithPrompts(
      'ses',
      thread,
      [
        prompt({ prompt_id: 'p1', message_id: 'msg_reminted', wire_message_id: held.message_id }),
        prompt({ prompt_id: 'p2', message_id: 'msg_same_text', text: 'x', full_text: (held.blocks[0] as { text: string }).text }),
      ],
      [sent({ message_id: 'msg_gone' })],
      { msg_gone: 5 },
    )!;
    expect(out.messages.slice(thread.messages.length).map((m) => m.message_id)).toEqual(['msg_same_text']);
  });

  test('one id listed in both sent and the inbox shows once, as sent', () => {
    const out = sessionLogThreadWithPrompts('ses', thread, [prompt({ prompt_id: 'p1', message_id: 'msg_x', state: 'delivering' })], [sent({ message_id: 'msg_x', prompt_id: 'p1' })])!;
    const added = out.messages.slice(thread.messages.length);
    expect(added.map((m) => [m.message_id, sessionLogMessageDelivery(m)?.delivery])).toEqual([['msg_x', 'sent']]);
  });

  test('a message from the log carries no delivery mark', () => {
    expect(sessionLogMessageDelivery(thread.messages[0]!)).toBeNull();
  });
});
