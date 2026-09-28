import { describe, expect, test } from 'bun:test';

import { compactMessage } from './session-transcript-compact';

const message = {
  info: { id: 'msg_1', role: 'assistant', time: { created: 1, completed: 2 } },
  parts: [
    { type: 'text', text: 'Ran it:\n```\nmcp-e2e-ok\n```' },
    { type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'echo mcp-e2e-ok' }, output: 'mcp-e2e-ok\n' } },
    { type: 'tool', tool: 'read', state: { status: 'error', input: { path: 'x' }, error: 'ENOENT' } },
  ],
};

describe('compactMessage', () => {
  test('the default is the one-line digest: no tool input or output', () => {
    const m = compactMessage(message, 700);
    expect(m.text).toBe('Ran it: ``` mcp-e2e-ok ```');
    expect(m.tools).toEqual([
      { tool: 'bash', status: 'completed' },
      { tool: 'read', status: 'error' },
    ]);
  });

  test('full keeps line breaks and carries each call\'s input and output (or error), cut to maxChars', () => {
    const m = compactMessage(message, 700, true);
    expect(m.text).toBe('Ran it:\n```\nmcp-e2e-ok\n```');
    expect(m.tools).toEqual([
      { tool: 'bash', status: 'completed', input: '{"command":"echo mcp-e2e-ok"}', output: 'mcp-e2e-ok\n' },
      { tool: 'read', status: 'error', input: '{"path":"x"}', output: 'ENOENT' },
    ]);
    expect(compactMessage(message, 10, true).tools[0]!.input).toBe('{"command…');
  });
});
