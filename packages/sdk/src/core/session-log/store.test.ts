import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionLogPage } from './source';
import {
  EMPTY_SESSION_LOG_STATE,
  applySessionLogEvent,
  applySessionLogPage,
  selectSessionLog,
  selectSessionLogThread,
  sessionLogHasOlder,
  type SessionLogState,
} from './store';
import type { SessionLog, SessionLogMessage, TextBlock } from './types';

const log: SessionLog = JSON.parse(readFileSync(join(import.meta.dir, '../../../../api-contract/src/__tests__/fixtures/session-log/golden21.v2.json'), 'utf8'));
const ROOT = log.threads[0]!.thread_id;
const CHILD = log.threads[1]!.thread_id;
const rootMessages = () => structuredClone(log.threads[0]!.messages);

function page(messages: SessionLogMessage[] = rootMessages(), generation = 1): SessionLogPage {
  const { threads, ...session } = structuredClone(log);
  return { session, generation, threads: threads.map(({ messages: _m, ...head }) => head), thread_id: threads[0]!.thread_id, messages, has_more: false };
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

  test('a page of the same generation keeps the session fields the stream delivered', () => {
    let state = applySessionLogEvent(EMPTY_SESSION_LOG_STATE, ev('log.state', { generation: 3, session: { title: 'live title' } }));
    state = applySessionLogPage(state, page(rootMessages(), 3));
    expect(state.session.title).toBe('live title');
    expect(state.session.session_id).toBe(log.session_id);
    state = applySessionLogPage(state, page(rootMessages(), 4));
    expect(state.session.title).toBe(log.title);
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

  test('a newer page settles its window: a held message without a rev that it lacks was deleted, and leaves', () => {
    const all = rootMessages();
    let state = applySessionLogPage(EMPTY_SESSION_LOG_STATE, page(all));
    const gone = all[3]!;
    const live = { ...all[0]!, status: 'error' as const };
    state = applySessionLogEvent(state, ev('log.message', { rev: 9, message: live }));
    // The whole thread (has_more: false): every rev-less message the page lacks is gone.
    state = applySessionLogPage(state, page(all.filter((m) => m !== gone)));
    expect(ids(state)).not.toContain(gone.message_id);
    expect(state.messages[ROOT]![0]!.status).toBe('error');
    // A window (has_more: true) settles only from its first seq on.
    const older = all[1]!;
    const window = { ...page(all.slice(4)), has_more: true };
    state = applySessionLogPage(state, window);
    expect(ids(state)).toContain(older.message_id);
  });

  test('a stream-put message the API page lacks (API lag) survives the settle', () => {
    const all = rootMessages();
    const newest = all.at(-1)!;
    let state = applySessionLogEvent(EMPTY_SESSION_LOG_STATE, ev('log.message', { rev: 5, message: newest }));
    // The API has not stored the newest message yet: its page ends one message earlier.
    state = applySessionLogPage(state, page(all.slice(0, -1)));
    expect(ids(state)).toEqual(all.map((m) => m.message_id));
  });

  test('ignores a message that fails validation', () => {
    const messages = rootMessages();
    (messages[1] as Record<string, unknown>).seq = 'x';
    const state = applySessionLogPage(EMPTY_SESSION_LOG_STATE, page(messages));
    expect(ids(state)).toHaveLength(messages.length - 1);
  });
});

describe('sessionLogHasOlder: the oldest page read decides', () => {
  const window = (messages: SessionLogMessage[], has_more: boolean, thread = ROOT) => ({ ...page(messages), thread_id: thread, has_more });
  test('undefined before any page of the thread; the first page answers its has_more', () => {
    const all = rootMessages();
    expect(sessionLogHasOlder(EMPTY_SESSION_LOG_STATE, ROOT)).toBeUndefined();
    expect(sessionLogHasOlder(applySessionLogPage(EMPTY_SESSION_LOG_STATE, window(all.slice(4), true)), ROOT)).toBe(true);
    expect(sessionLogHasOlder(applySessionLogPage(EMPTY_SESSION_LOG_STATE, window(all, false)), ROOT)).toBe(false);
  });

  test('an older page answers for the thread; the newest page read again does not undo it', () => {
    const all = rootMessages();
    let state = applySessionLogPage(EMPTY_SESSION_LOG_STATE, window(all.slice(4), true));
    state = applySessionLogPage(state, window(all.slice(0, 4), false), all[4]!.seq);
    expect(sessionLogHasOlder(state, ROOT)).toBe(false);
    expect(ids(state)).toEqual(all.map((m) => m.message_id));
    // A reconnect reads the newest page again: it still says has_more, but the thread is whole.
    state = applySessionLogPage(state, window(all.slice(4), true));
    expect(sessionLogHasOlder(state, ROOT)).toBe(false);
    expect(ids(state)).toEqual(all.map((m) => m.message_id));
  });

  test('an older page settles only below its before_seq: a deleted older message leaves, newer ones stay', () => {
    const all = rootMessages();
    let state = applySessionLogPage(EMPTY_SESSION_LOG_STATE, window(all, false));
    const gone = all[1]!;
    state = applySessionLogPage(state, window(all.slice(0, 4).filter((m) => m !== gone), false), all[4]!.seq);
    expect(ids(state)).toEqual(all.filter((m) => m !== gone).map((m) => m.message_id));
  });

  test('per thread: a child page leaves the root answer alone', () => {
    const all = rootMessages();
    let state = applySessionLogPage(EMPTY_SESSION_LOG_STATE, window(all.slice(4), true));
    state = applySessionLogPage(state, window([], false, CHILD));
    expect(sessionLogHasOlder(state, ROOT)).toBe(true);
    expect(sessionLogHasOlder(state, CHILD)).toBe(false);
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

  test('a streaming put takes the following deltas; the higher-rev final put replaces it', () => {
    const [user, reply] = rootMessages();
    const streaming: SessionLogMessage = {
      ...reply!, status: 'streaming', completed_at: null, finish: null,
      blocks: [{ type: 'text', id: 'b0', text: '' } as TextBlock],
    };
    let state = applySessionLogEvent(EMPTY_SESSION_LOG_STATE, ev('log.message', { rev: 1, message: user }));
    state = applySessionLogEvent(state, ev('log.message', { rev: 2, message: streaming }));
    for (const delta of ['Hel', 'lo']) {
      state = applySessionLogEvent(state, ev('log.block.delta', { thread_id: ROOT, message_id: reply!.message_id, block_id: 'b0', delta }));
    }
    const live = state.messages[ROOT]!.find((m) => m.message_id === reply!.message_id)!;
    expect(live.status).toBe('streaming');
    expect((live.blocks[0] as TextBlock).text).toBe('Hello');
    state = applySessionLogEvent(state, ev('log.message', { rev: 3, message: reply }));
    expect(state.messages[ROOT]!.find((m) => m.message_id === reply!.message_id)).toEqual(reply!);
    // A late delta for a block the final record no longer has changes nothing.
    expect(applySessionLogEvent(state, ev('log.block.delta', { thread_id: ROOT, message_id: reply!.message_id, block_id: 'b_gone', delta: 'x' }))).toBe(state);
  });

  test('a delta for a message the store does not hold builds no placeholder', () => {
    const state = applySessionLogEvent(EMPTY_SESSION_LOG_STATE, ev('log.block.delta', { thread_id: ROOT, message_id: 'msg_x', block_id: 'b0', delta: 'x' }));
    expect(state).toBe(EMPTY_SESSION_LOG_STATE);
  });

  test('another event type changes nothing', () => {
    const state = loaded();
    expect(applySessionLogEvent(state, ev('message.updated', { info: {} }))).toBe(state);
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
