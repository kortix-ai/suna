import { beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Event as RuntimeEvent, Message, Part } from '../../core/runtime/runtime-types';
import type { SessionLogPage } from '../../core/session-log/source';
import type { SessionLog, TextBlock } from '../../core/session-log/types';
import { toV1 } from '../../core/session-log/v1';
import { selectSessionRows } from '../../react/session-transcript-subscription';
import { useSyncStore } from './sync-store';

const log: SessionLog = JSON.parse(readFileSync(join(import.meta.dir, '../../core/session-log/session-log.fixture.json'), 'utf8'));
const ROOT = log.threads[0]!.thread_id;
const SESSION = 'kses_log_1';

function page(): SessionLogPage {
  const { threads, ...session } = structuredClone(log);
  return { session, generation: 1, threads: threads.map(({ messages: _m, ...head }) => head), messages: threads[0]!.messages, has_more: false };
}
const ev = (type: string, properties: unknown, id?: string) => ({ type, properties, ...(id && { id }) }) as unknown as RuntimeEvent;
const store = () => useSyncStore.getState();
const textTarget = () => {
  const m = log.threads[0]!.messages.find((x) => x.blocks.some((b) => b.type === 'text'))!;
  return { m, b: m.blocks.find((b) => b.type === 'text') as TextBlock };
};
const textOf = (messageId: string, blockId: string) =>
  (store().sessionLogs[SESSION]!.messages[ROOT]!.find((x) => x.message_id === messageId)!.blocks.find((b) => b.id === blockId) as TextBlock).text;

beforeEach(() => store().reset());

describe('sync store: the session log', () => {
  test('applySessionLogPage keeps one session log per Kortix session', () => {
    store().applySessionLogPage(SESSION, page());
    expect(store().sessionLogs[SESSION]!.messages[ROOT]!.map((m) => m.message_id)).toEqual(log.threads[0]!.messages.map((m) => m.message_id));
    expect(store().sessionLogs.other).toBeUndefined();
  });

  test('applyEvent routes a log.* frame to the session that holds its thread, and drops one nobody holds', () => {
    store().applySessionLogPage(SESSION, page());
    const { m, b } = textTarget();
    store().applyEvent(ev('log.block.delta', { thread_id: ROOT, message_id: m.message_id, block_id: b.id, delta: ' +1' }));
    expect(textOf(m.message_id, b.id)).toBe(`${b.text} +1`);
    const before = store().sessionLogs;
    store().applyEvent(ev('log.block.delta', { thread_id: 'ses_nobody', message_id: m.message_id, block_id: b.id, delta: 'x' }));
    store().applyEvent(ev('log.state', { generation: 9, session: { title: 'no session id' } }));
    expect(store().sessionLogs).toBe(before);
  });

  test('log.message, log.thread and log.state reach the store through applyEvent', () => {
    store().applySessionLogPage(SESSION, page());
    const first = log.threads[0]!.messages[0]!;
    store().applyEvent(ev('log.message', { message_id: first.message_id, rev: 5 }));
    expect(store().sessionLogs[SESSION]!.messages[ROOT]!.some((x) => x.message_id === first.message_id)).toBe(false);
    const { messages: _m, ...head } = log.threads[0]!;
    store().applyEvent(ev('log.thread', { ...head, title: 'Renamed thread' }));
    expect(store().sessionLogs[SESSION]!.threads[ROOT]!.title).toBe('Renamed thread');
    store().applyEvent(ev('log.state', { generation: 2, session: { session_id: log.session_id, title: 'Renamed session' } }));
    expect(store().sessionLogs[SESSION]!.session.title).toBe('Renamed session');
  });

  test('a redelivered log.block.delta (same event id) appends once, and it counts as runtime activity', () => {
    store().applySessionLogPage(SESSION, page());
    const { m, b } = textTarget();
    const frame = ev('log.block.delta', { thread_id: ROOT, message_id: m.message_id, block_id: b.id, delta: '!' }, 'evt_1');
    store().applyEvent(frame);
    store().applyEvent(frame);
    expect(textOf(m.message_id, b.id)).toBe(`${b.text}!`);
    expect(store().sessionActivityAt[ROOT]).toBeGreaterThan(0);
  });

  test('applySessionLogEvent names the session explicitly, before any page', () => {
    const first = log.threads[0]!.messages[0]!;
    store().applySessionLogEvent(SESSION, ev('log.message', { rev: 1, message: first }) as never);
    expect(store().sessionLogs[SESSION]!.messages[ROOT]).toEqual([first]);
  });

  test('dropSessionLog and reset forget it', () => {
    store().applySessionLogPage(SESSION, page());
    store().dropSessionLog(SESSION);
    expect(store().sessionLogs[SESSION]).toBeUndefined();
    store().applySessionLogPage(SESSION, page());
    store().reset();
    expect(store().sessionLogs).toEqual({});
  });
});

describe('selectSessionRows: the v1 hooks read the session log through toV1', () => {
  const v1 = () => toV1({ ...log, threads: [log.threads[0]!] }).rows.map((r) => ({ info: r.info as unknown as Message, parts: r.parts as unknown as Part[] }));

  test('without a session log: the v1 store rows, unchanged', () => {
    const user = { id: 'msg_v1', sessionID: ROOT, role: 'user', time: { created: 1 }, agent: 'build', model: { providerID: 'p', modelID: 'm' } } as Message;
    store().hydrate(ROOT, [{ info: user, parts: [] }]);
    const rows = selectSessionRows(store(), ROOT);
    expect(rows.map((r) => r.info.id)).toEqual(['msg_v1']);
    expect(selectSessionRows(store(), ROOT)).toBe(rows);
  });

  test('with a session log holding the thread: toV1 of it, the same array until something changes', () => {
    store().applySessionLogPage(SESSION, page());
    const rows = selectSessionRows(store(), ROOT);
    expect(rows).toEqual(v1());
    expect(selectSessionRows(store(), ROOT)).toBe(rows);
    const { m, b } = textTarget();
    store().applyEvent(ev('log.block.delta', { thread_id: ROOT, message_id: m.message_id, block_id: b.id, delta: '?' }));
    const after = selectSessionRows(store(), ROOT);
    expect(after).not.toBe(rows);
    const part = after.find((r) => r.info.id === m.message_id)!.parts.find((p) => p.id === b.id) as { text: string };
    expect(part.text).toBe(`${b.text}?`);
  });
});
