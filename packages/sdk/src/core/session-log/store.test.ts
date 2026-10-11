import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionLogPage } from './source';
import {
  EMPTY_SESSION_LOG_STATE,
  applySessionLogEvent,
  applySessionLogPage,
  ownsSessionLogEvent,
  selectSessionLog,
  selectSessionLogThread,
  type SessionLogState,
} from './store';
import type { SessionLog, SessionLogMessage, TextBlock } from './types';

const log: SessionLog = JSON.parse(readFileSync(join(import.meta.dir, 'session-log.fixture.json'), 'utf8'));
const ROOT = log.threads[0]!.thread_id;
const CHILD = log.threads[1]!.thread_id;
const rootMessages = () => structuredClone(log.threads[0]!.messages);

function page(messages: SessionLogMessage[] = rootMessages(), generation = 1): SessionLogPage {
  const { threads, ...session } = structuredClone(log);
  return { session, generation, threads: threads.map(({ messages: _m, ...head }) => head), messages, has_more: false };
}
const ev = (type: string, properties: unknown) => ({ type, properties });
const loaded = (): SessionLogState => applySessionLogPage(EMPTY_SESSION_LOG_STATE, page());
const ids = (state: SessionLogState, thread = ROOT) => (state.messages[thread] ?? []).map((m) => m.message_id);

describe('applySessionLogPage', () => {
  test('holds the session, the generation, the threads and the messages ordered by seq', () => {
    const shuffled = rootMessages().reverse();
    const state = applySessionLogPage(EMPTY_SESSION_LOG_STATE, page(shuffled, 4));
    expect(state.generation).toBe(4);
    expect(state.session.session_id).toBe(log.session_id);
    expect(Object.keys(state.threads)).toEqual([ROOT, CHILD]);
    expect('messages' in state.threads[ROOT]!).toBe(false);
    expect(ids(state)).toEqual(log.threads[0]!.messages.map((m) => m.message_id));
    expect(state.messages[CHILD]).toBeUndefined();
  });

  test('a page of an older generation leaves a newer generation in place', () => {
    const state = applySessionLogPage(loaded(), page(rootMessages(), 0));
    expect(state.generation).toBe(1);
  });

  test('a page does not replace a message the stream delivered with a rev, nor revive a tombstone', () => {
    const [first, second] = rootMessages();
    const edited = { ...first!, blocks: [{ type: 'text', id: 'b0', text: 'edited live' } as TextBlock] };
    let state = applySessionLogEvent(EMPTY_SESSION_LOG_STATE, ev('log.message', { rev: 10, message: edited }));
    state = applySessionLogEvent(state, ev('log.message', { message_id: second!.message_id, rev: 11 }));
    state = applySessionLogPage(state, page());
    expect((state.messages[ROOT]![0]!.blocks[0] as TextBlock).text).toBe('edited live');
    expect(ids(state)).not.toContain(second!.message_id);
    expect(ids(state)).toHaveLength(log.threads[0]!.messages.length - 1);
  });

  test('ignores a message that fails validation', () => {
    const messages = rootMessages();
    (messages[1] as Record<string, unknown>).seq = 'x';
    const state = applySessionLogPage(EMPTY_SESSION_LOG_STATE, page(messages));
    expect(ids(state)).toHaveLength(messages.length - 1);
  });
});

