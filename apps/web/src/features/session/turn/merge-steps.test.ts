import type { Part } from '@/ui';
import { describe, expect, test } from 'bun:test';
import { flattenThought, mergeBurstSteps } from './merge-steps';
import type { StepTier } from './step-label';

function tool(id: string, name = 'read'): Part {
  return {
    id,
    type: 'tool',
    tool: name,
    callID: `call_${id}`,
    state: { status: 'completed' },
  } as unknown as Part;
}

function reasoning(id: string, text: string): Part {
  return { id, type: 'reasoning', text } as unknown as Part;
}

/** Anything named `memory` is machinery; everything else is real work. */
const tierOf = (part: Part): StepTier => {
  const name = (part as { tool?: string }).tool;
  if (name === 'memory' || name === 'dcp_compress') return 'plumbing';
  return part.type === 'reasoning' ? 'reasoning' : 'primary';
};

describe('mergeBurstSteps', () => {
  test('consecutive thinking collapses into ONE row', () => {
    const steps = mergeBurstSteps(
      [reasoning('r1', 'first'), reasoning('r2', 'second'), reasoning('r3', 'third')],
      tierOf,
    );

    expect(steps).toHaveLength(1);
    expect(steps[0].kind).toBe('thought');
    expect((steps[0] as { texts: string[] }).texts).toEqual(['first', 'second', 'third']);
  });

  test('a tool between two thinking runs keeps them separate', () => {
    const steps = mergeBurstSteps([reasoning('r1', 'a'), tool('t1'), reasoning('r2', 'b')], tierOf);

    expect(steps.map((s) => s.kind)).toEqual(['thought', 'part', 'thought']);
  });

  test('plumbing is dropped entirely', () => {
    const steps = mergeBurstSteps([tool('t1'), tool('m1', 'memory'), tool('t2')], tierOf);

    expect(steps).toHaveLength(2);
    expect(steps.every((s) => s.kind === 'part')).toBe(true);
  });

  test('plumbing between two thoughts does NOT split the run', () => {
    const steps = mergeBurstSteps(
      [reasoning('r1', 'a'), tool('m1', 'memory'), reasoning('r2', 'b')],
      tierOf,
    );

    expect(steps).toHaveLength(1);
    expect((steps[0] as { texts: string[] }).texts).toEqual(['a', 'b']);
  });

  test('blank thinking is ignored rather than rendering an empty row', () => {
    const steps = mergeBurstSteps([reasoning('r1', '   '), tool('t1')], tierOf);

    expect(steps).toHaveLength(1);
    expect(steps[0].kind).toBe('part');
  });

  test('a burst of only plumbing yields no rows', () => {
    expect(mergeBurstSteps([tool('m1', 'memory'), tool('m2', 'dcp_compress')], tierOf)).toEqual([]);
  });

  test('keys are stable and unique', () => {
    const steps = mergeBurstSteps([reasoning('r1', 'a'), tool('t1'), tool('t2')], tierOf);
    const keys = steps.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('flattenThought', () => {
  test('joins fragments into one sentence with a Thinking about lead-in', () => {
    expect(flattenThought(['Checking the retry path.'])).toBe(
      'Thinking about checking the retry path.',
    );
  });

  test('does not stutter when the text already announces a thought', () => {
    expect(flattenThought(['Thinking about the retry path'])).toBe('Thinking about the retry path');
    expect(flattenThought(['Analyzing the queue'])).toBe('Analyzing the queue');
  });

  test('strips markdown emphasis and headings', () => {
    expect(flattenThought(['## **Audited** the worker'])).toBe('Thinking about audited the worker');
  });

  test('collapses newlines from multiple fragments', () => {
    expect(flattenThought(['One\n\ntwo', 'three'])).toBe('Thinking about one two three');
  });

  test('does not lowercase an acronym lead', () => {
    expect(flattenThought(['API limits were hit'])).toBe('Thinking about API limits were hit');
  });

  test('empty input yields a bare label rather than a dangling prefix', () => {
    expect(flattenThought([])).toBe('Thinking');
    expect(flattenThought(['   '])).toBe('Thinking');
  });
});
