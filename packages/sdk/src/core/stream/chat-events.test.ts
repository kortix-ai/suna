import { describe, expect, test } from 'bun:test';

import type { Message, Part, Todo } from '../runtime/client';
import { type KortixChatEvent, heartbeatGapEvent, narrowChatEvent } from './chat-events';
import type { RuntimeEvent } from './event-stream';

function ev(type: string, properties: unknown): RuntimeEvent {
  return { id: 'e1', type, properties } as unknown as RuntimeEvent;
}

describe('narrowChatEvent', () => {
  test('message.updated reshapes into {sessionID, message}', () => {
    const message = { id: 'm1', role: 'assistant' } as unknown as Message;
    const result = narrowChatEvent(ev('message.updated', { sessionID: 's1', info: message }));
    expect(result).toEqual({ type: 'message.updated', sessionID: 's1', message });
  });

  test('message.part.updated reshapes into {sessionID, part}', () => {
    const part = { id: 'p1', type: 'text', text: 'hi' } as unknown as Part;
    const result = narrowChatEvent(ev('message.part.updated', { sessionID: 's1', part, time: 1 }));
    expect(result).toEqual({ type: 'message.part.updated', sessionID: 's1', part });
  });

  test('session.status passes the status union through', () => {
    const result = narrowChatEvent(
      ev('session.status', { sessionID: 's1', status: { type: 'busy' } }),
    );
    expect(result).toEqual({ type: 'session.status', sessionID: 's1', status: { type: 'busy' } });
  });

  test('session.idle', () => {
    expect(narrowChatEvent(ev('session.idle', { sessionID: 's1' }))).toEqual({
      type: 'session.idle',
      sessionID: 's1',
    });
  });

  test('session.error carries the raw structured error through untouched', () => {
    const error = { name: 'ProviderAuthError', data: { providerID: 'x', message: 'bad auth' } };
    const result = narrowChatEvent(ev('session.error', { sessionID: 's1', error }));
    expect(result).toEqual({ type: 'session.error', sessionID: 's1', error });
  });

  test('question.asked reshapes id -> requestID', () => {
    const questions = [{ question: 'Which?', header: 'Which', options: [] }];
    const result = narrowChatEvent(
      ev('question.asked', {
        id: 'q1',
        sessionID: 's1',
        questions,
        tool: { messageID: 'm1', callID: 'c1' },
      }),
    );
    expect(result).toEqual({
      type: 'question.asked',
      sessionID: 's1',
      requestID: 'q1',
      questions,
      tool: { messageID: 'm1', callID: 'c1' },
    });
  });

  test('question.replied and question.rejected both merge into question.answered with distinct outcomes', () => {
    const replied = narrowChatEvent(
      ev('question.replied', { sessionID: 's1', requestID: 'q1', answers: [['a']] }),
    );
    expect(replied).toEqual({
      type: 'question.answered',
      sessionID: 's1',
      requestID: 'q1',
      outcome: 'replied',
      answers: [['a']],
    });

    const rejected = narrowChatEvent(ev('question.rejected', { sessionID: 's1', requestID: 'q1' }));
    expect(rejected).toEqual({
      type: 'question.answered',
      sessionID: 's1',
      requestID: 'q1',
      outcome: 'rejected',
    });
  });

  test('permission.asked reshapes id -> requestID', () => {
    const result = narrowChatEvent(
      ev('permission.asked', {
        id: 'perm1',
        sessionID: 's1',
        permission: 'bash',
        patterns: ['*'],
        metadata: {},
        always: [],
      }),
    );
    expect(result).toEqual({
      type: 'permission.asked',
      sessionID: 's1',
      requestID: 'perm1',
      permission: 'bash',
      patterns: ['*'],
      tool: undefined,
    });
  });

  test('permission.replied', () => {
    const result = narrowChatEvent(
      ev('permission.replied', { sessionID: 's1', requestID: 'perm1', reply: 'once' }),
    );
    expect(result).toEqual({
      type: 'permission.replied',
      sessionID: 's1',
      requestID: 'perm1',
      reply: 'once',
    });
  });

  test('todo.updated', () => {
    const todos = [
      { content: 'ship it', status: 'pending', priority: 'high' },
    ] as unknown as Todo[];
    expect(narrowChatEvent(ev('todo.updated', { sessionID: 's1', todos }))).toEqual({
      type: 'todo.updated',
      sessionID: 's1',
      todos,
    });
  });

  test('server.connected becomes a generic connection event', () => {
    expect(narrowChatEvent(ev('server.connected', {}))).toEqual({
      type: 'connection',
      status: 'connected',
    });
  });

  test('events outside the curated set return null (e.g. lsp.updated, pty.created, project.updated)', () => {
    expect(narrowChatEvent(ev('lsp.updated', {}))).toBeNull();
    expect(narrowChatEvent(ev('pty.created', {}))).toBeNull();
    expect(narrowChatEvent(ev('project.updated', {}))).toBeNull();
    expect(narrowChatEvent(ev('installation.updated', { version: '1.0' }))).toBeNull();
    expect(narrowChatEvent(ev('mcp.tools.changed', { server: 'x' }))).toBeNull();
  });
});

describe('heartbeatGapEvent', () => {
  test('builds a synthetic heartbeat-gap chat event', () => {
    const event: KortixChatEvent = heartbeatGapEvent(7000);
    expect(event).toEqual({ type: 'heartbeat-gap', gapMs: 7000 });
  });
});
