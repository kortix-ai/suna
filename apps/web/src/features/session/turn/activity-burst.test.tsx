import type { Part, ToolPart } from '@/ui';
import { describe, expect, test } from 'bun:test';
import { burstIsRunning, showsDoneStep } from './activity-burst';

function tool(id: string, name: string, state: Record<string, unknown>): ToolPart {
  return {
    id,
    type: 'tool',
    tool: name,
    callID: `call_${id}`,
    state,
  } as unknown as ToolPart;
}

describe('burstIsRunning', () => {
  test('a completed burst is not running even while the turn works', () => {
    const parts: Part[] = [tool('1', 'read', { status: 'completed', time: { start: 1, end: 2 } })];
    expect(burstIsRunning(parts, true)).toBe(false);
  });

  test('a pending part while the turn works is running', () => {
    const parts: Part[] = [tool('1', 'bash', { status: 'pending' })];
    expect(burstIsRunning(parts, true)).toBe(true);
  });

  test('a running part while the turn works is running', () => {
    const parts: Part[] = [tool('1', 'bash', { status: 'running' })];
    expect(burstIsRunning(parts, true)).toBe(true);
  });

  test('nothing is running once the turn has stopped working', () => {
    const parts: Part[] = [tool('1', 'bash', { status: 'running' })];
    expect(burstIsRunning(parts, false)).toBe(false);
  });

  test('a reasoning part with no end time counts as running', () => {
    const parts: Part[] = [
      { id: 'r', type: 'reasoning', text: 'thinking', time: { start: 1 } } as unknown as Part,
    ];
    expect(burstIsRunning(parts, true)).toBe(true);
  });

  test('a reasoning part with an end time does not', () => {
    const parts: Part[] = [
      { id: 'r', type: 'reasoning', text: 'done', time: { start: 1, end: 2 } } as unknown as Part,
    ];
    expect(burstIsRunning(parts, true)).toBe(false);
  });
});

describe('showsDoneStep', () => {
  test('a settled chain with steps closes on Done', () => {
    expect(showsDoneStep(1, false)).toBe(true);
    expect(showsDoneStep(9, false)).toBe(true);
  });

  test('a running chain is never capped — the open end means work continues', () => {
    expect(showsDoneStep(3, true)).toBe(false);
  });

  test('an empty chain is never capped — Done alone terminates nothing', () => {
    // Every part was plumbing, so mergeBurstSteps returned no rows.
    expect(showsDoneStep(0, false)).toBe(false);
    expect(showsDoneStep(0, true)).toBe(false);
  });
});
