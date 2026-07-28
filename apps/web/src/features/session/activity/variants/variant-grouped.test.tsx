import { describe, expect, test } from 'bun:test';

import type { MessageWithParts, Part, ToolPart } from '@/ui';
import { groupSubtitle, stepLabel } from './variant-grouped';

let seq = 0;
function tool(name: string, input: Record<string, unknown> = {}): ToolPart {
  seq += 1;
  return {
    id: `part-${seq}`,
    type: 'tool',
    tool: name,
    callID: `call-${seq}`,
    state: { status: 'completed', input, time: { start: 0, end: 1000 } },
  } as unknown as ToolPart;
}

function entry(part: ToolPart) {
  return { part, message: { info: { id: 'msg-1', role: 'assistant' } } as unknown as MessageWithParts };
}

describe('stepLabel', () => {
  test("the model's description wins for a bash step", () => {
    expect(
      stepLabel(tool('bash', { description: 'Build slide 3 — Weblogs', command: 'python3 present.py' })),
    ).toBe('Build slide 3 — Weblogs');
  });

  test('a bash step with no description falls back to the command shape', () => {
    expect(stepLabel(tool('bash', { command: 'npm install' }))).toBe('Installed dependencies');
  });

  test('non-shell tools read as "verb · filename"', () => {
    expect(stepLabel(tool('read', { filePath: '/workspace/deck/manifest.json' }))).toBe(
      'read · manifest.json',
    );
    expect(stepLabel(tool('grep', { pattern: 'TODO' }))).toBe('grep · TODO');
  });

  test('a tool with no locatable argument falls back to just the verb', () => {
    expect(stepLabel(tool('todoread', {}))).toBe('todoread');
  });

  test('the oc- provider prefix never leaks into the label', () => {
    expect(stepLabel(tool('oc-bash', { command: 'ls' }))).toBe('Looked at files');
  });
});

describe('groupSubtitle', () => {
  test('surfaces the last step in the run so a reader knows what it just did', () => {
    const entries = [
      entry(tool('bash', { description: 'Build slide 9 — LAUNCH and the syndicate' })),
      entry(tool('bash', { description: 'Build slide 10 — influence and legacy' })),
    ];
    expect(groupSubtitle('Ran 2 commands', entries)).toBe('Build slide 10 — influence and legacy');
  });

  test('an empty run has no subtitle', () => {
    expect(groupSubtitle('Ran 0 commands', [])).toBe('');
  });

  test('suppressed when the last step would just repeat the group line', () => {
    const entries = [entry(tool('bash', { command: 'xyzzy' }))];
    expect(groupSubtitle('Ran a command', entries)).toBe('');
  });
});
