import type { Part, ToolPart } from '@/ui';
import { describe, expect, test } from 'bun:test';
import { type BurstStep, flattenThought, mergeBurstSteps } from './merge-steps';
import { stepLabel, type StepTier } from './step-label';

const SHOWN = { type: 'image', path: '/workspace/logo.png' };

function tool(id: string, name = 'read'): Part {
  return {
    id,
    type: 'tool',
    tool: name,
    callID: `call_${id}`,
    // `show` is the one tool whose input decides whether it renders at all: a
    // call carrying no path/url/content/items draws an empty card and is
    // dropped (`isEmptyShowPart`). These tests are about grouping, so every
    // show here is given a real artifact.
    state: { status: 'completed', input: name.startsWith('show') ? SHOWN : {} },
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

/** A reasoning fragment the model has finished emitting. */
function settledReasoning(id: string, text: string): Part {
  return { id, type: 'reasoning', text, time: { start: 1, end: 2 } } as unknown as Part;
}

const isRunning = (step: BurstStep) => (step as Extract<BurstStep, { kind: 'thought' }>).running;

/**
 * A memory LOOKUP and a compaction are machinery; everything else is real work.
 *
 * The stub deliberately names the two tools production also calls plumbing —
 * `memory` (the editor) is not one of them since W8, and a stub that still
 * taught otherwise would drift from the pipeline these rules run in.
 */
const tierOf = (part: Part): StepTier => {
  const name = (part as { tool?: string }).tool;
  if (name === 'get_mem' || name === 'dcp_compress') return 'plumbing';
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
    const steps = mergeBurstSteps([tool('t1'), tool('m1', 'get_mem'), tool('t2', 'bash')], tierOf);

    expect(steps.map((s) => s.kind)).toEqual(['part', 'part']);
    expect(coveredParts(steps).map((p) => p.id)).toEqual(['t1', 't2']);
  });

  test('plumbing between two thoughts does NOT split the run', () => {
    const steps = mergeBurstSteps(
      [reasoning('r1', 'a'), tool('m1', 'get_mem'), reasoning('r2', 'b')],
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
    expect(mergeBurstSteps([tool('m1', 'get_mem'), tool('m2', 'dcp_compress')], tierOf)).toEqual(
      [],
    );
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

describe('mergeBurstSteps — how long a thought took', () => {
  const durationOf = (step: BurstStep) =>
    (step as Extract<BurstStep, { kind: 'thought' }>).durationMs;

  test('one run of fragments reports first start to last end', () => {
    // The fragments of one thought are one stretch of thinking, gaps included.
    // Summing per-fragment durations would silently drop the gaps between them.
    const steps = mergeBurstSteps(
      [
        { ...reasoning('r1', 'first'), time: { start: 1_000, end: 3_000 } } as Part,
        { ...reasoning('r2', 'second'), time: { start: 5_000, end: 9_000 } } as Part,
      ],
      () => 'primary',
    );
    expect(steps).toHaveLength(1);
    expect(durationOf(steps[0])).toBe(8_000);
  });

  test('a thought still being written has no duration', () => {
    const steps = mergeBurstSteps(
      [{ ...reasoning('r1', 'first'), time: { start: 1_000 } } as Part],
      () => 'primary',
    );
    expect(durationOf(steps[0])).toBeUndefined();
  });

  test('a thought with no timing at all has no duration', () => {
    const steps = mergeBurstSteps([reasoning('r1', 'first')], () => 'primary');
    expect(durationOf(steps[0])).toBeUndefined();
  });
});

describe('mergeBurstSteps — which thought is still live', () => {
  test('a thought whose last fragment has ended is not running', () => {
    const steps = mergeBurstSteps([settledReasoning('r1', 'done thinking')], tierOf);
    expect(isRunning(steps[0])).toBe(false);
  });

  test('a thought whose last fragment has no end time is running', () => {
    const steps = mergeBurstSteps([reasoning('r1', 'still thinking')], tierOf);
    expect(isRunning(steps[0])).toBe(true);
  });

  test('the run takes its verdict from the LAST fragment, not the first', () => {
    // Fragments arrive one at a time and each closes as the next opens, so an
    // early fragment carrying an end time says nothing about the run.
    const steps = mergeBurstSteps(
      [settledReasoning('r1', 'first'), reasoning('r2', 'second')],
      tierOf,
    );
    expect(steps).toHaveLength(1);
    expect(isRunning(steps[0])).toBe(true);
  });

  test('a thought with any later step is finished, whatever its own time says', () => {
    // The structural rule, and the one that survives a provider that never
    // writes `time.end`: the model cannot call a tool and then keep thinking in
    // the same reasoning block. More reasoning after the tool is a NEW row.
    const steps = mergeBurstSteps([reasoning('r1', 'a'), tool('t1')], tierOf);
    expect(steps.map((s) => s.kind)).toEqual(['thought', 'part']);
    expect(isRunning(steps[0])).toBe(false);
  });

  test('only the final thought of several can be live', () => {
    const steps = mergeBurstSteps(
      [
        reasoning('r1', 'a'),
        tool('t1'),
        reasoning('r2', 'b'),
        tool('t2', 'bash'),
        reasoning('r3', 'c'),
      ],
      tierOf,
    );
    expect(steps.filter((s) => s.kind === 'thought').map(isRunning)).toEqual([false, false, true]);
  });

  test('dropped plumbing after a thought does not settle it', () => {
    // Plumbing renders no row, so it is not evidence the model stopped
    // thinking — and it must not be treated as a later step.
    const steps = mergeBurstSteps([reasoning('r1', 'a'), tool('m1', 'get_mem')], tierOf);
    expect(steps).toHaveLength(1);
    expect(isRunning(steps[0])).toBe(true);
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
    const steps = mergeBurstSteps([tool('t1'), tool('m1', 'get_mem'), tool('t2')], tierOf);

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

  test('each family in the run becomes exactly one group row', () => {
    // The real tier function, so this asserts the production path, not the
    // test's own tier stub.
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

/**
 * W8, on the REAL tier function — the split only means anything if the shipped
 * `stepLabel` makes it, so none of these use the stub above.
 */
describe('mergeBurstSteps — memory: updates are visible, lookups are not', () => {
  const realTier = (p: Part) => stepLabel(p).tier;

  test('a memory EDITOR call gets its own row', () => {
    const steps = mergeBurstSteps([tool('m1', 'memory')], realTier);

    expect(steps.map((s) => s.kind)).toEqual(['part']);
    expect(coveredParts(steps).map((p) => p.id)).toEqual(['m1']);
  });

  test('memory LOOKUPS render nothing at all', () => {
    // `get_mem` and `memory_search` are the agent consulting itself; the row
    // they would draw is one the reader cannot act on.
    const steps = mergeBurstSteps([tool('l1', 'get_mem'), tool('l2', 'memory_search')], realTier);

    expect(steps).toEqual([]);
  });

  test('a lookup between two memory writes neither shows nor splits the group', () => {
    const steps = mergeBurstSteps(
      [tool('m1', 'memory'), tool('l1', 'get_mem'), tool('m2', 'memory')],
      realTier,
    );

    expect(steps).toHaveLength(1);
    expect((steps[0] as Extract<BurstStep, { kind: 'group' }>).step.parts.map((p) => p.id)).toEqual(
      ['m1', 'm2'],
    );
  });

  test('a burst of only memory writes is real work, not housekeeping', () => {
    // The regression this guards: with `memory` in PLUMBING_TOOLS a turn that
    // did nothing but record what it learned rendered zero rows.
    const steps = mergeBurstSteps([tool('m1', 'memory'), tool('l1', 'memory_search')], realTier);

    expect(coveredParts(steps).map((p) => p.id)).toEqual(['m1']);
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