describe('applySessionLogEvent', () => {
  test('log.message: a put inserts by seq and a higher rev replaces it', () => {
    const [a, b, c] = rootMessages();
    let state = EMPTY_SESSION_LOG_STATE;
    state = applySessionLogEvent(state, ev('log.message', { rev: 3, message: c }));
    state = applySessionLogEvent(state, ev('log.message', { rev: 1, message: a }));
    state = applySessionLogEvent(state, ev('log.message', { rev: 2, message: b }));
    expect(ids(state)).toEqual([a!.message_id, b!.message_id, c!.message_id]);
    const newer = { ...b!, status: 'error' as const };
    state = applySessionLogEvent(state, ev('log.message', { rev: 5, message: newer }));
    expect(state.messages[ROOT]![1]!.status).toBe('error');
    expect(state.revs[b!.message_id]).toBe(5);
  });

  test('log.message: an equal or lower rev changes nothing, and returns the same state', () => {
    const [a] = rootMessages();
    const state = applySessionLogEvent(EMPTY_SESSION_LOG_STATE, ev('log.message', { rev: 7, message: a }));
    expect(applySessionLogEvent(state, ev('log.message', { rev: 7, message: { ...a!, status: 'error' } }))).toBe(state);
    expect(applySessionLogEvent(state, ev('log.message', { rev: 6, message: { ...a!, status: 'error' } }))).toBe(state);
  });

  test('log.message: a tombstone deletes the message; a lower-rev put does not revive it', () => {
    const [a, b] = rootMessages();
    let state = applySessionLogPage(EMPTY_SESSION_LOG_STATE, page([a!, b!]));
    state = applySessionLogEvent(state, ev('log.message', { message_id: a!.message_id, rev: 20 }));
    expect(ids(state)).toEqual([b!.message_id]);
    expect(applySessionLogEvent(state, ev('log.message', { rev: 19, message: a }))).toBe(state);
    state = applySessionLogEvent(state, ev('log.message', { rev: 21, message: a }));
    expect(ids(state)).toEqual([a!.message_id, b!.message_id]);
  });

  test('log.message: an invalid record or payload changes nothing', () => {
    const state = loaded();
    const [a] = rootMessages();
    expect(applySessionLogEvent(state, ev('log.message', { rev: 99, message: { ...a!, role: 'tool' } }))).toBe(state);
    expect(applySessionLogEvent(state, ev('log.message', { rev: 'x', message: a }))).toBe(state);
    expect(applySessionLogEvent(state, ev('log.message', null))).toBe(state);
  });

  test('log.thread upserts a thread head; an invalid one changes nothing', () => {
    const { messages: _m, ...head } = structuredClone(log.threads[1]!);
    let state = applySessionLogEvent(EMPTY_SESSION_LOG_STATE, ev('log.thread', head));
    expect(state.threads[CHILD]).toEqual(head);
    state = applySessionLogEvent(state, ev('log.thread', { ...head, title: 'renamed' }));
    expect(state.threads[CHILD]!.title).toBe('renamed');
    expect(applySessionLogEvent(state, ev('log.thread', { ...head, thread_id: 5 }))).toBe(state);
  });

  test('log.state merges the session fields; an older generation changes nothing', () => {
    let state = applySessionLogPage(EMPTY_SESSION_LOG_STATE, page(rootMessages(), 2));
    state = applySessionLogEvent(state, ev('log.state', { generation: 2, session: { title: 'A new title' } }));
    expect(state.session.title).toBe('A new title');
    expect(state.session.session_id).toBe(log.session_id);
    expect(applySessionLogEvent(state, ev('log.state', { generation: 1, session: { title: 'zombie' } }))).toBe(state);
    state = applySessionLogEvent(state, ev('log.state', { generation: 3, session: { title: 'next box' } }));
    expect(state.generation).toBe(3);
    expect(state.session.title).toBe('next box');
  });

  test('log.block.delta appends to a text or reasoning block by block id, nothing else', () => {
    const state = loaded();
    const messages = state.messages[ROOT]!;
    const target = messages.find((m) => m.blocks.some((b) => b.type === 'text'))!;
    const block = target.blocks.find((b) => b.type === 'text') as TextBlock;
    const next = applySessionLogEvent(state, ev('log.block.delta', { thread_id: ROOT, message_id: target.message_id, block_id: block.id, delta: ' more' }));
    const updated = next.messages[ROOT]!.find((m) => m.message_id === target.message_id)!;
    expect((updated.blocks.find((b) => b.id === block.id) as TextBlock).text).toBe(`${block.text} more`);
    // Copy on write: the old state is untouched, and every other message keeps its identity.
    expect(block.text).not.toEndWith(' more');
    for (const m of next.messages[ROOT]!) if (m.message_id !== target.message_id) expect(messages).toContain(m);

    const reasoningMessage = messages.find((m) => m.blocks.some((b) => b.type === 'reasoning'));
    if (reasoningMessage) {
      const r = reasoningMessage.blocks.find((b) => b.type === 'reasoning')!;
      const after = applySessionLogEvent(state, ev('log.block.delta', { thread_id: ROOT, message_id: reasoningMessage.message_id, block_id: r.id, delta: '!' }));
      expect((after.messages[ROOT]!.find((m) => m.message_id === reasoningMessage.message_id)!.blocks.find((b) => b.id === r.id) as TextBlock).text).toEndWith('!');
    }
    const tool = messages.find((m) => m.blocks.some((b) => b.type === 'tool_call'))!;
    const toolBlock = tool.blocks.find((b) => b.type === 'tool_call')!;
    expect(applySessionLogEvent(state, ev('log.block.delta', { thread_id: ROOT, message_id: tool.message_id, block_id: toolBlock.id, delta: 'x' }))).toBe(state);
    expect(applySessionLogEvent(state, ev('log.block.delta', { thread_id: ROOT, message_id: 'msg_none', block_id: 'b0', delta: 'x' }))).toBe(state);
    expect(applySessionLogEvent(state, ev('log.block.delta', { thread_id: ROOT, message_id: target.message_id, block_id: 'b_none', delta: 'x' }))).toBe(state);
    expect(applySessionLogEvent(state, ev('log.block.delta', { thread_id: ROOT, message_id: target.message_id, block_id: block.id }))).toBe(state);
  });

  test('another event type changes nothing', () => {
    const state = loaded();
    expect(applySessionLogEvent(state, ev('message.updated', { info: {} }))).toBe(state);
  });
});

