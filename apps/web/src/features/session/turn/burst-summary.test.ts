import type { Part, ToolPart } from '@/ui';
import { describe, expect, test } from 'bun:test';
import { burstSummary, burstSummaryLabel } from './burst-summary';

function tool(id: string, name: string, input: Record<string, unknown> = {}): ToolPart {
  return {
    id,
    type: 'tool',
    tool: name,
    callID: `call_${id}`,
    state: { status: 'completed', input },
  } as unknown as ToolPart;
}

function failedTool(id: string, name: string): ToolPart {
  return {
    id,
    type: 'tool',
    tool: name,
    callID: `call_${id}`,
    state: { status: 'error', error: 'ENOENT' },
  } as unknown as ToolPart;
}

function reasoning(id: string, body: string): Part {
  return { id, type: 'reasoning', text: body } as unknown as Part;
}

/** The label for a settled burst of `parts`, which is what the row shows. */
function settledLabel(parts: ReadonlyArray<Part>): string {
  return burstSummaryLabel(burstSummary(parts), false);
}

describe('burstSummary counting', () => {
  test('every non-plumbing tool part counts one', () => {
    const summary = burstSummary([tool('1', 'read'), tool('2', 'read'), tool('3', 'read')]);
    expect(summary).toEqual({ total: 3, failed: 0, completed: 3, hasPlumbing: false });
  });

  test('a run of consecutive reasoning fragments counts one', () => {
    const summary = burstSummary([
      reasoning('r1', 'first'),
      reasoning('r2', 'second'),
      reasoning('r3', 'third'),
      reasoning('r4', 'fourth'),
      tool('1', 'read'),
      tool('2', 'read'),
    ]);
    expect(summary.total).toBe(3);
  });

  test('reasoning split by a tool is two runs, not one', () => {
    const summary = burstSummary([
      reasoning('r1', 'before'),
      tool('1', 'read'),
      tool('2', 'read'),
      reasoning('r2', 'after'),
    ]);
    // One run either side of the reads. Merging them into a single thought row
    // would report 3.
    expect(summary.total).toBe(4);
  });

  test('an empty reasoning fragment does not split a run', () => {
    const summary = burstSummary([
      reasoning('r1', 'first'),
      reasoning('r2', '   '),
      reasoning('r3', 'second'),
    ]);
    expect(summary.total).toBe(1);
  });

  test('a plumbing tool does not split a reasoning run', () => {
    const summary = burstSummary([
      reasoning('r1', 'first'),
      tool('p', 'dcp_compress'),
      reasoning('r2', 'second'),
    ]);
    expect(summary.total).toBe(1);
  });

  test('plumbing is neither counted nor blamed for a failure', () => {
    const summary = burstSummary([
      tool('1', 'read'),
      failedTool('p1', 'prune'),
      failedTool('p2', 'memory'),
    ]);
    expect(summary).toEqual({ total: 1, failed: 0, completed: 1, hasPlumbing: true });
  });

  test('three reads of ONE path still count three — the unit is calls made', () => {
    // The second sanctioned divergence from the rendered row count. The chip
    // row dedupes by path, so this burst opens to one chip while the title says
    // `Completed 3 steps`. Counting chips instead would under-report a run that
    // really did read the file three times, and would leave `failed` — which
    // cannot dedupe, two failures on one path being two failures — as the odd
    // unit out of `Completed N of M`.
    const parts = [
      tool('1', 'read', { filePath: '/workspace/main.ts' }),
      tool('2', 'read', { filePath: '/workspace/main.ts' }),
      tool('3', 'read', { filePath: '/workspace/main.ts' }),
    ];
    expect(burstSummary(parts).total).toBe(3);
    expect(settledLabel(parts)).toBe('Completed 3 steps');
  });

  test('a failed tool lands in failed and out of completed', () => {
    const parts = [
      ...Array.from({ length: 10 }, (_, i) => tool(`${i}`, 'read')),
      failedTool('x', 'read'),
    ];
    expect(burstSummary(parts)).toEqual({
      total: 11,
      failed: 1,
      completed: 10,
      hasPlumbing: false,
    });
  });
});

describe('burstSummaryLabel', () => {
  test('a settled clean burst counts its steps', () => {
    expect(settledLabel([tool('1', 'read'), tool('2', 'read'), tool('3', 'read')])).toBe(
      'Completed 3 steps',
    );
  });

  test('one step is singular', () => {
    expect(settledLabel([tool('1', 'read')])).toBe('Completed 1 step');
  });

  test('a partial failure states the clause rather than implying it', () => {
    const parts = [
      ...Array.from({ length: 10 }, (_, i) => tool(`${i}`, 'read')),
      failedTool('x', 'read'),
    ];
    expect(settledLabel(parts)).toBe('Completed 10 of 11 steps · 1 failed');
  });

  test('a burst where everything failed never says Completed', () => {
    expect(settledLabel([failedTool('1', 'read'), failedTool('2', 'bash')])).toBe('2 steps failed');
  });

  test('a single total failure is singular', () => {
    expect(settledLabel([failedTool('1', 'bash')])).toBe('1 step failed');
  });

  test('a running burst reports size, not outcome', () => {
    const parts = [tool('1', 'read'), tool('2', 'read'), tool('3', 'bash'), failedTool('4', 'read')];
    expect(burstSummaryLabel(burstSummary(parts), true)).toBe('Working · 4 steps');
  });

  test('a running burst with nothing yet is just Working', () => {
    expect(burstSummaryLabel(burstSummary([]), true)).toBe('Working');
  });

  test('a settled burst of only plumbing reads as housekeeping', () => {
    expect(settledLabel([tool('1', 'dcp_prune'), tool('2', 'memory')])).toBe('Housekeeping');
  });

  test('a settled empty burst returns a neutral label, not an empty string', () => {
    expect(settledLabel([])).toBe('Worked');
  });

  test('a lone train of thought is a step, because it is a row', () => {
    expect(settledLabel([reasoning('r1', 'one'), reasoning('r2', 'two')])).toBe('Completed 1 step');
  });
});
