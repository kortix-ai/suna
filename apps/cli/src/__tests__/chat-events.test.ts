import { describe, expect, test } from 'bun:test';

import { heartbeatGapEvent, narrowChatEvent, type ChatEvent } from '../chat/events.ts';

describe('narrowChatEvent', () => {
  test('narrows every variant a chat surface acts on', () => {
    const cases: Array<[Record<string, unknown>, ChatEvent['type']]> = [
      [{ type: 'message.updated', properties: { sessionID: 's', info: { id: 'm', role: 'assistant' } } }, 'message.updated'],
      [{ type: 'message.removed', properties: { sessionID: 's', messageID: 'm' } }, 'message.removed'],
      [{ type: 'message.part.updated', properties: { sessionID: 's', part: { type: 'text', text: 'hi' } } }, 'message.part.updated'],
      [{ type: 'message.part.removed', properties: { sessionID: 's', messageID: 'm', partID: 'p' } }, 'message.part.removed'],
      [{ type: 'session.status', properties: { sessionID: 's', status: { type: 'busy' } } }, 'session.status'],
      [{ type: 'session.idle', properties: { sessionID: 's' } }, 'session.idle'],
      [{ type: 'session.error', properties: { sessionID: 's', error: { message: 'boom' } } }, 'session.error'],
      [{ type: 'question.asked', properties: { sessionID: 's', id: 'q', questions: [] } }, 'question.asked'],
      [{ type: 'question.replied', properties: { sessionID: 's', requestID: 'q' } }, 'question.answered'],
      [{ type: 'question.rejected', properties: { sessionID: 's', requestID: 'q' } }, 'question.answered'],
      [{ type: 'permission.asked', properties: { sessionID: 's', id: 'r', permission: 'bash', patterns: [] } }, 'permission.asked'],
      [{ type: 'permission.replied', properties: { sessionID: 's', requestID: 'r', reply: 'once' } }, 'permission.replied'],
      [{ type: 'todo.updated', properties: { sessionID: 's', todos: [] } }, 'todo.updated'],
      [{ type: 'server.connected', properties: {} }, 'connection'],
    ];

    for (const [raw, expected] of cases) {
      expect(narrowChatEvent(raw as never)?.type).toBe(expected);
    }
  });

  test('question.replied and question.rejected merge into one variant with the outcome', () => {
    const replied = narrowChatEvent({
      type: 'question.replied',
      properties: { sessionID: 's', requestID: 'q' },
    } as never);
    const rejected = narrowChatEvent({
      type: 'question.rejected',
      properties: { sessionID: 's', requestID: 'q' },
    } as never);

    expect(replied).toMatchObject({ outcome: 'replied', requestID: 'q' });
    expect(rejected).toMatchObject({ outcome: 'rejected', requestID: 'q' });
  });

  test('everything outside the curated set narrows to null — a filter, not a switch', () => {
    for (const type of ['lsp.updated', 'pty.data', 'installation.updated', 'worktree.changed']) {
      expect(narrowChatEvent({ type, properties: {} })).toBeNull();
    }
  });

  test('a part event with no usable part is dropped rather than half-narrowed', () => {
    expect(narrowChatEvent({ type: 'message.part.updated', properties: {} })).toBeNull();
  });

  test('missing properties never throw — an unknown server build cannot crash the client', () => {
    expect(narrowChatEvent({ type: 'session.idle' })?.type).toBe('session.idle');
  });

  test('the synthetic gap event carries the gap size', () => {
    expect(heartbeatGapEvent(7_000)).toEqual({ type: 'heartbeat-gap', gapMs: 7_000 });
  });
});
