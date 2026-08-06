import type { Part, ToolPart } from '@/ui';
import { describe, expect, test } from 'bun:test';
import { burstTitle } from './burst-title';
import { type BurstStep, flattenThought, mergeBurstSteps } from './merge-steps';
import { stepLabel, type StepTier } from './step-label';

function tool(id: string, name = 'read'): Part {
  return {
    id,
    type: 'tool',
    tool: name,
    callID: `call_${id}`,
    state: { status: 'completed' },
  } as unknown as Part;
}

/** Every tool part a row accounts for, group members included. */
function coveredParts(steps: BurstStep[]): ToolPart[] {
  return steps.flatMap((step) => {
    if (step.kind === 'group') return step.step.parts;
    if (step.kind === 'part') return [step.part as ToolPart];
    return [];
  });
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
    const steps = mergeBurstSteps([tool('t1'), tool('m1', 'memory'), tool('t2', 'bash')], tierOf);

    expect(steps.map((s) => s.kind)).toEqual(['part', 'part']);
    expect(coveredParts(steps).map((p) => p.id)).toEqual(['t1', 't2']);
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
    const steps = mergeBurstSteps(
      [reasoning('r1', 'a'), tool('t1'), tool('t2'), tool('t3', 'bash')],
      tierOf,
    );
    const keys = steps.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('mergeBurstSteps — grouping', () => {
  test('consecutive same-family calls become ONE group carrying every member', () => {
    const steps = mergeBurstSteps([tool('t1'), tool('t2'), tool('t3')], tierOf);

    expect(steps).toHaveLength(1);
    expect(steps[0].kind).toBe('group');
    const group = steps[0] as Extract<BurstStep, { kind: 'group' }>;
    expect(group.step.parts.map((p) => p.id)).toEqual(['t1', 't2', 't3']);
  });

  test('a single-member run stays a plain step, not a wrapper around one child', () => {
    const steps = mergeBurstSteps([tool('t1')], tierOf);

    expect(steps).toHaveLength(1);
    expect(steps[0].kind).toBe('part');
  });

  test('a different family breaks the run', () => {
    const steps = mergeBurstSteps([tool('t1'), tool('t2', 'bash'), tool('t3')], tierOf);

    expect(steps.map((s) => s.kind)).toEqual(['part', 'part', 'part']);
    expect(coveredParts(steps).map((p) => p.id)).toEqual(['t1', 't2', 't3']);
  });

  test('show / show_user never fold into the group beside them', () => {
    const steps = mergeBurstSteps(
      [tool('t1', 'show'), tool('t2', 'show_user'), tool('t3', 'image_gen')],
      tierOf,
    );

    // All three are family `create`; only the two display tools are exempt.
    expect(steps.map((s) => s.kind)).toEqual(['part', 'part', 'part']);
    expect(coveredParts(steps).map((p) => p.id)).toEqual(['t1', 't2', 't3']);
  });

  test('reasoning keeps its position and splits the runs around it', () => {
    const steps = mergeBurstSteps(
      [tool('t1'), tool('t2'), reasoning('r1', 'a thought'), tool('t3'), tool('t4')],
      tierOf,
    );

    expect(steps.map((s) => s.kind)).toEqual(['group', 'thought', 'group']);
    expect((steps[0] as Extract<BurstStep, { kind: 'group' }>).step.parts.map((p) => p.id)).toEqual(
      ['t1', 't2'],
    );
    expect((steps[2] as Extract<BurstStep, { kind: 'group' }>).step.parts.map((p) => p.id)).toEqual(
      ['t3', 't4'],
    );
  });

  test('plumbing between two calls does NOT split the group', () => {
    const steps = mergeBurstSteps([tool('t1'), tool('m1', 'memory'), tool('t2')], tierOf);

    expect(steps).toHaveLength(1);
    expect((steps[0] as Extract<BurstStep, { kind: 'group' }>).step.parts.map((p) => p.id)).toEqual(
      ['t1', 't2'],
    );
  });

  test('a blank thinking fragment renders nothing and so must not split a group', () => {
    const steps = mergeBurstSteps([tool('t1'), reasoning('r1', '   '), tool('t2')], tierOf);

    expect(steps).toHaveLength(1);
    expect((steps[0] as Extract<BurstStep, { kind: 'group' }>).step.parts.map((p) => p.id)).toEqual(
      ['t1', 't2'],
    );
  });

  test('a part that is neither tool nor reasoning still gets its own row', () => {
    const odd = { id: 'x1', type: 'future-part' } as unknown as Part;
    const steps = mergeBurstSteps([tool('t1'), odd, tool('t2')], tierOf);

    expect(steps.map((s) => s.kind)).toEqual(['part', 'part', 'part']);
    expect(steps[1].key).toBe('x1');
  });

  test('the groups agree with the collapsed title they expand from', () => {
    // The real tier function, so this asserts the two production paths agree.
    const realTier = (p: Part) => stepLabel(p).tier;
    const parts = [
      tool('e1', 'edit'),
      tool('e2', 'edit'),
      tool('e3', 'edit'),
      tool('b1', 'bash'),
      tool('b2', 'bash'),
      tool('r1'),
      tool('r2'),
    ];

    expect(burstTitle(parts, false)).toBe('Edited 3 files, ran 2 commands, read 2 files');

    const steps = mergeBurstSteps(parts, realTier);
    expect(steps.map((s) => s.kind)).toEqual(['group', 'group', 'group']);
    expect(
      steps.map((s) => (s as Extract<BurstStep, { kind: 'group' }>).step.parts.length),
    ).toEqual([3, 2, 2]);
  });

  test('every counted part is reachable — nothing is lost to grouping', () => {
    const realTier = (p: Part) => stepLabel(p).tier;
    const parts = [
      tool('r1'),
      tool('r2'),
      tool('b1', 'bash'),
      tool('p1', 'prune'),
      tool('w1', 'write'),
      tool('s1', 'show'),
      tool('g1', 'glob'),
    ];

    const counted = parts.filter((p) => realTier(p) === 'primary').map((p) => (p as ToolPart).id);
    const rendered = coveredParts(mergeBurstSteps(parts, realTier)).map((p) => p.id);

    // `prune` is context-engine machinery: not counted in the title, not rendered.
    expect(counted).toEqual(['r1', 'r2', 'b1', 'w1', 's1', 'g1']);
    expect(rendered).toEqual(counted);
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
