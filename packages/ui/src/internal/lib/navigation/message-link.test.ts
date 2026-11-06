import { describe, expect, test } from 'bun:test';
import { readMessageLinkParams, resolveMessageLinkTurn } from './message-link';

const iso = (ms: number) => new Date(ms).toISOString();

/** A turn: prompt `id` at `startMs`, one reply per `replies` entry. */
function turn(id: string, startMs: number, replies: string[] = [], partial = false) {
  return {
    id,
    partial,
    user: { message_id: id, created_at: iso(startMs) },
    assistant: replies.map((reply, i) => ({ message_id: reply, created_at: iso(startMs + 1_000 * (i + 1)) })),
  } as never;
}

const turns = [turn('msg_a', 10_000, ['msg_a1', 'msg_a2']), turn('msg_b', 20_000, ['msg_b1']), turn('msg_c', 30_000)];

describe('resolveMessageLinkTurn', () => {
  test('a reply id names the turn that holds it', () => {
    expect(resolveMessageLinkTurn(turns, { messageId: 'msg_a2', at: null })).toBe('msg_a');
  });

  test('a prompt id names its own turn', () => {
    expect(resolveMessageLinkTurn(turns, { messageId: 'msg_b', at: null })).toBe('msg_b');
  });

  test('an unknown id falls back to the last turn that began at or before `at`', () => {
    expect(resolveMessageLinkTurn(turns, { messageId: 'msg_child', at: 25_000 })).toBe('msg_b');
    expect(resolveMessageLinkTurn(turns, { messageId: null, at: 30_000 })).toBe('msg_c');
  });

  test('a time before the first loaded turn names no turn, so older pages load', () => {
    expect(resolveMessageLinkTurn(turns, { messageId: null, at: 5_000 })).toBeUndefined();
  });

  test('an unknown id with no time names no turn', () => {
    expect(resolveMessageLinkTurn(turns, { messageId: 'msg_gone', at: null })).toBeUndefined();
  });

  test('a partial turn starts at its first reply', () => {
    const partial = [turn('msg_p', 50_000, ['msg_p1'], true), turn('msg_q', 60_000)];
    expect(resolveMessageLinkTurn(partial, { messageId: null, at: 50_500 })).toBeUndefined();
    expect(resolveMessageLinkTurn(partial, { messageId: null, at: 51_000 })).toBe('msg_p');
  });
});

describe('readMessageLinkParams', () => {
  test('reads `m` and a numeric `at`', () => {
    expect(readMessageLinkParams(new URLSearchParams('m=msg_x&at=123'))).toEqual({ messageId: 'msg_x', at: 123 });
  });

  test('drops a non-numeric `at` and returns null when nothing is named', () => {
    expect(readMessageLinkParams(new URLSearchParams('m=msg_x&at=soon'))).toEqual({ messageId: 'msg_x', at: null });
    expect(readMessageLinkParams(new URLSearchParams('rs=ses_pi1'))).toBeNull();
  });
});
