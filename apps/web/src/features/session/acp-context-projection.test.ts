import { describe, expect, test } from 'bun:test';
import { projectAcpContextMessages } from './acp-context-projection';

describe('projectAcpContextMessages', () => {
  test('feeds ACP messages and thoughts into the shared context inspector without tools', () => {
    const messages = projectAcpContextMessages([
      { kind: 'message', id: 'u1', role: 'user', text: 'hello' },
      { kind: 'tool', id: 't1', title: 'Shell', toolKind: 'execute', status: 'completed', content: [], locations: [], rawInput: null, rawOutput: null, data: {} },
      { kind: 'message', id: 'r1', role: 'thought', text: 'thinking' },
      { kind: 'message', id: 'a1', role: 'assistant', text: 'done' },
    ], 'session-1', 123);

    expect(messages).toHaveLength(3);
    expect(messages.map((message) => message.info.role)).toEqual(['user', 'assistant', 'assistant']);
    expect(messages.map((message) => message.parts[0]?.type)).toEqual(['text', 'reasoning', 'text']);
    expect(messages.every((message) => message.info.time.created === 123)).toBe(true);
  });
});