describe('ownsSessionLogEvent', () => {
  test('names the state that holds the event thread or message', () => {
    const state = loaded();
    const [a] = rootMessages();
    expect(ownsSessionLogEvent(state, ev('log.block.delta', { thread_id: ROOT, message_id: 'm', block_id: 'b', delta: '' }))).toBe(true);
    expect(ownsSessionLogEvent(state, ev('log.message', { rev: 1, message: a }))).toBe(true);
    expect(ownsSessionLogEvent(state, ev('log.message', { message_id: a!.message_id, rev: 1 }))).toBe(true);
    expect(ownsSessionLogEvent(state, ev('log.thread', { thread_id: 'ses_new', parent_thread_id: ROOT }))).toBe(true);
    expect(ownsSessionLogEvent(state, ev('log.state', { generation: 1, session: { session_id: log.session_id } }))).toBe(true);
    expect(ownsSessionLogEvent(state, ev('log.block.delta', { thread_id: 'ses_other', message_id: 'm', block_id: 'b', delta: '' }))).toBe(false);
    expect(ownsSessionLogEvent(state, ev('log.state', { generation: 1, session: { title: 'no id' } }))).toBe(false);
    expect(ownsSessionLogEvent(state, ev('log.thread', { thread_id: 'ses_new', parent_thread_id: null }))).toBe(false);
  });
});

describe('selectSessionLog / selectSessionLogThread', () => {
  test('null until the session record is known', () => {
    expect(selectSessionLog(EMPTY_SESSION_LOG_STATE)).toBeNull();
    expect(selectSessionLogThread(EMPTY_SESSION_LOG_STATE)).toBeNull();
  });

  test('assemble the records, memoized on the state', () => {
    const state = applySessionLogEvent(loaded(), ev('log.message', { rev: 1, message: log.threads[1]!.messages[0] }));
    const assembled = selectSessionLog(state)!;
    expect(assembled.session_id).toBe(log.session_id);
    expect(assembled.threads.map((t) => t.thread_id)).toEqual([ROOT, CHILD]);
    expect(assembled.threads[0]!.messages).toEqual(log.threads[0]!.messages);
    expect(assembled.threads[1]!.messages).toEqual([log.threads[1]!.messages[0]!]);
    expect(selectSessionLog(state)).toBe(assembled);
    expect(selectSessionLogThread(state)).toBe(assembled.threads[0]!);
    expect(selectSessionLogThread(state, CHILD)).toBe(assembled.threads[1]!);
    expect(selectSessionLogThread(state, 'ses_none')).toBeNull();
  });
});
