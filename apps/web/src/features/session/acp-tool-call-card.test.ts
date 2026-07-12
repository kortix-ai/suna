import { describe, expect, test } from 'bun:test';

import type { AcpToolCall } from '@kortix/sdk';
import { acpToolCallToPart } from './acp-tool-call-card';

function tool(overrides: Partial<AcpToolCall>): AcpToolCall {
  return {
    id: 'call-1',
    title: 'Tool call',
    toolKind: null,
    status: 'completed',
    content: [],
    locations: [],
    rawInput: undefined,
    rawOutput: undefined,
    data: {},
    ...overrides,
  };
}

describe('ACP rich tool projection', () => {
  const cases: Array<[string, AcpToolCall, string]> = [
    ['Claude terminal envelope', tool({ title: 'Execute command', toolKind: 'execute', rawInput: { command: 'pwd' }, rawOutput: '/workspace' }), 'bash'],
    ['Codex shell envelope', tool({ title: 'Shell', rawInput: { command: 'ls' }, content: [{ type: 'text', text: 'README.md' }] }), 'bash'],
    ['OpenCode read envelope', tool({ title: 'Read file', locations: [{ path: '/workspace/README.md' }] }), 'read'],
    ['Pi patch envelope', tool({ title: 'Apply patch', toolKind: 'diff', rawInput: { patch: '@@ -1 +1 @@' } }), 'apply_patch'],
  ];
  for (const [label, input, expected] of cases) {
    test(`${label} uses the mature renderer identity`, () => {
      const part = acpToolCallToPart(input, 'session-1');
      expect(part.tool).toBe(expected);
      expect(part.sessionID).toBe('session-1');
      expect(part.callID).toBe('call-1');
    });
  }

  test('keeps ACP input, output, locations, and errors losslessly available', () => {
    const input = { command: 'false' };
    const location = { path: '/workspace/task.ts', line: 8 };
    const part = acpToolCallToPart(tool({
      status: 'failed',
      rawInput: input,
      rawOutput: { stderr: 'failed' },
      locations: [location],
      data: { vendor: 'codex' },
    }), 'session-1');

    expect(part.state.status).toBe('error');
    expect(part.state.input).toEqual(input);
    expect(part.state.output).toContain('failed');
    expect(part.state.metadata).toMatchObject({ locations: [location], acp: { vendor: 'codex' } });
  });
});
