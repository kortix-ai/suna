import { describe, expect, test } from 'bun:test';

import type { ClassifiedPart, ClassifiedToolPart, MessageWithParts } from '@kortix/sdk';

import {
  clip,
  collapseToolRuns,
  findToolCall,
  formatArguments,
  formatRelativeTime,
  headLines,
  isRenderablePart,
  orderedMessages,
  stepsLabel,
  summarizeSteps,
  tailLines,
  toUnifiedDiff,
  toggleableKeys,
} from './turn-layout.ts';

function toolPart(id: string, status: ClassifiedToolPart['tool']['status']): ClassifiedToolPart {
  return {
    kind: 'tool',
    id,
    tool: { name: 'bash', title: 'Shell', status, input: { command: 'ls' } },
  };
}

const text = (id: string, body = 'hello'): ClassifiedPart => ({
  kind: 'text',
  id,
  text: body,
  synthetic: false,
});

const reasoning = (id: string): ClassifiedPart => ({ kind: 'reasoning', id, text: 'thinking' });

const stepMarker = (id: string): ClassifiedPart => ({ kind: 'step', id, phase: 'start' });

describe('isRenderablePart', () => {
  test('bookkeeping markers never render', () => {
    expect(isRenderablePart(stepMarker('s1'))).toBe(false);
    expect(isRenderablePart({ kind: 'snapshot', id: 's2', snapshot: 'abc' })).toBe(false);
    expect(isRenderablePart({ kind: 'agent', id: 's3', name: 'galileo' })).toBe(false);
  });

  test('a synthetic or empty text part is not content', () => {
    expect(isRenderablePart({ kind: 'text', id: 't1', text: 'hi', synthetic: true })).toBe(false);
    expect(isRenderablePart({ kind: 'text', id: 't2', text: '   ', synthetic: false })).toBe(false);
    expect(isRenderablePart(text('t3'))).toBe(true);
  });
});

describe('collapseToolRuns', () => {
  test('a run of three tool parts becomes one steps row', () => {
    const rows = collapseToolRuns([
      text('t1'),
      toolPart('p1', 'done'),
      toolPart('p2', 'done'),
      toolPart('p3', 'done'),
      text('t2'),
    ]);
    expect(rows.map((row) => row.kind)).toEqual(['part', 'steps', 'part']);
    const steps = rows[1];
    if (steps?.kind !== 'steps') throw new Error('expected a steps row');
    expect(steps.tools).toHaveLength(3);
    expect(steps.key).toBe('steps:p1');
  });

  test('a lone tool part stays its own card', () => {
    const rows = collapseToolRuns([toolPart('p1', 'done'), text('t1')]);
    expect(rows.map((row) => row.kind)).toEqual(['part', 'part']);
  });

  test('a step marker between two tool calls does not split the run', () => {
    const rows = collapseToolRuns([
      toolPart('p1', 'done'),
      stepMarker('s1'),
      toolPart('p2', 'done'),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('steps');
  });

  test('a text part between two tool calls does split the run', () => {
    const rows = collapseToolRuns([
      toolPart('p1', 'done'),
      toolPart('p2', 'done'),
      text('t1'),
      toolPart('p3', 'done'),
      toolPart('p4', 'done'),
    ]);
    expect(rows.map((row) => row.kind)).toEqual(['steps', 'part', 'steps']);
  });
});

describe('toggleableKeys', () => {
  test('steps rows and reasoning parts, in document order', () => {
    const rows = collapseToolRuns([
      reasoning('r1'),
      toolPart('p1', 'done'),
      toolPart('p2', 'done'),
      text('t1'),
    ]);
    expect(toggleableKeys(rows)).toEqual(['r1', 'steps:p1']);
  });
});

describe('summarizeSteps / stepsLabel', () => {
  test('all done', () => {
    const summary = summarizeSteps([
      toolPart('p1', 'done'),
      toolPart('p2', 'done'),
      toolPart('p3', 'done'),
    ]);
    expect(summary).toMatchObject({ total: 3, failed: 0, completed: 3, running: false });
    expect(stepsLabel(summary)).toBe('Completed 3 steps');
  });

  test('one step reads singular', () => {
    expect(stepsLabel(summarizeSteps([toolPart('p1', 'done')]))).toBe('Completed 1 step');
  });

  test('a running run names the step it is on and reports no failures', () => {
    const summary = summarizeSteps([
      toolPart('p1', 'error'),
      toolPart('p2', 'running'),
      toolPart('p3', 'pending'),
    ]);
    expect(summary.running).toBe(true);
    expect(stepsLabel(summary)).toBe('Working · step 3: Shell');
  });

  test('a partly failed run states both numbers', () => {
    const summary = summarizeSteps([
      toolPart('p1', 'done'),
      toolPart('p2', 'error'),
      toolPart('p3', 'done'),
    ]);
    expect(stepsLabel(summary)).toBe('Completed 2 of 3 steps · 1 failed');
  });

  test('a wholly failed run never claims a completion', () => {
    const summary = summarizeSteps([toolPart('p1', 'error'), toolPart('p2', 'error')]);
    expect(stepsLabel(summary)).toBe('2 steps failed');
  });
});

describe('text rules', () => {
  test('tailLines keeps the last N and counts what it dropped', () => {
    expect(tailLines('a\nb\nc\nd', 2)).toEqual({ lines: ['c', 'd'], hidden: 2 });
    expect(tailLines('a\nb', 5)).toEqual({ lines: ['a', 'b'], hidden: 0 });
  });

  test('headLines keeps the first N', () => {
    expect(headLines('a\nb\nc', 2)).toEqual({ lines: ['a', 'b'], hidden: 1 });
  });

  test('clip truncates with an ellipsis at the width', () => {
    expect(clip('abcdefghij', 5)).toBe('abcd…');
    expect(clip('abc', 5)).toBe('abc');
    expect(clip('abc', 0)).toBe('');
  });

  test('formatRelativeTime', () => {
    const now = 1_000_000_000_000;
    expect(formatRelativeTime(now - 1_000, now)).toBe('now');
    expect(formatRelativeTime(now - 42_000, now)).toBe('42s');
    expect(formatRelativeTime(now - 4 * 60_000, now)).toBe('4m');
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe('3h');
    expect(formatRelativeTime(now - 50 * 3_600_000, now)).toBe('2d');
  });
});

describe('toUnifiedDiff', () => {
  test('emits a hunk header with real counts', () => {
    const diff = toUnifiedDiff('src/app.ts', [
      { type: 'unchanged', text: 'const a = 1;' },
      { type: 'removed', text: 'const b = 2;' },
      { type: 'added', text: 'const b = 3;' },
    ]);
    expect(diff.split('\n')).toEqual([
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1,2 +1,2 @@',
      ' const a = 1;',
      '-const b = 2;',
      '+const b = 3;',
      '',
    ]);
  });
});

describe('findToolCall / formatArguments', () => {
  const messages = [
    {
      info: { id: 'm1', role: 'assistant' },
      parts: [
        {
          id: 'p1',
          type: 'tool',
          tool: 'bash',
          callID: 'c1',
          state: { status: 'pending', input: { command: 'rm -rf /workspace/tmp' } },
        },
      ],
    },
  ] as unknown as MessageWithParts[];

  test('resolves the gated call by messageID + callID', () => {
    expect(findToolCall(messages, { messageID: 'm1', callID: 'c1' })).toEqual({
      name: 'bash',
      input: { command: 'rm -rf /workspace/tmp' },
    });
  });

  test('returns null for an unknown call or no tool reference', () => {
    expect(findToolCall(messages, { messageID: 'm1', callID: 'c9' })).toBeNull();
    expect(findToolCall(messages, undefined)).toBeNull();
  });

  test('formatArguments prints every argument, never a summary', () => {
    expect(formatArguments({ command: 'ls', cwd: '/workspace' })).toEqual([
      '{',
      '  "command": "ls",',
      '  "cwd": "/workspace"',
      '}',
    ]);
    expect(formatArguments(undefined)).toEqual([]);
  });
});

describe('orderedMessages', () => {
  test('flattens turns back to user-then-assistants order', () => {
    const user = { info: { id: 'u1', role: 'user' }, parts: [] } as unknown as MessageWithParts;
    const a1 = { info: { id: 'a1', role: 'assistant' }, parts: [] } as unknown as MessageWithParts;
    const a2 = { info: { id: 'a2', role: 'assistant' }, parts: [] } as unknown as MessageWithParts;
    expect(
      orderedMessages([{ userMessage: user, assistantMessages: [a1, a2] }]).map((m) => m.info.id),
    ).toEqual(['u1', 'a1', 'a2']);
  });
});
